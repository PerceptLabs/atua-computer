/**
 * E2 test: Debian 13 Trixie bash boots in browser.
 *
 * Loads engine.wasm + debian-mini.tar rootfs.
 * Runs /bin/bash -c "echo debian-browser-works".
 * Asserts output appears.
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
  '.html': 'text/html', '.js': 'application/javascript',
  '.wasm': 'application/wasm', '.elf': 'application/octet-stream',
  '.tar': 'application/x-tar',
  '.mjs': 'application/javascript',
};

let server, serverUrl;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const fileMap = {
      '/': join(BROWSER_DIR, 'e2-debian.html'),
      '/engine.wasm': join(BROWSER_DIR, 'engine.wasm'),
      '/atua-computer.js': join(BROWSER_DIR, 'atua-computer.js'),
      '/filesystem.js': join(BROWSER_DIR, 'filesystem.js'),
      '/debian-mini.tar': join(ROOT, 'test/fixtures/debian-mini.tar'),
      '/engine-worker.js': join(BROWSER_DIR, 'engine-worker.js'),
      '/engine-main-worker.js': join(BROWSER_DIR, 'engine-main-worker.js'),
      '/kernel-worker.js': join(BROWSER_DIR, 'kernel-worker.js'),
      '/execution-worker.js': join(BROWSER_DIR, 'execution-worker.js'),
    };
    const filePath = fileMap[req.url] || (req.url.startsWith('/node_modules/') ? join(ROOT, req.url) : join(BROWSER_DIR, req.url));
    const ext = extname(filePath);
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    createReadStream(filePath)
      .on('error', () => { res.writeHead(404); res.end('Not found: ' + req.url); })
      .pipe(res);
  });
  await new Promise(r => server.listen(0, () => r()));
  serverUrl = `http://localhost:${server.address().port}`;
});

test.afterAll(() => { if (server) server.close(); });

test('debian-mini.tar exists', () => {
  expect(existsSync(join(ROOT, 'test/fixtures/debian-mini.tar'))).toBe(true);
});

test('Debian bash produces output in browser', async ({ page }) => {
  const consoleMessages = [];
  page.on('console', msg => consoleMessages.push(`[${msg.type()}] ${msg.text()}`));

  await page.goto(serverUrl);

  await page.waitForFunction(() => {
    const text = document.getElementById('output')?.textContent || '';
    return text.includes('debian-browser-works') || text.includes('ERROR:') || text.includes('failed to load');
  }, { timeout: 60000 });

  const pageText = await page.textContent('#output');
  console.log('Console:', consoleMessages.slice(0, 20).join('\n'));
  console.log('Page:', pageText?.substring(0, 500));

  expect(pageText).toContain('debian-browser-works');
});
