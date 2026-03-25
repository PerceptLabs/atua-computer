import fs from 'node:fs/promises';
import { AtuaComputerRuntime, createMcpToolRegistry } from '../src/index.js';

async function run() {
  const runtime = new AtuaComputerRuntime();
  const mcp = createMcpToolRegistry(runtime, {
    transport: 'atua-net',
    authzEnabled: true,
    schemaVersion: '2026-03-25',
  });
  await runtime.boot();

  const backend = await runtime.backendProfile();
  await runtime.runGoldenWorkloadPack();
  const syscallReport = await runtime.syscallReport();
  const tools = mcp.listTools();
  const mcpMeta = mcp.metadata();

  const checks = {
    backendProductionReady: backend.productionReady,
    mcpTransportProduction: mcpMeta.transport !== 'in-process',
    mcpAuthzEnabled: mcpMeta.authzEnabled === true,
    mcpVersioningEnabled: Boolean(mcpMeta.schemaVersion),
    syscallMustHaveMissing: syscallReport.coverage.missingMustHave.length === 0,
    syscallShouldHaveMissing: syscallReport.coverage.missingShouldHave.length === 0,
    toolSurfacePresent: tools.length >= 6,
  };

  const pass = Object.values(checks).every(Boolean);
  const summary = {
    timestamp: new Date().toISOString(),
    backend,
    checks,
    decision: pass ? 'Go' : 'No-Go',
  };

  const lines = [
    '# Phase F2 Production Parity Report',
    '',
    `- **Updated:** ${summary.timestamp}`,
    `- **Decision:** ${summary.decision}`,
    '',
    '| Check | Status |',
    '|---|---|',
    ...Object.entries(checks).map(([name, ok]) => `| ${name} | ${ok ? '✅' : '❌'} |`),
    '',
    '## Backend Profile',
    '',
    `- fsBridge: ${backend.fsBridge}`,
    `- netBridge: ${backend.netBridge}`,
    `- ptyBridge: ${backend.ptyBridge}`,
    `- engine: ${backend.engine}`,
    `- inMemoryBackends: ${backend.inMemoryBackends.join(', ') || 'none'}`,
  ];

  await fs.writeFile('docs/reports/phase-f2-production-parity-report.md', `${lines.join('\n')}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

run();
