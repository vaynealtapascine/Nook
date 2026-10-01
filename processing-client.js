(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./capture-tools') : root.NookCapture);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NookProcessing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Capture) {
  'use strict';
  function create(options) {
    async function process(piece, settings) {
      if (settings.location !== 'device' && options.online() !== false) {
        options.onMode?.('server');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), options.timeoutMs || 120_000);
        try {
          const response = await options.fetch('/api/process', {
            method: 'POST', credentials: 'same-origin', signal: controller.signal,
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({transcribe: !!settings.transcribe, tag: !!settings.tag, piece: {
              title: piece.title, workTitle: piece.workTitle, quote: piece.quote, ocrText: piece.ocrText,
              ...(settings.transcribe ? {imageData: piece.imageData} : {}),
            }}),
          });
          const data = await response.json();
          if (!response.ok) {
            const error = new Error(data.error || 'Server processing failed.'); error.status = response.status; throw error;
          }
          if (typeof data.ocrText !== 'string' || !Array.isArray(data.tags) || data.tags.some(tag => typeof tag !== 'string')) throw new Error('The server response could not be read.');
          return {...data, source: 'server'};
        } catch (error) {
          // Offline and unpaired devices retain the same complete capture flow.
          // Invalid content must be shown for review instead of being retried as OCR.
          if (error.status && ![401, 403, 404, 429, 500, 502, 503, 504].includes(error.status)) throw error;
        } finally { clearTimeout(timer); }
      }
      options.onMode?.('device');
      let ocrText = piece.ocrText || '';
      if (settings.transcribe) {
        const worker = await options.getWorker();
        ocrText = String((await worker.recognize(piece.imageData)).data.text || '').trim();
      }
      return {ocrText, tags: settings.tag ? Capture.suggestTags({...piece, ocrText}) : [], source:'device'};
    }
    return { process };
  }
  return { create };
});
