/**
 * Dev server for atua-computer browser tests.
 * Serves with COOP/COEP headers required for SharedArrayBuffer.
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
  '.tar': 'application/x-tar',
};

const FILE_MAP = {
  '/': path.join(__dirname, 'index.html'),
  '/engine.wasm': path.join(__dirname, 'engine.wasm'),
  '/atua-computer.js': path.join(__dirname, 'atua-computer.js'),
  '/filesystem.js': path.join(__dirname, 'filesystem.js'),
  '/hello.elf': path.join(ROOT, 'test/fixtures/hello.elf'),
  '/debian-mini.tar': path.join(ROOT, 'test/fixtures/debian-mini.tar'),
  '/e2-debian.html': path.join(__dirname, 'e2-debian.html'),
  '/engine-worker.js': path.join(__dirname, 'engine-worker.js'),
  '/engine-main-worker.js': path.join(__dirname, 'engine-main-worker.js'),
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
});
