/**
 * E9 test: apt update → apt install curl → curl example.com
 * Based on e7-network.spec.js server setup (which works).
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
        .catch(e => { res.writeHead(500); res.end('{}'); });
      return;
    }

    const map = {
      '/': join(BROWSER_DIR, 'e9-apt-install.html'),
      '/engine.wasm': join(BROWSER_DIR, 'engine.wasm'),
      '/atua-computer.js': join(BROWSER_DIR, 'atua-computer.js'),
      '/wisp-client.js': join(BROWSER_DIR, 'wisp-client.js'),
      '/filesystem.js': join(BROWSER_DIR, 'filesystem.js'),
      '/engine-worker.js': join(BROWSER_DIR, 'engine-worker.js'),
      '/engine-main-worker.js': join(BROWSER_DIR, 'engine-main-worker.js'),
      '/debian-mini.tar': join(ROOT, 'test/fixtures/debian-mini.tar'),
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

test('bash echo works through e9 server', async ({ page }) => {
  test.setTimeout(30000);

  page.on('console', msg => console.log(`BROWSER [${msg.type()}]:`, msg.text()));

  const wsUrl = serverUrl.replace('http://', 'ws://');
  const dnsUrl = `${serverUrl}/dns-resolve`;
  const navUrl = `${serverUrl}?relay=${encodeURIComponent(wsUrl)}&dns=${encodeURIComponent(dnsUrl)}`;
  await page.goto(navUrl);

  try {
    await page.waitForFunction(() => {
      const text = document.getElementById('output')?.textContent || '';
      return text.includes('[STEP 1 PASS]') || text.includes('[Tests complete]') ||
             text.includes('[FAIL]') || text.includes('[ERROR]');
    }, { timeout: 20000 });
  } catch (e) {}

  const pageText = await page.evaluate(() =>
    document.getElementById('output')?.textContent || ''
  ).catch(() => '');
  console.log('Output:\n' + pageText.substring(0, 500));

  // Step 1 just echoes — doesn't need networking
  expect(pageText).toContain('[STEP 1 PASS]');
});
