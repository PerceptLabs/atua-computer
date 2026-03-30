/**
 * E5 test: Interactive Debian shell in browser.
 * Pre-loads stdin, boots bash, checks output.
 */

import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '../..');
const BROWSER_DIR = resolve(ROOT, 'src/browser');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.wasm': 'application/wasm', '.tar': 'application/x-tar',
};

let server, serverUrl;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const map = {
      '/': join(BROWSER_DIR, 'e5-interactive.html'),
      '/engine.wasm': join(BROWSER_DIR, 'engine.wasm'),
      '/atua-computer.js': join(BROWSER_DIR, 'atua-computer.js'),
      '/filesystem.js': join(BROWSER_DIR, 'filesystem.js'),
      '/engine-worker.js': join(BROWSER_DIR, 'engine-worker.js'),
      '/engine-main-worker.js': join(BROWSER_DIR, 'engine-main-worker.js'),
      '/debian-mini.tar': join(ROOT, 'test/fixtures/debian-mini.tar'),
    };
    const filePath = map[req.url] || join(BROWSER_DIR, req.url);
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

test('Interactive shell: type command, see output', async ({ page }) => {
  test.setTimeout(90000);

  page.on('console', msg => console.log('BROWSER:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
  page.on('crash', () => console.log('PAGE CRASHED'));

  await page.goto(serverUrl);

  // Wait for output containing our test string or shell exit
  try {
    await page.waitForFunction(() => {
      const text = document.getElementById('output')?.textContent || '';
      return text.includes('interactive-test') || text.includes('[Shell exited]') || text.includes('[Error');
    }, { timeout: 60000 });
  } catch (e) {
    // timeout
  }

  const pageText = await page.textContent('#output').catch(() => '(failed)');
  console.log('Output:', pageText?.substring(0, 500));
  expect(pageText).toContain('interactive-test');
});
