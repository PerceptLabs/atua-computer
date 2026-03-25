import { AtuaComputerRuntime } from '../src/index.js';

const PERF_RUNS = 20;
const SOAK_ITERATIONS = 100;

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[middle - 1] + sorted[middle]) / 2;
  return sorted[middle];
}

async function run() {
  const bootTimes = [];
  const execTimes = [];
  let soakFailures = 0;

  for (let i = 0; i < PERF_RUNS; i += 1) {
    const runtime = new AtuaComputerRuntime();

    const bootStart = performance.now();
    await runtime.boot();
    bootTimes.push(performance.now() - bootStart);

    const execStart = performance.now();
    const execResult = await runtime.exec('echo perf-check');
    execTimes.push(performance.now() - execStart);
    if (execResult.exitCode !== 0) soakFailures += 1;
  }

  const runtime = new AtuaComputerRuntime();
  await runtime.boot();
  await runtime.service('start', 'soak', { command: 'node soak.js' });

  for (let i = 0; i < SOAK_ITERATIONS; i += 1) {
    const result = await runtime.exec('echo soak');
    if (result.exitCode !== 0) soakFailures += 1;
  }

  const checkpointId = await runtime.checkpoint('phase-f-recovery');
  await runtime.service('stop', 'soak');
  await runtime.restore(checkpointId);
  const restored = await runtime.service('status', 'soak');

  const summary = {
    timestamp: new Date().toISOString(),
    perf: {
      runs: PERF_RUNS,
      bootMs: {
        median: Number(median(bootTimes).toFixed(3)),
        max: Number(Math.max(...bootTimes).toFixed(3)),
      },
      execMs: {
        median: Number(median(execTimes).toFixed(3)),
        max: Number(Math.max(...execTimes).toFixed(3)),
      },
    },
    soak: {
      iterations: SOAK_ITERATIONS,
      failures: soakFailures,
    },
    recovery: {
      restoredServiceState: restored.state,
    },
    gate: {
      perfPass: median(bootTimes) < 20 && median(execTimes) < 10,
      soakPass: soakFailures === 0,
      recoveryPass: restored.state === 'running',
    },
  };

  summary.gate.pass = summary.gate.perfPass && summary.gate.soakPass && summary.gate.recoveryPass;
  summary.gate.decision = summary.gate.pass ? 'Go' : 'No-Go';

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

run();
