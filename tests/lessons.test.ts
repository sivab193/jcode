import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeLedger } from '../dist/core/learn.js';
import { appendLessonEntry, formatLessonEntry } from '../dist/core/lessons.js';

test('lessons: entry format carries the snapshot and proposals', () => {
  const records = [];
  for (let i = 0; i < 3; i++) {
    records.push(
      { event: 'run-started', taskId: `t${i}`, backend: 'codex-a', brief: 'fix bug', classification: { taskClass: 'backend', difficulty: 'medium', reason: 'test' } },
      { event: 'run-finished', taskId: `t${i}`, backend: 'codex-a', success: true, errorClass: null, durationMs: 1000, finishedAt: '2026-11-18T12:00:00.000Z', stdoutTail: '' },
    );
  }
  const analysis = analyzeLedger(records as never, [], new Date('2026-11-18T12:00:00Z'));
  const entry = formatLessonEntry(analysis);
  assert.match(entry, /## 2026-11-18/);
  assert.match(entry, /3 runs across 3 tasks, overall success 100%/);
  assert.match(entry, /Strongest measured pair: codex-a\/backend \(3\/3\)/);
});

test('lessons: empty fold says so plainly', () => {
  const analysis = analyzeLedger([], [], new Date('2026-11-18T12:00:00Z'));
  const entry = formatLessonEntry(analysis);
  assert.match(entry, /0 runs across 0 tasks/);
  assert.match(entry, /No proposals/);
});

test('lessons: appends to the store without clobbering earlier folds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'scode-lessons-'));
  const savedHome = process.env.SCODE_HOME;
  process.env.SCODE_HOME = dir;
  try {
    const first = analyzeLedger([], [], new Date('2026-11-11T12:00:00Z'));
    const second = analyzeLedger([], [], new Date('2026-11-18T12:00:00Z'));
    await appendLessonEntry(first);
    await appendLessonEntry(second);
    const text = await readFile(join(dir, 'lessons.md'), 'utf-8');
    assert.match(text, /## 2026-11-11/);
    assert.match(text, /## 2026-11-18/);
    assert.equal((text.match(/^## /gm) ?? []).length, 2);
  } finally {
    if (savedHome === undefined) delete process.env.SCODE_HOME;
    else process.env.SCODE_HOME = savedHome;
  }
});
