/**
 * E6 test: LTP-style syscall test suite.
 * Boots the engine, runs /test_syscalls, captures PASS/FAIL results.
 * Every failure is a shim bug.
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
      '/': join(BROWSER_DIR, 'e6-syscalls.html'),
      '/engine.wasm': join(BROWSER_DIR, 'engine.wasm'),
      '/atua-computer.js': join(BROWSER_DIR, 'atua-computer.js'),
      '/filesystem.js': join(BROWSER_DIR, 'filesystem.js'),
      '/engine-worker.js': join(BROWSER_DIR, 'engine-worker.js'),
      '/engine-main-worker.js': join(BROWSER_DIR, 'engine-main-worker.js'),
      '/kernel-worker.js': join(BROWSER_DIR, 'kernel-worker.js'),
      '/execution-worker.js': join(BROWSER_DIR, 'execution-worker.js'),
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

test('Syscall test suite runs and reports results', async ({ page }) => {
  test.setTimeout(120000);

  page.on('console', msg => {
    if (msg.type() === 'error') console.log('BROWSER ERROR:', msg.text());
  });

  await page.goto(serverUrl);

  // Wait for test completion
  try {
    await page.waitForFunction(() => {
      const text = document.getElementById('output')?.textContent || '';
      return text.includes('Results:') || text.includes('[Tests complete]') || text.includes('ERROR:');
    }, { timeout: 90000 });
  } catch (e) {
    // timeout
  }

  const pageText = await page.textContent('#output').catch(() => '(failed to read)');
  console.log('Syscall test output:\n' + pageText);

  // Parse results
  const passCount = (pageText.match(/PASS:/g) || []).length;
  const failCount = (pageText.match(/FAIL:/g) || []).length;
  console.log(`Results: ${passCount} passed, ${failCount} failed`);

  // The test suite should produce output
  expect(pageText).toContain('atua-computer syscall tests');

  // Report individual failures
  const failLines = pageText.split('\n').filter(l => l.includes('FAIL:'));
  if (failLines.length > 0) {
    console.log('Failed tests:');
    failLines.forEach(l => console.log('  ' + l.trim()));
  }

  // At least some tests should pass
  expect(passCount).toBeGreaterThan(0);
});
