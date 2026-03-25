import { AtuaComputerRuntime } from '../src/index.js';

async function run() {
  const runtime = new AtuaComputerRuntime();
  await runtime.boot();

  const api = await runtime.apiConformance();
  const methodCoverage = Object.values(api.methods).every(Boolean);

  const started = await runtime.service('start', 'api-worker', { command: 'node worker.js' });
  const restarted = await runtime.service('restart', 'api-worker', { command: 'node worker.js' });
  const stopped = await runtime.service('stop', 'api-worker');

  const checkpointId = await runtime.checkpoint('phase-d');
  await runtime.restore(checkpointId);
  const afterRestore = await runtime.service('status', 'api-worker');

  const pass =
    methodCoverage
    && api.behavior.restartChangesPid
    && api.behavior.restartCount >= 1
    && started.state === 'running'
    && restarted.state === 'running'
    && stopped.state === 'stopped'
    && afterRestore.state === 'stopped';

  const summary = {
    timestamp: new Date().toISOString(),
    methodCoverage,
    apiBehavior: api.behavior,
    serviceLifecycle: {
      started: started.state,
      restarted: restarted.state,
      stopped: stopped.state,
      restored: afterRestore.state,
    },
    gate: {
      pass,
      decision: pass ? 'Go' : 'No-Go',
    },
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

run();
