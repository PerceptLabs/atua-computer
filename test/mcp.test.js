import test from 'node:test';
import assert from 'node:assert/strict';
import { AtuaComputerRuntime, createMcpToolRegistry } from '../src/index.js';

test('mcp tool registry maps runtime operations end-to-end', async () => {
  const runtime = new AtuaComputerRuntime();
  const registry = createMcpToolRegistry(runtime);

  const tools = registry.listTools();

  const meta = registry.metadata();
  assert.equal(meta.transport, 'in-process');
  assert.equal(meta.authzEnabled, false);

  const toolNames = new Set(tools.map((t) => t.name));
  for (const required of ['runtime_boot', 'runtime_exec', 'runtime_service', 'runtime_checkpoint', 'runtime_restore', 'runtime_status']) {
    assert.equal(toolNames.has(required), true);
  }

  await registry.invoke('runtime_boot', { overlay: { '/workspace/mcp.txt': 'ok' } });
  const execResult = await registry.invoke('runtime_exec', { command: 'cat /workspace/mcp.txt' });
  assert.equal(execResult.exitCode, 0);

  const svc = await registry.invoke('runtime_service', { action: 'start', name: 'mcp-service', command: 'node service.js' });
  assert.equal(svc.state, 'running');

  const checkpoint = await registry.invoke('runtime_checkpoint', { label: 'mcp-test' });
  await registry.invoke('runtime_service', { action: 'stop', name: 'mcp-service' });
  await registry.invoke('runtime_restore', { id: checkpoint.id });

  const restored = await registry.invoke('runtime_service', { action: 'status', name: 'mcp-service' });
  assert.equal(restored.state, 'running');
});
