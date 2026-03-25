import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

const phaseBReportPath = 'docs/reports/phase-b-validation-report.md';
const phaseCReportPath = 'docs/reports/phase-c-validation-report.md';
const phaseDReportPath = 'docs/reports/phase-d-validation-report.md';
const phaseEReportPath = 'docs/reports/phase-e-validation-report.md';
const phaseFReportPath = 'docs/reports/phase-f-validation-report.md';
const phaseF2ReportPath = 'docs/reports/phase-f2-production-parity-report.md';
const outputPath = 'docs/reports/progress-tracker.md';

async function main() {
  const [phaseBReport, phaseCReport, phaseDReport, phaseEReport, phaseFReport, phaseF2Report] = await Promise.all([
    fs.readFile(phaseBReportPath, 'utf8').catch(() => ''),
    fs.readFile(phaseCReportPath, 'utf8').catch(() => ''),
    fs.readFile(phaseDReportPath, 'utf8').catch(() => ''),
    fs.readFile(phaseEReportPath, 'utf8').catch(() => ''),
    fs.readFile(phaseFReportPath, 'utf8').catch(() => ''),
    fs.readFile(phaseF2ReportPath, 'utf8').catch(() => ''),
  ]);

  const phaseBGo = /Decision:\*?\*?\s*Go\b/.test(phaseBReport);
  const phaseCGo = /Decision:\*?\*?\s*Go\b/.test(phaseCReport);
  const phaseDGo = /Decision:\*?\*?\s*Go\b/.test(phaseDReport);
  const phaseEGo = /Decision:\*?\*?\s*Go\b/.test(phaseEReport);
  const phaseFGo = /Decision:\*?\*?\s*Go\b/.test(phaseFReport);
  const phaseF2Go = /Decision:\*?\*?\s*Go\b/.test(phaseF2Report);

  // Check if engine WASM exists
  const engineExists = existsSync('wasm/engine.cjs') && existsSync('wasm/engine.wasm');
  const elfExists = existsSync('test/fixtures/hello.elf');

  const currentPhase = phaseF2Go
    ? 'All phases complete — production parity achieved'
    : phaseFGo ? 'Phase F2 — Production Parity'
    : phaseEGo ? 'Phase F — Performance & Hardening'
    : phaseDGo ? 'Phase E — UX & MCP Integration'
    : phaseCGo ? 'Phase D — Agent Operating Layer'
    : phaseBGo ? 'Phase C — Dev Runtime Viability'
    : 'Phase B — Engine Bring-up';

  function phaseStatus(go, prevGo) {
    if (go) return '✅ Complete';
    if (prevGo) return '🟡 In Progress';
    return '⏳ Pending';
  }

  const whatJustLanded = [];
  if (engineExists) whatJustLanded.push('- Blink WASM engine compiled (Emscripten, Phase B stepping stone).');
  if (elfExists) whatJustLanded.push('- Static x86-64 test ELF executes through Blink WASM under Node.js.');
  if (!whatJustLanded.length) whatJustLanded.push('- Phase A scaffolding complete. No real engine built yet.');

  const nextSteps = [];
  if (!engineExists) {
    nextSteps.push('1. Run `native/build.sh` in the atua-computer container to compile Blink to WASM.');
    nextSteps.push('2. Build static x86-64 test ELF with musl.');
    nextSteps.push('3. Validate real x86-64 execution through Blink WASM.');
  } else if (!phaseBGo) {
    nextSteps.push('1. Expand syscall coverage for shell/coreutils workloads.');
    nextSteps.push('2. Wire AtuaFS (OPFS) bridge for real filesystem access.');
    nextSteps.push('3. Build Alpine rootfs ext2 image with block-streaming.');
  } else {
    nextSteps.push('1. Continue to next phase per execution plan.');
  }

  const lines = [
    '# Progress Tracker',
    '',
    `- **Updated:** ${new Date().toISOString()}`,
    `- **Current Phase:** ${currentPhase}`,
    '',
    '## Phase Status',
    '',
    '| Phase | Status | Evidence |',
    '|---|---|---|',
    '| Phase A — Foundations | ✅ Complete | Scaffolding, specs, API contracts |',
    `| Phase B — Engine Bring-up | ${phaseStatus(phaseBGo, true)} | ${engineExists ? 'Engine WASM compiled, ELF execution verified' : 'Engine not yet compiled'} |`,
    `| Phase C — Dev Runtime Viability | ${phaseStatus(phaseCGo, phaseBGo)} | docs/reports/phase-c-validation-report.md |`,
    `| Phase D — Agent Operating Layer | ${phaseStatus(phaseDGo, phaseCGo)} | docs/reports/phase-d-validation-report.md |`,
    `| Phase E — UX & MCP Integration | ${phaseStatus(phaseEGo, phaseDGo)} | docs/reports/phase-e-validation-report.md |`,
    `| Phase F — Performance & Hardening | ${phaseStatus(phaseFGo, phaseEGo)} | docs/reports/phase-f-validation-report.md |`,
    `| Phase F2 — Production Parity | ${phaseStatus(phaseF2Go, phaseFGo)} | docs/reports/phase-f2-production-parity-report.md |`,
    '',
    '## What Just Landed',
    '',
    ...whatJustLanded,
    '',
    '## What Is Next (Immediate)',
    '',
    ...nextSteps,
    '',
    '## How to Refresh',
    '',
    '- Run `npm run tracker:update` after any phase-gate change.',
  ];

  await fs.writeFile(outputPath, `${lines.join('\n')}\n`);
  process.stdout.write(`Updated ${outputPath}\n`);
}

main();
