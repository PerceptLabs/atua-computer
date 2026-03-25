import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const OUTPUT = 'docs/reports/stability-runs-report.md';
const RUNS = 5;

const COMMANDS = [
  { name: 'unit-tests', cmd: 'npm', args: ['test'] },
  { name: 'phase-b', cmd: 'npm', args: ['run', 'validate:phase-b'] },
  { name: 'phase-c', cmd: 'npm', args: ['run', 'validate:phase-c'] },
  { name: 'phase-d', cmd: 'npm', args: ['run', 'validate:phase-d'] },
  { name: 'phase-e', cmd: 'npm', args: ['run', 'validate:phase-e'] },
  { name: 'phase-f', cmd: 'npm', args: ['run', 'validate:phase-f'] },
  { name: 'phase-f2', cmd: 'npm', args: ['run', 'validate:phase-f2'] },
];

async function runOnce(command) {
  try {
    await execFileAsync(command.cmd, command.args, { maxBuffer: 1024 * 1024 * 10 });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.stderr || error.message };
  }
}

async function main() {
  const summary = {};
  for (const command of COMMANDS) {
    summary[command.name] = { pass: 0, fail: 0, failures: [] };
  }

  for (let i = 1; i <= RUNS; i += 1) {
    for (const command of COMMANDS) {
      const result = await runOnce(command);
      if (result.ok) {
        summary[command.name].pass += 1;
      } else {
        summary[command.name].fail += 1;
        summary[command.name].failures.push({ run: i, error: result.error });
      }
    }
  }

  const lines = [
    '# Stability Runs Report',
    '',
    `- **Updated:** ${new Date().toISOString()}`,
    `- **Total iterations per check:** ${RUNS}`,
    '',
    '| Check | Pass | Fail |',
    '|---|---:|---:|',
  ];

  for (const command of COMMANDS) {
    const row = summary[command.name];
    lines.push(`| ${command.name} | ${row.pass} | ${row.fail} |`);
  }

  lines.push('', '## Failure Details', '');
  let failuresLogged = false;
  for (const command of COMMANDS) {
    const row = summary[command.name];
    if (!row.failures.length) continue;
    failuresLogged = true;
    lines.push(`### ${command.name}`);
    for (const failure of row.failures) {
      lines.push(`- Run ${failure.run}: ${String(failure.error).slice(0, 400)}`);
    }
    lines.push('');
  }

  if (!failuresLogged) lines.push('- none');

  await fs.writeFile(OUTPUT, `${lines.join('\n')}\n`);
  process.stdout.write(`Updated ${OUTPUT}\n`);
}

main();
