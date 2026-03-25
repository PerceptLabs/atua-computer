import fs from 'node:fs/promises';
import { AtuaComputerRuntime } from '../src/index.js';

const outputPath = 'docs/reports/syscall-gap-report.md';

async function run() {
  const runtime = new AtuaComputerRuntime();
  await runtime.boot();
  await runtime.runGoldenWorkloadPack();
  const report = await runtime.syscallReport();

  const lines = [
    '# Syscall Gap Report',
    '',
    `- **Updated:** ${new Date().toISOString()}`,
    '',
    '## Counts by Tier',
    '',
    `- must-have: ${report.counts['must-have']}`,
    `- should-have: ${report.counts['should-have']}`,
    `- stub-later: ${report.counts['stub-later']}`,
    '',
    '## Missing Must-Have',
    '',
    ...(report.coverage.missingMustHave.length ? report.coverage.missingMustHave.map((x) => `- ${x}`) : ['- none']),
    '',
    '## Missing Should-Have',
    '',
    ...(report.coverage.missingShouldHave.length ? report.coverage.missingShouldHave.map((x) => `- ${x}`) : ['- none']),
  ];

  await fs.writeFile(outputPath, `${lines.join('\n')}\n`);
  process.stdout.write(`Updated ${outputPath}\n`);
}

run();
