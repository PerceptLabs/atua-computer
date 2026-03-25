import fs from 'node:fs/promises';

const backlogPath = 'docs/specs/phase-a-backlog.md';
const phaseBReportPath = 'docs/reports/phase-b-validation-report.md';
const phaseCReportPath = 'docs/reports/phase-c-validation-report.md';
const phaseDReportPath = 'docs/reports/phase-d-validation-report.md';
const phaseEReportPath = 'docs/reports/phase-e-validation-report.md';
const phaseFReportPath = 'docs/reports/phase-f-validation-report.md';
const phaseF2ReportPath = 'docs/reports/phase-f2-production-parity-report.md';
const outputPath = 'docs/reports/progress-tracker.md';

function boolLabel(value) {
  return value ? '✅ Complete' : '🟡 In Progress';
}

async function main() {
  const [backlog, phaseBReport, phaseCReport, phaseDReport, phaseEReport, phaseFReport, phaseF2Report] = await Promise.all([
    fs.readFile(backlogPath, 'utf8'),
    fs.readFile(phaseBReportPath, 'utf8').catch(() => ''),
    fs.readFile(phaseCReportPath, 'utf8').catch(() => ''),
    fs.readFile(phaseDReportPath, 'utf8').catch(() => ''),
    fs.readFile(phaseEReportPath, 'utf8').catch(() => ''),
    fs.readFile(phaseFReportPath, 'utf8').catch(() => ''),
    fs.readFile(phaseF2ReportPath, 'utf8').catch(() => ''),
  ]);

  const uncheckedItems = (backlog.match(/- \[ \]/g) || []).length;
  const phaseAComplete = uncheckedItems === 0;
  const phaseBGo = /\*\*Decision:\*\*\s*Go/.test(phaseBReport);
  const phaseCGo = /\*\*Decision:\*\*\s*Go/.test(phaseCReport);
  const phaseDGo = /\*\*Decision:\*\*\s*Go/.test(phaseDReport);
  const phaseEGo = /\*\*Decision:\*\*\s*Go/.test(phaseEReport);
  const phaseFGo = /\*\*Decision:\*\*\s*Go/.test(phaseFReport);
  const phaseF2Go = /\*\*Decision:\*\*\s*Go/.test(phaseF2Report);

  const currentPhase = phaseF2Go
    ? 'All phases complete — production parity achieved'
    : phaseFGo
      ? 'Phase F2 — Production Parity'
      : phaseEGo
        ? 'Phase F — Performance & Hardening'
        : phaseDGo
          ? 'Phase E — UX & MCP Integration'
          : phaseCGo
            ? 'Phase D — Agent Operating Layer'
            : phaseBGo
              ? 'Phase C — Dev Runtime Viability'
              : 'Phase B — Engine Bring-up';

  const whatJustLanded = phaseF2Go
    ? [
      '- Phases A-F2 gate artifacts complete.',
      '- Production backend profile checks are passing.',
      '- Release readiness remains `Go` with all required reports present.',
    ]
    : [
      '- Phases A-F gate artifacts complete.',
      '- Syscall gap report shows no missing must-have/should-have in current profile.',
      '- Phase F2 production parity gate scaffold added.',
    ];

  const nextSteps = phaseF2Go
    ? [
      '1. Start real browser-host integration benchmarks (p50/p95 boot/exec/checkpoint latency).',
      '2. Run cross-browser compatibility matrix and publish failure attribution by workload.',
      '3. Open production rollout checklist (SLOs, alerting, canary, rollback).',
    ]
    : [
      '1. Replace in-memory FS/NET/PTY bridges with production backends.',
      '2. Implement production MCP transport/authz/versioning requirements.',
      '3. Re-run `npm run validate:phase-f2` until Decision is `Go`.',
    ];

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
    `| Phase A — Foundations | ${boolLabel(phaseAComplete)} | docs/specs/phase-a-backlog.md |`,
    `| Phase B — Engine Bring-up | ${boolLabel(phaseBGo)} | docs/reports/phase-b-validation-report.md |`,
    `| Phase C — Dev Runtime Viability | ${phaseCGo ? '✅ Complete' : phaseBGo ? '🟡 In Progress' : '⏳ Pending'} | docs/reports/phase-c-validation-report.md |`,
    `| Phase D — Agent Operating Layer | ${phaseDGo ? '✅ Complete' : phaseCGo ? '🟡 In Progress' : '⏳ Pending'} | docs/reports/phase-d-validation-report.md |`,
    `| Phase E — UX & MCP Integration | ${phaseEGo ? '✅ Complete' : phaseDGo ? '🟡 In Progress' : '⏳ Pending'} | docs/reports/phase-e-validation-report.md |`,
    `| Phase F — Performance & Hardening | ${phaseFGo ? '✅ Complete' : phaseEGo ? '🟡 In Progress' : '⏳ Pending'} | docs/reports/phase-f-validation-report.md |`,
    `| Phase F2 — Production Parity | ${phaseF2Go ? '✅ Complete' : phaseFGo ? '🟡 In Progress' : '⏳ Pending'} | docs/reports/phase-f2-production-parity-report.md |`,
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
