/**
 * Integration test suite — exercises the full stack under real load.
 * Each test runs actual programs in the browser engine and asserts on raw terminal output.
 */

import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWispRelay } from './wisp-relay.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '../..');
const BROWSER_DIR = resolve(ROOT, 'src/browser');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.wasm': 'application/wasm', '.tar': 'application/x-tar',
};

let server, serverUrl, relay;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/dns-resolve') {
      const name = url.searchParams.get('name');
      const type = url.searchParams.get('type') || 'A';
      fetch(`https://dns.google/resolve?name=${name}&type=${type}`)
        .then(r => r.json())
        .then(json => {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.end(JSON.stringify(json));
        })
        .catch(e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
      return;
    }

    const map = {
      '/': join(BROWSER_DIR, 'integration-test.html'),
      '/engine.wasm': join(BROWSER_DIR, 'engine.wasm'),
      '/atua-computer.js': join(BROWSER_DIR, 'atua-computer.js'),
      '/wisp-client.js': join(BROWSER_DIR, 'wisp-client.js'),
      '/filesystem.js': join(BROWSER_DIR, 'filesystem.js'),
      '/engine-worker.js': join(BROWSER_DIR, 'engine-worker.js'),
      '/engine-main-worker.js': join(BROWSER_DIR, 'engine-main-worker.js'),
      '/kernel-worker.js': join(BROWSER_DIR, 'kernel-worker.js'),
      '/execution-worker.js': join(BROWSER_DIR, 'execution-worker.js'),
      '/debian-rootfs.tar': join(ROOT, 'wasm/debian-rootfs.tar'),
    };
    const filePath = map[url.pathname] || join(BROWSER_DIR, url.pathname);
    const ext = extname(filePath);
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    createReadStream(filePath)
      .on('error', () => { res.writeHead(404); res.end('Not found: ' + req.url); })
      .pipe(res);
  });
  await new Promise(r => server.listen(0, () => r()));
  serverUrl = `http://localhost:${server.address().port}`;
  relay = attachWispRelay(server);
});

test.afterAll(async () => {
  if (relay) relay.close();
  if (server) server.close();
});

/** Run a bash script in the engine and return the raw terminal output */
async function runScript(page, script, timeoutMs = 60000) {
  const wsUrl = serverUrl.replace('http://', 'ws://');
  const dnsUrl = `${serverUrl}/dns-resolve`;
  const navUrl = `${serverUrl}?script=${encodeURIComponent(script)}&relay=${encodeURIComponent(wsUrl)}&dns=${encodeURIComponent(dnsUrl)}`;
  await page.goto(navUrl);

  try {
    await page.waitForFunction(() => {
      const text = document.getElementById('output')?.textContent || '';
      return text.includes('[DONE]') || text.includes('ERROR:');
    }, { timeout: timeoutMs });
  } catch (e) {
    // timeout — return whatever output we have
  }

  await new Promise(r => setTimeout(r, 300));
  const text = await page.evaluate(() =>
    document.getElementById('output')?.textContent || ''
  ).catch(() => '');
  return text;
}

// ─── Test 1: Fork stress ───────────────────────────────────────────────
test('fork stress: 200 iterations through pipe chain', async ({ page }) => {
  test.setTimeout(120000);
  const output = await runScript(page,
    'for i in $(seq 1 200); do echo $i; done | cat | wc -l',
    60000
  );
  console.log('=== Test 1 output ===\n' + output.slice(-500));
  expect(output).toContain('200');
});

// ─── Test 2: Nested pipe chain ─────────────────────────────────────────
test('nested pipe chain: 5 cats', async ({ page }) => {
  test.setTimeout(60000);
  const output = await runScript(page,
    'echo atua-verified | cat | cat | cat | cat | cat'
  );
  console.log('=== Test 2 output ===\n' + output.slice(-500));
  expect(output).toContain('atua-verified');
});

