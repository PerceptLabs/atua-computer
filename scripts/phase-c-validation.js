import { AtuaComputerRuntime } from '../src/index.js';

async function run() {
  const runtime = new AtuaComputerRuntime();
  await runtime.boot({ overlay: { '/workspace/app.js': 'console.log("ok")' } });

  const checks = {
    nodeVersion: await runtime.exec('node -v'),
    pythonVersion: await runtime.exec('python --version'),
    networkCurl: await runtime.exec('curl api.atua.ai'),
    projectRead: await runtime.exec('cat /workspace/app.js'),
  };

  await runtime.service('start', 'worker', { command: 'node worker.js' });
  const checkpointId = await runtime.checkpoint('phase-c');
  await runtime.service('stop', 'worker');
  await runtime.restore(checkpointId);
  const restoredService = await runtime.service('status', 'worker');

  const workload = await runtime.runGoldenWorkloadPack();
  const syscallReport = await runtime.syscallReport();

  const pass =
    Object.values(checks).every((r) => r.exitCode === 0)
    && restoredService.state === 'running'
    && workload.failed === 0;

  const summary = {
    timestamp: new Date().toISOString(),
    checks: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.exitCode === 0])),
    restoredServiceState: restoredService.state,
    workload: { total: workload.total, failed: workload.failed },
    syscallCoverage: syscallReport.coverage,
    gate: {
      pass,
      decision: pass ? 'Go' : 'No-Go',
    },
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

run();
