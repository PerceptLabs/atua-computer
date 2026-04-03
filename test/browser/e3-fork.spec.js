/**
 * E3 test: Fork child runs in Web Worker.
 *
 * Uses Debian bash to run a subshell: (echo fork-child-works)
 * The subshell forks a child process. The child runs in a Web Worker
 * and its output reaches the parent via postMessage.
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
  '.wasm': 'application/wasm', '.tar': 'application/x-tar',
  '.mjs': 'application/javascript',
};

let server, serverUrl;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const map = {
      '/': join(BROWSER_DIR, 'e3-fork.html'),
      '/engine.wasm': join(BROWSER_DIR, 'engine.wasm'),
      '/atua-computer.js': join(BROWSER_DIR, 'atua-computer.js'),
      '/filesystem.js': join(BROWSER_DIR, 'filesystem.js'),
      '/engine-worker.js': join(BROWSER_DIR, 'engine-worker.js'),
      '/engine-main-worker.js': join(BROWSER_DIR, 'engine-main-worker.js'),
      '/kernel-worker.js': join(BROWSER_DIR, 'kernel-worker.js'),
      '/execution-worker.js': join(BROWSER_DIR, 'execution-worker.js'),
      '/debian-mini.tar': join(ROOT, 'test/fixtures/debian-mini.tar'),
    };
    const filePath = map[req.url] || (req.url.startsWith('/node_modules/') ? join(ROOT, req.url) : join(BROWSER_DIR, req.url));
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

test('Fork child produces output via Worker', async ({ page }) => {
  const consoleMessages = [];
  page.on('console', msg => consoleMessages.push(`[${msg.type()}] ${msg.text()}`));

  await page.goto(serverUrl);

  // Wait for either fork output or engine exit or error
  try {
    await page.waitForFunction(() => {
      const text = document.getElementById('output')?.textContent || '';
      return text.includes('fork-child-works') || text.includes('ERROR:') || text.includes('exited');
    }, { timeout: 30000 });
  } catch (e) {
    // timeout OK — check what we have
  }

  const pageText = await page.textContent('#output');
  console.log('Console:', consoleMessages.slice(0, 20).join('\n'));
  console.log('Page:', pageText?.substring(0, 500));

  expect(pageText).toContain('fork-child-works');
});
