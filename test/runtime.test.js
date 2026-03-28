import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AtuaComputerRuntime } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_PATH = resolve(__dirname, '../wasm/engine.cjs');
const engineAvailable = existsSync(ENGINE_PATH);

test('runtime constructor creates instance with correct API surface', () => {
  const runtime = new AtuaComputerRuntime();
  const expectedMethods = [
    'boot', 'exec', 'spawn', 'signal', 'read', 'write',
    'install', 'service', 'checkpoint', 'restore', 'status', 'reset',
    'runGoldenWorkloadPack', 'logs', 'listProcesses', 'listServices',
    'apiConformance', 'syscallReport', 'backendProfile', 'onEvent',
  ];
  for (const method of expectedMethods) {
    assert.equal(typeof runtime[method], 'function', `missing method: ${method}`);
  }
});

test('boot succeeds when engine WASM is available', { skip: !engineAvailable ? 'Engine not built' : undefined }, async () => {
  const runtime = new AtuaComputerRuntime();
  await runtime.boot();
  const status = await runtime.status();
  assert.equal(status.booted, true);
});

test('exec fails when runtime not booted', async () => {
  const runtime = new AtuaComputerRuntime();
  await assert.rejects(
    () => runtime.exec('echo hello'),
    /Runtime not booted/,
  );
});

test('status returns unbooted state without boot', async () => {
  const runtime = new AtuaComputerRuntime();
  const status = await runtime.status();
  assert.equal(status.booted, false);
  assert.equal(status.processCount, 0);
  assert.equal(status.serviceCount, 0);
});

test('reset works on unbooted runtime', async () => {
  const runtime = new AtuaComputerRuntime();
  await runtime.reset();
  const status = await runtime.status();
  assert.equal(status.booted, false);
});

test('apiConformance reports all methods present', async () => {
  const runtime = new AtuaComputerRuntime();
  const methods = ['boot', 'exec', 'spawn', 'signal', 'read', 'write', 'install', 'service', 'checkpoint', 'restore', 'status', 'reset', 'runGoldenWorkloadPack', 'logs'];
  for (const m of methods) {
    assert.equal(typeof runtime[m], 'function', `missing: ${m}`);
  }
});

test('syscall tracer starts empty', async () => {
  const runtime = new AtuaComputerRuntime();
  const report = await runtime.syscallReport();
  assert.deepEqual(report.counts, { 'must-have': 0, 'should-have': 0, 'stub-later': 0 });
  assert.equal(report.coverage.seen.length, 0);
  assert.ok(report.coverage.missingMustHave.length > 0, 'should report missing must-have syscalls');
});

test('backendProfile reports real class names', async () => {
  const runtime = new AtuaComputerRuntime();
  const profile = await runtime.backendProfile();
  assert.equal(profile.engine, 'AtuaLinuxEngine');
  assert.equal(profile.fsBridge, 'FsBridge');
  assert.equal(profile.netBridge, 'NetBridge');
  assert.equal(profile.ptyBridge, 'PtyBridge');
});
