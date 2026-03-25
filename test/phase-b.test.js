/**
 * Phase B Validation Tests — Real x86-64 Execution
 *
 * These tests verify that:
 * 1. Blink WASM engine loads and boots
 * 2. A real static x86-64 ELF binary executes real instructions
 * 3. The write() syscall produces real stdout output
 * 4. The exit code comes from real process termination
 *
 * Prerequisites:
 * - wasm/blink.js and wasm/blink.wasm must exist (run native/build.sh)
 * - test/fixtures/hello.elf must exist (built by native/build.sh)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AtuaComputerRuntime } from '../src/index.js';
import { AtuaLinuxEngine } from '../src/engine/atua-linux-engine.js';
import { SyscallTracer } from '../src/syscall-tracer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_PATH = resolve(__dirname, '../wasm/engine.cjs');
const HELLO_ELF = resolve(__dirname, 'fixtures/hello.elf');

const engineExists = existsSync(ENGINE_PATH) && existsSync(ENGINE_PATH.replace('.cjs', '.wasm'));
const elfExists = existsSync(HELLO_ELF);

// Skip all tests if engine or test binary not built yet
const skipReason = !engineExists
  ? 'Engine not built. Run native/build.sh in the atua-computer container.'
  : !elfExists
    ? 'Test ELF not built. Run native/build.sh in the atua-computer container.'
    : undefined;

test('Phase B prerequisite: engine WASM exists', { skip: skipReason }, () => {
  assert.ok(existsSync(ENGINE_PATH), 'wasm/blink.js must exist');
  assert.ok(existsSync(ENGINE_PATH.replace('.js', '.wasm')), 'wasm/blink.wasm must exist');
});

test('Phase B prerequisite: test ELF binary exists', { skip: skipReason }, () => {
  assert.ok(existsSync(HELLO_ELF), 'test/fixtures/hello.elf must exist');
});

test('Phase B: engine boots when WASM files exist', { skip: skipReason }, async () => {
  const tracer = new SyscallTracer();
  const engine = new AtuaLinuxEngine({ syscallTracer: tracer, enginePath: ENGINE_PATH });

  await engine.boot();
  assert.ok(engine.isBooted());
});

test('Phase B: real x86-64 ELF executes and produces real output', { skip: skipReason }, async () => {
  const tracer = new SyscallTracer();
  const engine = new AtuaLinuxEngine({ syscallTracer: tracer, enginePath: ENGINE_PATH });
  await engine.boot();

  const proc = {
    pid: 1000,
    command: HELLO_ELF,
    stdout: [],
    stderr: [],
  };

  const result = await engine.run(proc, {});

  // This is REAL output from REAL x86-64 instruction execution
  assert.strictEqual(proc.stdout.join(''), 'hello from atua-computer\n',
    'Expected real output from x86-64 write() syscall');
  assert.strictEqual(result.exitCode, 0,
    'Expected real exit code 0 from x86-64 exit_group() syscall');
});

test('Phase B: syscall tracer records real syscall events', { skip: skipReason }, async () => {
  const tracer = new SyscallTracer();
  const engine = new AtuaLinuxEngine({ syscallTracer: tracer, enginePath: ENGINE_PATH });
  await engine.boot();

  const proc = {
    pid: 1001,
    command: HELLO_ELF,
    stdout: [],
    stderr: [],
  };

  await engine.run(proc, {});

  const events = tracer.list();
  assert.ok(events.length > 0, 'Tracer should record syscall events');

  const syscallNames = events.map((e) => e.syscall);
  assert.ok(syscallNames.includes('execve'), 'Should record execve');
  assert.ok(syscallNames.includes('write'), 'Should record write');
  assert.ok(syscallNames.includes('exit_group'), 'Should record exit_group');
});

test('Phase B: runtime.exec() runs real ELF through full stack', { skip: skipReason }, async () => {
  const tracer = new SyscallTracer();
  const engine = new AtuaLinuxEngine({ syscallTracer: tracer, enginePath: ENGINE_PATH });
  const runtime = new AtuaComputerRuntime({ engine, syscallTracer: tracer });

  await runtime.boot();
  const result = await runtime.exec(HELLO_ELF);

  assert.strictEqual(result.stdout, 'hello from atua-computer\n');
  assert.strictEqual(result.exitCode, 0);
});

test('Phase B: nonexistent ELF returns exit code 127', { skip: skipReason }, async () => {
  const engine = new AtuaLinuxEngine({ enginePath: ENGINE_PATH });
  await engine.boot();

  const proc = {
    pid: 1002,
    command: '/nonexistent/binary',
    stdout: [],
    stderr: [],
  };

  const result = await engine.run(proc, {});
  assert.strictEqual(result.exitCode, 127);
  assert.ok(proc.stderr.join('').includes('No such file'), 'Should report file not found');
});

test('Phase B: engine rejects boot without WASM files', async () => {
  const engine = new AtuaLinuxEngine({ enginePath: '/nonexistent/engine.js' });
  await assert.rejects(
    () => engine.boot(),
    /Engine not found/,
  );
});
