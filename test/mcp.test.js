import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AtuaComputerRuntime, createMcpToolRegistry } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const engineAvailable = existsSync(resolve(__dirname, '../wasm/engine.cjs'));

test('mcp tool registry lists correct tools with schemas', () => {
  const runtime = new AtuaComputerRuntime();
  const registry = createMcpToolRegistry(runtime);

  const tools = registry.listTools();
  const toolNames = new Set(tools.map((t) => t.name));

  for (const required of ['runtime_boot', 'runtime_exec', 'runtime_service', 'runtime_checkpoint', 'runtime_restore', 'runtime_status']) {
    assert.equal(toolNames.has(required), true, `missing tool: ${required}`);
  }

  for (const tool of tools) {
    assert.ok(tool.description, `tool ${tool.name} missing description`);
    assert.ok(tool.inputSchema, `tool ${tool.name} missing inputSchema`);
  }
});

test('mcp tool registry metadata has correct defaults', () => {
  const runtime = new AtuaComputerRuntime();
  const registry = createMcpToolRegistry(runtime);

  const meta = registry.metadata();
  assert.equal(meta.transport, 'in-process');
  assert.equal(meta.authzEnabled, false);
});

test('mcp registry invoke rejects unknown tool', async () => {
  const runtime = new AtuaComputerRuntime();
  const registry = createMcpToolRegistry(runtime);

  await assert.rejects(
    () => registry.invoke('nonexistent_tool', {}),
    /Unknown MCP tool/,
  );
});

test('mcp boot and status work end-to-end', { skip: !engineAvailable ? 'Engine not built' : undefined }, async () => {
  const runtime = new AtuaComputerRuntime();
  const registry = createMcpToolRegistry(runtime);

  await registry.invoke('runtime_boot', {});
  const status = await registry.invoke('runtime_status', {});
  assert.equal(status.booted, true);
});
