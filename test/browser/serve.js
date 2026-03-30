/**
 * Local server for atua-computer browser tests.
 * Serves with COOP/COEP headers required for SharedArrayBuffer.
 *
 * Usage: node test/browser/serve.js
 * Then open: http://localhost:8080
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.wasm': 'application/wasm',
  '.elf': 'application/octet-stream',
  '.css': 'text/css',
  '.json': 'application/json',
};

const FILE_MAP = {
  '/': path.join(ROOT, 'src/browser/index.html'),
  '/engine.wasm': path.join(ROOT, 'src/browser/engine.wasm'),
  '/hello.elf': path.join(ROOT, 'test/fixtures/hello.elf'),
};

const server = http.createServer((req, res) => {
  // Required for SharedArrayBuffer
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');

  const filePath = FILE_MAP[req.url] || path.join(__dirname, req.url);
  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'application/octet-stream';

  res.setHeader('Content-Type', contentType);

  fs.createReadStream(filePath)
    .on('error', () => {
      res.writeHead(404);
      res.end(`Not found: ${req.url}`);
    })
    .pipe(res);
});

const PORT = 8080;
server.listen(PORT, () => {
  console.log(`atua-computer browser test server`);
  console.log(`http://localhost:${PORT}`);
  console.log(`COOP/COEP headers enabled for SharedArrayBuffer`);
  console.log(`Serving engine.wasm from: ${FILE_MAP['/engine.wasm']}`);
  console.log(`Serving hello.elf from: ${FILE_MAP['/hello.elf']}`);
});
