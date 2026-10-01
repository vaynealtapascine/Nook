"use strict";
const path = require('node:path'), crypto = require('node:crypto'), { fork } = require('node:child_process');
const Capture = require('./capture-tools');
const MAX_IMAGE = 20 * 1024 * 1024, MAX_BODY = 30 * 1024 * 1024;
const problem = (message, status = 400) => Object.assign(new Error(message), { status });

function createRecognizer(options = {}) {
  let child = null, active = null, idleTimer;
  const stop = () => {
    clearTimeout(idleTimer);
    const previous = child; child = null;
    previous?.kill();
    active?.reject(problem('Server processing was interrupted. Try again.', 503)); active = null;
  };
  function recognize(imageData) {
    clearTimeout(idleTimer);
    if (!child) {
      child = fork(path.join(__dirname, 'ocr-worker.js'), [], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const current = child;
      current.on('message', message => {
        if (current !== child || message.id !== active?.id) return;
        const job = active; active = null;
        if (message.error) job.reject(problem(message.error, 422)); else job.resolve(message.text);
        idleTimer = setTimeout(stop, options.idleMs || 60_000); idleTimer.unref();
      });
      const fail = () => { if (current === child) stop(); };
      current.on('error', fail); current.on('exit', fail);
    }
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        const job = active; active = null;
        job?.reject(problem('The server took too long to read this image.', 503)); stop();
      }, options.timeoutMs || 90_000);
      active = { id, resolve: text => { clearTimeout(timer); resolve(text); }, reject: error => { clearTimeout(timer); reject(error); } };
      child.send({ id, imageData }, error => { if (error) stop(); });
    });
  }
  return { recognize, close: stop };
}

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.transcribe !== 'boolean' || typeof input.tag !== 'boolean') throw problem('Choose transcription or tagging.');
  if (!input.transcribe && !input.tag) throw problem('Choose transcription or tagging.');
  const piece = {};
  for (const name of ['title', 'workTitle', 'quote', 'ocrText']) {
    const value = input.piece?.[name] ?? '';
    if (typeof value !== 'string' || value.length > 1024 * 1024) throw problem('The captured text is too long.');
    piece[name] = value;
  }
  let imageData = '';
  if (input.transcribe) {
    imageData = input.piece?.imageData;
    if (typeof imageData !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/]+={0,2}$/i.test(imageData)) throw problem('Send an embedded PNG, JPEG, WebP or GIF image.');
    const raw = imageData.split(',')[1];
    const bytes = Buffer.from(raw, 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE) throw problem('Use images up to 20 MB for server transcription.', 413);
    if (bytes.toString('base64') !== raw) throw problem('The image encoding is invalid.');
  }
  return { piece, imageData, transcribe: input.transcribe, tag: input.tag };
}

function createProcessor(options = {}) {
  const recognizer = options.recognizer || createRecognizer(options);
  let chain = Promise.resolve(), jobs = 0, closed = false;
  const pending = new Map(), cache = new Map();
  async function readImage(imageData) {
    const key = crypto.createHash('sha256').update(imageData).digest('hex');
    if (cache.has(key)) {
      const text = cache.get(key); cache.delete(key); cache.set(key, text); return text;
    }
    if (pending.has(key)) return pending.get(key);
    if (jobs >= (options.maxJobs || 8)) throw problem('The Nook server is busy reading other images.', 503);
    jobs++;
    const task = chain.catch(() => {}).then(() => {
      if (closed) throw problem('Server processing was interrupted.', 503);
      return recognizer.recognize(imageData);
    }).then(text => {
      if (typeof text !== 'string' || text.length > 1024 * 1024) throw problem('The server returned too much text.', 422);
      cache.set(key, text);
      while (cache.size > 32) cache.delete(cache.keys().next().value);
      return text;
    }).finally(() => { jobs--; pending.delete(key); });
    pending.set(key, task); chain = task;
    return task;
  }
  async function process(input) {
    if (closed) throw problem('Server processing is unavailable.', 503);
    const request = validate(input);
    const ocrText = request.transcribe ? await readImage(request.imageData) : request.piece.ocrText;
    return { ocrText, tags: request.tag ? Capture.suggestTags({ ...request.piece, ocrText }) : [], source: 'server' };
  }
  return { process, close: () => { closed = true; cache.clear(); recognizer.close(); } };
}

async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw problem('This capture is too large. Use an image up to 20 MB.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw problem('Send valid JSON.'); }
}
module.exports = { createProcessor, createRecognizer, readJson, validate };
