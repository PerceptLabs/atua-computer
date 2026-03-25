import { AtuaComputerRuntime, createMcpToolRegistry } from '../src/index.js';

async function run() {
  const runtime = new AtuaComputerRuntime();
  const registry = createMcpToolRegistry(runtime);

  const tools = registry.listTools();
  const required = ['runtime_boot', 'runtime_exec', 'runtime_service', 'runtime_checkpoint', 'runtime_restore', 'runtime_status'];
  const toolNames = new Set(tools.map((t) => t.name));
  const allRequiredTools = required.every((name) => toolNames.has(name));

  await registry.invoke('runtime_boot', { overlay: { '/workspace/task.txt': 'mcp-ready' } });
  const execResult = await registry.invoke('runtime_exec', { command: 'cat /workspace/task.txt' });
  const serviceStarted = await registry.invoke('runtime_service', { action: 'start', name: 'mcp-worker', command: 'node worker.js' });
  const checkpoint = await registry.invoke('runtime_checkpoint', { label: 'mcp-phase-e' });
  await registry.invoke('runtime_service', { action: 'stop', name: 'mcp-worker' });
  await registry.invoke('runtime_restore', { id: checkpoint.id });
  const serviceStatus = await registry.invoke('runtime_service', { action: 'status', name: 'mcp-worker' });
  const status = await registry.invoke('runtime_status', {});

  const pass =
    allRequiredTools
    && execResult.exitCode === 0
    && serviceStarted.state === 'running'
    && serviceStatus.state === 'running'
    && status.booted === true;

  const summary = {
    timestamp: new Date().toISOString(),
    toolsRegistered: tools.length,
    allRequiredTools,
    checks: {
      execThroughMcp: execResult.exitCode === 0,
      serviceStartThroughMcp: serviceStarted.state === 'running',
      checkpointRestoreThroughMcp: serviceStatus.state === 'running',
      statusThroughMcp: status.booted === true,
    },
    gate: {
      pass,
      decision: pass ? 'Go' : 'No-Go',
    },
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

run();
