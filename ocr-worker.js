/* One isolated OCR process, using the bundled English model with no CDN fetch. */
"use strict";
const path = require('node:path');
const { createWorker } = require('tesseract.js');
let worker;
process.on('disconnect', () => process.exit(0));
process.on('message', async ({ id, imageData }) => {
  try {
    worker ||= await createWorker('eng', 1, {
      langPath: path.join(__dirname, 'vendor/lang'), cacheMethod: 'none',
      errorHandler: () => {}, logger: () => {},
    });
    const result = await worker.recognize(imageData);
    process.send?.({ id, text: String(result.data.text || '').trim() });
  } catch {
    process.send?.({ id, error: 'The server could not read this image. Try a PNG or JPEG copy.' });
    await worker?.terminate().catch(() => {});
    worker = null;
  }
});
