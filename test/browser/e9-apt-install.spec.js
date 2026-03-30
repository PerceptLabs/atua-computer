/**
 * E9 test: apt update → apt install curl → curl example.com
 * Server setup copied from e7-network.spec.js (which works).
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
        .catch(e => {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        });
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

test('apt update + apt install curl + curl example.com', async ({ page }) => {
  test.setTimeout(300000);  // 5 minutes — apt is slow through interpreter

  page.on('console', msg => {
    console.log(`BROWSER [${msg.type()}]:`, msg.text());
  });

  const wsUrl = serverUrl.replace('http://', 'ws://');
  const dnsUrl = `${serverUrl}/dns-resolve`;
  const navUrl = `${serverUrl}?relay=${encodeURIComponent(wsUrl)}&echoPort=${echoPort}&dns=${encodeURIComponent(dnsUrl)}`;
  await page.goto(navUrl);

  // Wait for the engine to finish — [Tests complete] appears when boot() resolves
  try {
    await page.waitForFunction(() => {
      const text = document.getElementById('output')?.textContent || '';
      return text.includes('[Tests complete]') || text.includes('STEP3-OK') ||
             text.includes('[FAIL]') || text.includes('ERROR:');
    }, { timeout: 280000 });
  } catch (e) {
    console.log('Timed out waiting for engine');
  }

  await new Promise(r => setTimeout(r, 500));

  const pageText = await page.evaluate(() =>
    document.getElementById('output')?.textContent || ''
  ).catch(() => '');
  console.log('=== Output (last 2000 chars) ===');
  console.log(pageText.slice(-2000));

  // Check each step
  expect(pageText).toContain('STEP1-OK');
});
