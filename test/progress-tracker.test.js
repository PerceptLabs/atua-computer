import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';

const execFileAsync = promisify(execFile);

test('tracker update script generates progress tracker markdown', async () => {
  await execFileAsync('node', ['scripts/update-progress-tracker.js']);
  const content = await fs.readFile('docs/reports/progress-tracker.md', 'utf8');

  assert.match(content, /# Progress Tracker/);
  assert.match(content, /Current Phase:/);
  assert.match(content, /What Is Next \(Immediate\)/);
  assert.match(content, /Phase B/);
});
