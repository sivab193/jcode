import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatBrief, installPromptPack } from '../dist/core/promptPack.js';

test('prompt pack: brief template keeps the brief verbatim', () => {
  const brief = 'add a lambda function for the API';
  const wrapped = formatBrief(brief);
  assert.ok(wrapped.includes('## Task'));
  assert.ok(wrapped.includes(brief));
  assert.ok(wrapped.includes('## Working rules'));
  assert.ok(wrapped.includes('SCODE_NOTES.md'));
  assert.ok(wrapped.includes('Do not invent data'));
});

test('prompt pack: installs all four files into an empty worktree', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scode-pack-'));
  const result = await installPromptPack(dir);
  assert.deepEqual(result.installed.sort(), [
    '.kiro/steering/scode.md',
    'AGENTS.md',
    'CLAUDE.md',
    'SCODE_NOTES.md',
  ]);
  assert.deepEqual(result.skipped, []);
  const agents = await readFile(join(dir, 'AGENTS.md'), 'utf-8');
  assert.match(agents, /headless under scode/);
  const notes = await readFile(join(dir, 'SCODE_NOTES.md'), 'utf-8');
  assert.match(notes, /shared lessons across backends/);
  await access(join(dir, '.kiro', 'steering', 'scode.md'));
});

test('prompt pack: never overwrites the repo’s own steering files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scode-pack-'));
  await writeFile(join(dir, 'AGENTS.md'), '# my own rules\n', 'utf-8');
  const result = await installPromptPack(dir);
  assert.ok(!result.installed.includes('AGENTS.md'));
  assert.ok(result.skipped.includes('AGENTS.md'));
  assert.equal(await readFile(join(dir, 'AGENTS.md'), 'utf-8'), '# my own rules\n');
  // The other three still install.
  assert.ok(result.installed.includes('CLAUDE.md'));
  assert.ok(result.installed.includes('SCODE_NOTES.md'));
});
