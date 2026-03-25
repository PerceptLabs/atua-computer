import test from 'node:test';
import assert from 'node:assert/strict';
import { AtuaComputerRuntime } from '../src/index.js';

test('boot emits start/completed events', async () => {
  const runtime = new AtuaComputerRuntime();
  const types = [];
  runtime.onEvent((evt) => types.push(evt.type));

  await runtime.boot();

  assert.deepEqual(types.slice(0, 2), ['runtime.boot.started', 'runtime.boot.completed']);
});

test('phase-b shell command matrix commands execute', async () => {
  const runtime = new AtuaComputerRuntime();
  await runtime.boot();

  const commands = ['sh', 'ls /', 'pwd', 'mkdir /tmp/test-dir', 'cat /etc/os-release', 'ps'];
  for (const command of commands) {
    const result = await runtime.exec(command);
    assert.equal(result.exitCode, 0, `command failed: ${command}`);
  }

  const lsTmp = await runtime.exec('ls /tmp');
  assert.match(lsTmp.stdout, /\/tmp\/test-dir/);
});

test('service and checkpoint restore include service state', async () => {
  const runtime = new AtuaComputerRuntime();
  await runtime.boot();

  await runtime.service('start', 'ssh', { command: 'service:ssh' });
  const ckpt = await runtime.checkpoint('first');
  await runtime.service('stop', 'ssh');

  let state = await runtime.service('status', 'ssh');
  assert.equal(state.state, 'stopped');

  await runtime.restore(ckpt);
  state = await runtime.service('status', 'ssh');
  assert.equal(state.state, 'running');
  assert.ok(state.pid);
});

test('phase validation supports B and C', async () => {
  const runtime = new AtuaComputerRuntime();
  await runtime.boot();

  const phaseB = await runtime.validatePhase('B');
  const phaseC = await runtime.validatePhase('C');

  assert.equal(phaseB.pass, true);
  assert.equal(phaseC.pass, true);
});



test('backend profile reports production adapters by default', async () => {
  const runtime = new AtuaComputerRuntime();
  await runtime.boot();

  const profile = await runtime.backendProfile();
  assert.equal(profile.productionReady, true);
  assert.equal(profile.inMemoryBackends.length, 0);
});

test('api conformance validates methods and restart behavior', async () => {
  const runtime = new AtuaComputerRuntime();
  await runtime.boot();

  const report = await runtime.apiConformance();
  assert.equal(Object.values(report.methods).every(Boolean), true);
  assert.equal(report.behavior.restartChangesPid, true);
  assert.ok(report.behavior.restartCount >= 1);
});

test('golden workload pack executes and writes workload log', async () => {
  const runtime = new AtuaComputerRuntime();
  await runtime.boot();

  const summary = await runtime.runGoldenWorkloadPack();
  assert.equal(summary.total, 6);
  assert.equal(summary.failed, 0);

  const workloadLogs = await runtime.logs({ scope: 'workload' });
  assert.equal(workloadLogs.length, 1);
  assert.match(workloadLogs[0].message, /golden pack/);
});


test('syscall report exposes coverage and missing sets', async () => {
  const runtime = new AtuaComputerRuntime();
  await runtime.boot();
  await runtime.exec('node -v');

  const report = await runtime.syscallReport();
  assert.ok(Array.isArray(report.coverage.seen));
  assert.ok(Array.isArray(report.coverage.missingMustHave));
});
test('status includes syscall, net, and log counters after workloads', async () => {
  const runtime = new AtuaComputerRuntime();
  await runtime.boot();

  await runtime.exec('curl api.atua.ai');
  await runtime.exec('node -v');

  const status = await runtime.status();
  assert.ok(status.syscallCounts['must-have'] > 0);
  assert.ok(status.syscallCounts['should-have'] > 0);
  assert.equal(status.net.totalSockets, 1);
  assert.ok(status.logCount >= 3); // boot + two commands
});