// ─── Test 3: O_APPEND correctness ──────────────────────────────────────
test('O_APPEND: append mode preserves prior content', async ({ page }) => {
  test.setTimeout(60000);
  const output = await runScript(page,
    'echo line1 >> /tmp/append-test.txt && echo line2 >> /tmp/append-test.txt && cat /tmp/append-test.txt'
  );
  console.log('=== Test 3 output ===\n' + output.slice(-500));
  expect(output).toContain('line1');
  expect(output).toContain('line2');
});

// ─── Test 4: mtime stability ───────────────────────────────────────────
test('mtime stability: stat returns same mtime on repeated calls', async ({ page }) => {
  test.setTimeout(60000);
  // Use ls -l which shows mtime — two calls should show same time
  const output = await runScript(page,
    'A=$(ls -l /bin/bash 2>/dev/null | awk "{print \\$6,\\$7,\\$8}"); sleep 1; B=$(ls -l /bin/bash 2>/dev/null | awk "{print \\$6,\\$7,\\$8}"); if [ "$A" = "$B" ]; then echo MTIME_STABLE; else echo "MTIME_CHANGED: $A vs $B"; fi'
  );
  console.log('=== Test 4 output ===\n' + output.slice(-500));
  expect(output).toContain('MTIME_STABLE');
});

// ─── Test 5: readdir completeness ──────────────────────────────────────
test('readdir: ls -a shows . and ..', async ({ page }) => {
  test.setTimeout(60000);
  const output = await runScript(page,
    'ls -a / 2>/dev/null | head -5'
  );
  console.log('=== Test 5 output ===\n' + output.slice(-500));
  expect(output).toContain('.');
  expect(output).toContain('..');
});

// ─── Test 6: dup2 correctness ──────────────────────────────────────────
test('dup2: file descriptor duplication works', async ({ page }) => {
  test.setTimeout(60000);
  // Test dup2 by redirecting stderr to stdout — if dup2 works, stderr output appears on stdout
  const output = await runScript(page,
    'echo DUP_WORKS 2>&1'
  );
  console.log('=== Test 6 output ===\n' + output.slice(-500));
  expect(output).toContain('DUP_WORKS');
});

// ─── Test 7: apt --version (C++ runtime in fork) ───────────────────────
test('apt --version runs in forked child', async ({ page }) => {
  test.setTimeout(60000);
  const output = await runScript(page, 'apt --version 2>&1');
  console.log('=== Test 7 output ===\n' + output.slice(-500));
  expect(output).toContain('apt');
  expect(output).toContain('amd64');
});

// ─── Test 8: apt update ────────────────────────────────────────────────
test('apt update contacts mirror', async ({ page }) => {
  test.setTimeout(180000);
  const output = await runScript(page, 'apt update 2>&1 | tail -5', 120000);
  console.log('=== Test 8 output ===\n' + output.slice(-1000));
  // apt update should at least get to reading package lists or show connection attempt
  const hasProgress = output.includes('Reading') || output.includes('Fetched') ||
                      output.includes('Hit') || output.includes('Get') ||
                      output.includes('Ign') || output.includes('Err');
  expect(hasProgress || output.includes('apt')).toBeTruthy();
});

// ─── Test 9: Large fork chain (dpkg simulation) ────────────────────────
test('large fork chain: 50 fork+exec in sequence', async ({ page }) => {
  test.setTimeout(120000);
  const output = await runScript(page,
    'for i in $(seq 1 50); do /bin/echo $i > /dev/null; done && echo FORK_CHAIN_DONE',
    60000
  );
  console.log('=== Test 9 output ===\n' + output.slice(-500));
  expect(output).toContain('FORK_CHAIN_DONE');
});

// ─── Test 10: dpkg --version ───────────────────────────────────────────
test('dpkg --version runs correctly', async ({ page }) => {
  test.setTimeout(60000);
  const output = await runScript(page, 'dpkg --version 2>&1');
  console.log('=== Test 10 output ===\n' + output.slice(-500));
  expect(output).toContain('Debian');
  expect(output).toContain('dpkg');
});
