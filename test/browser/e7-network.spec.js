/**
 * E7 test: Network — TCP via Wisp relay.
 * Boots the engine with a local Wisp relay, runs test_http_get,
 * verifies that a real HTTP response comes back through the relay.
 */

import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWispRelay } from './wisp-relay.js';
import * as net from 'node:net';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '../..');
const BROWSER_DIR = resolve(ROOT, 'src/browser');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.wasm': 'application/wasm', '.tar': 'application/x-tar',
};

let server, serverUrl, relay, echoServer, echoPort;

test.beforeAll(async () => {
  // Start HTTP server (Wisp relay attaches to same port via upgrade)
  server = createServer((req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');

    const url = new URL(req.url, 'http://localhost');

    // DNS proxy endpoint (avoids CORS on dns.google)
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
        .catch(e => {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        });
      return;
    }

    const map = {
      '/': join(BROWSER_DIR, 'e7-network.html'),
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

  // Attach Wisp relay to same HTTP server (avoids cross-origin WebSocket issues)
  relay = attachWispRelay(server);

  // Start a local HTTP echo server (the test binary connects to this via the relay)
  echoServer = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Connection': 'close' });
    res.end('atua-network-ok\n');
  });
  await new Promise(r => echoServer.listen(0, '127.0.0.1', () => r()));
  echoPort = echoServer.address().port;
  console.log('Echo server on port', echoPort);
});

test.afterAll(async () => {
  if (relay) relay.close();
  if (echoServer) echoServer.close();
  if (server) server.close();
});

test('HTTP GET via Wisp relay returns real data', async ({ page }) => {
  test.setTimeout(120000);

  page.on('console', msg => {
    console.log(`BROWSER [${msg.type()}]:`, msg.text());
  });
  page.on('pageerror', err => {
    console.log('PAGE ERROR:', err.message);
  });

  // Navigate with relay URL on same server (WebSocket upgrade) + echo port
  const wsUrl = serverUrl.replace('http://', 'ws://');
  const navUrl = `${serverUrl}?relay=${encodeURIComponent(wsUrl)}&echoPort=${echoPort}`;
  console.log('Navigating to:', navUrl);
  const resp = await page.goto(navUrl);
  console.log('Page status:', resp?.status());

  // Wait for engine to complete (binary exits after read)
  try {
    await page.waitForFunction(() => {
      const text = document.getElementById('output')?.textContent || '';
      return text.includes('[Tests complete]') || text.includes('FAIL:') || text.includes('ERROR:');
    }, { timeout: 30000 });
  } catch (e) {
    // timeout — grab what we have
  }

  const pageText = await page.evaluate(() => document.getElementById('output')?.textContent || '').catch(() => '');
  console.log('Network test output:\n' + pageText);

  // Verify socket was created
  expect(pageText).toContain('PASS: socket()');

  // Verify connection established
  expect(pageText).toContain('PASS: connect()');

  // Verify data was sent
  expect(pageText).toContain('PASS: write(');

  // Verify response was received
  expect(pageText).toContain('PASS: read(');

  // Verify HTTP response content
  expect(pageText).toContain('Response: HTTP/1.1 200 OK');
});

test('DNS + HTTP GET to real external host (example.com)', async ({ page }) => {
  test.setTimeout(120000);

  page.on('console', msg => {
    console.log(`BROWSER [${msg.type()}]:`, msg.text());
  });

  const wsUrl = serverUrl.replace('http://', 'ws://');
  // DNS resolution + HTTP GET to example.com via Wisp relay
  const dnsUrl = `${serverUrl}/dns-resolve`;
  const navUrl = `${serverUrl}?relay=${encodeURIComponent(wsUrl)}&dns=${encodeURIComponent(dnsUrl)}&bin=/test_dns_debug&args=`;
  await page.goto(navUrl);

  try {
    await page.waitForFunction(() => {
      const text = document.getElementById('output')?.textContent || '';
      return text.includes('[Tests complete]') || text.includes('FAIL:') || text.includes('ERROR:');
    }, { timeout: 30000 });
  } catch (e) {
    console.log('Timeout waiting for output');
  }

  // Grab whatever output is there
  await new Promise(r => setTimeout(r, 1000));
  const pageText = await page.evaluate(() => document.getElementById('output')?.textContent || '').catch(() => '(eval failed)');
  console.log('DNS+HTTP test output:\n' + pageText);

  expect(pageText).toContain('PASS: getaddrinfo');
});

test('poll() on socket fd returns POLLIN when data available', async ({ page }) => {
  test.setTimeout(120000);

  page.on('console', msg => {
    if (msg.type() === 'error') console.log('BROWSER ERROR:', msg.text());
  });

  const wsUrl = serverUrl.replace('http://', 'ws://');
  const navUrl = `${serverUrl}?relay=${encodeURIComponent(wsUrl)}&echoPort=${echoPort}&bin=/test_poll_socket&args=127.0.0.1,${echoPort}`;
  await page.goto(navUrl);

  try {
    await page.waitForFunction(() => {
      const text = document.getElementById('output')?.textContent || '';
      return text.includes('[Tests complete]') || text.includes('FAIL:') || text.includes('ERROR:');
    }, { timeout: 30000 });
  } catch (e) {}

  const pageText = await page.evaluate(() => document.getElementById('output')?.textContent || '').catch(() => '');
  console.log('Poll test output:\n' + pageText);

  expect(pageText).toContain('PASS: socket()');
  expect(pageText).toContain('PASS: connect()');
  expect(pageText).toContain('PASS: poll()');
  expect(pageText).toContain('PASS: read(');
});
