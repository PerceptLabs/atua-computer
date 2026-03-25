import fs from 'node:fs/promises';

const PHASE_REPORTS = [
  'docs/reports/phase-a-validation-report.md',
  'docs/reports/phase-b-validation-report.md',
  'docs/reports/phase-c-validation-report.md',
  'docs/reports/phase-d-validation-report.md',
  'docs/reports/phase-e-validation-report.md',
  'docs/reports/phase-f-validation-report.md',
  'docs/reports/phase-f2-production-parity-report.md',
];

const REQUIRED_REPORTS = [
  'docs/reports/progress-tracker.md',
  'docs/reports/stability-runs-report.md',
  'docs/reports/syscall-gap-report.md',
];

async function exists(path) {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const checks = [];

  for (const report of PHASE_REPORTS) {
    const ok = await exists(report);
    let decisionGo = false;
    if (ok) {
      const content = await fs.readFile(report, 'utf8');
      decisionGo = /\*\*Decision:\*\*\s*Go/.test(content);
    }
    checks.push({ name: report, ok: ok && decisionGo });
  }

  for (const report of REQUIRED_REPORTS) {
    checks.push({ name: report, ok: await exists(report) });
  }

  const pass = checks.every((c) => c.ok);
  const summary = {
    timestamp: new Date().toISOString(),
    pass,
    decision: pass ? 'Go' : 'No-Go',
    checks,
  };

  const lines = [
    '# Release Readiness Report',
    '',
    `- **Updated:** ${summary.timestamp}`,
    `- **Decision:** ${summary.decision}`,
    '',
    '| Check | Status |',
    '|---|---|',
    ...summary.checks.map((c) => `| ${c.name} | ${c.ok ? '✅' : '❌'} |`),
  ];

  await fs.writeFile('docs/reports/release-readiness-report.md', `${lines.join('\n')}\n`);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main();
