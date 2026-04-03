/**
 * E1 test: hello.elf runs in browser via engine.wasm with atua imports.
 *
 * Launches headless Chrome with COOP/COEP server,
 * loads the page, waits for "hello from atua-computer" output.
 *
 * Usage: npx playwright test test/browser/e1-hello.spec.js
 */

import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, createReadStream, existsSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '../..');
const BROWSER_DIR = resolve(ROOT, 'src/browser');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.wasm': 'application/wasm',
  '.elf': 'application/octet-stream',
  '.mjs': 'application/javascript',
};

const FILE_MAP = {
  '/': join(BROWSER_DIR, 'index.html'),
  '/engine.wasm': join(BROWSER_DIR, 'engine.wasm'),
  '/atua-computer.js': join(BROWSER_DIR, 'atua-computer.js'),
  '/filesystem.js': join(BROWSER_DIR, 'filesystem.js'),
  '/hello.elf': join(ROOT, 'test/fixtures/hello.elf'),
  '/engine-worker.js': join(BROWSER_DIR, 'engine-worker.js'),
  '/engine-main-worker.js': join(BROWSER_DIR, 'engine-main-worker.js'),
  '/kernel-worker.js': join(BROWSER_DIR, 'kernel-worker.js'),
  '/execution-worker.js': join(BROWSER_DIR, 'execution-worker.js'),
};

let server;
let serverUrl;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const filePath = FILE_MAP[req.url] || (req.url.startsWith('/node_modules/') ? join(ROOT, req.url) : join(BROWSER_DIR, req.url));
    const ext = extname(filePath);
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    createReadStream(filePath)
      .on('error', () => { res.writeHead(404); res.end('Not found'); })
      .pipe(res);
  });
  await new Promise(resolve => server.listen(0, () => resolve()));
  serverUrl = `http://localhost:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) server.close();
});

test('engine.wasm exists and has correct size', () => {
  const wasmPath = join(BROWSER_DIR, 'engine.wasm');
  expect(existsSync(wasmPath)).toBe(true);
  const stat = readFileSync(wasmPath);
  expect(stat.length).toBeGreaterThan(100_000); // should be ~400KB
});

test('engine.wasm imports only from atua namespace', () => {
  const data = readFileSync(join(BROWSER_DIR, 'engine.wasm'));
  let i = 8;
  const modules = new Set();

  while (i < data.length) {
    const sectionId = data[i++];
    let size = 0, shift = 0;
    while (true) {
      const byte = data[i++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    if (sectionId === 2) {
      let pos = i, count = 0;
      shift = 0;
      while (true) {
        const byte = data[pos++];
        count |= (byte & 0x7f) << shift;
        shift += 7;
        if (!(byte & 0x80)) break;
      }
      for (let j = 0; j < count; j++) {
        const modLen = data[pos++];
        const mod = data.slice(pos, pos + modLen).toString('utf8');
        pos += modLen;
        const fieldLen = data[pos++];
        pos += fieldLen;
        const kind = data[pos++];
        if (kind === 0) { while (data[pos] & 0x80) pos++; pos++; }
        else if (kind === 1) pos += 3;
        else if (kind === 2) {
          const flags = data[pos++];
          while (data[pos] & 0x80) pos++; pos++;
          if (flags & 1) { while (data[pos] & 0x80) pos++; pos++; }
        }
        else if (kind === 3) pos += 2;
        modules.add(mod);
      }
      break;
    }
    i += size;
  }

  expect(modules.has('atua')).toBe(true);
  expect(modules.has('wasi_snapshot_preview1')).toBe(false);
  expect(modules.has('wasi_32v1')).toBe(false);
});

test('hello.elf produces output in browser', async ({ page }) => {
  const consoleMessages = [];
  const pageErrors = [];
  page.on('console', msg => consoleMessages.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', err => pageErrors.push(err.message));

  await page.goto(serverUrl);
  // Give it a moment to load and run
  await page.waitForTimeout(3000);

  // Wait for the engine to finish (look for "Engine exited" or "hello from atua-computer")
  await page.waitForFunction(() => {
    const text = document.getElementById('output')?.textContent || '';
    return text.includes('hello from atua-computer') || text.includes('Engine exited') || text.includes('ERROR:');
  }, { timeout: 30000 });

  const pageText = await page.textContent('#output');

  console.log('Browser console messages:');
  for (const msg of consoleMessages) console.log('  ', msg);
  if (pageErrors.length) {
    console.log('Page errors:');
    for (const err of pageErrors) console.log('  ', err);
  }
  console.log('Page output:', pageText?.substring(0, 500));

  expect(pageText).toContain('hello from atua-computer');
});
