/* Isolated browser QA only; never served by the production entry point. */
const path = require('node:path');
process.env.NOOK_DATA_DIR = path.join(__dirname, '../test-results/ui-server');
process.env.NOOK_AGENT_DIR = path.join(__dirname, '../test-results/ui-agent');
const server = require('../server').createServer();
const handler = server.listeners('request')[0];
server.removeAllListeners('request');
server.on('request', (req, res) => {
  if (req.method === 'GET' && req.url === '/share-test') {
    res.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store'});
    res.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Isolated share test</title><h1>Share target test</h1><form action="/share-target" method="post" enctype="multipart/form-data"><label>Title <input name="title"></label><label>Text <textarea name="text"></textarea></label><label>URL <input name="url"></label><label>Images <input name="images" type="file" multiple accept="image/*"></label><button>Share to Nook</button></form><p><a href="/">Open Nook</a></p></html>');
  } else handler(req, res);
});
server.listen(4188, '127.0.0.1', () => console.log('Share QA at http://127.0.0.1:4188/'));
