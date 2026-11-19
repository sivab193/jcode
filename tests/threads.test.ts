import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeThread,
  createThread,
  findThread,
  loadThreads,
  renderThreadList,
  renderThreadStatus,
  slugifyTitle,
  threadTitle,
  type Thread,
} from '../dist/core/threads.js';

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.toString() || error.message));
      else resolvePromise(stdout.toString());
    });
  });
}

async function withTempHome(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'scode-threads-test-'));
  const savedHome = process.env.SCODE_HOME;
  process.env.SCODE_HOME = dir;
  try {
    await fn();
  } finally {
    if (savedHome === undefined) delete process.env.SCODE_HOME;
    else process.env.SCODE_HOME = savedHome;
  }
}

async function fixtureRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'scode-thread-repo-'));
  await git(['init', '-b', 'main'], dir);
  await git(['config', 'user.name', 'Test'], dir);
  await git(['config', 'user.email', 'test@example.com'], dir);
  await writeFile(join(dir, 'README.md'), '# fixture\n');
  await git(['add', '.'], dir);
  await git(['commit', '-m', 'initial'], dir);
  return dir;
}

function fakeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 'abcd1234',
    title: 'Add login page',
    repoCwd: '/tmp/repo',
    baseBranch: 'main',
    branch: 'scode/abcd1234-add-login-page',
    worktree: '/tmp/repo/.git/scode-worktrees/abcd1234',
    backend: 'codex-a',
    status: 'active',
    createdAt: '2026-11-19T10:00:00.000Z',
    updatedAt: '2026-11-19T10:00:00.000Z',
    turns: 2,
    briefs: ['Add login page', 'Also add logout'],
    ...overrides,
  };
}

test('threads: slugifyTitle kebabs, truncates, falls back', () => {
  assert.equal(slugifyTitle('Add login page!'), 'add-login-page');
  assert.equal(slugifyTitle('Fix the Über-bug (urgent)'), 'fix-the-ber-bug-urgent');
  assert.equal(slugifyTitle('a'.repeat(50)), 'a'.repeat(30));
  assert.equal(slugifyTitle('!!!'), 'thread');
});

test('threads: threadTitle truncates long briefs', () => {
  assert.equal(threadTitle('Short'), 'Short');
  assert.equal(threadTitle(`${'x'.repeat(70)}\nsecond line`), `${'x'.repeat(57)}…`);
  assert.equal(threadTitle(''), 'Untitled thread');
});

test('threads: findThread matches exact, prefix, and rejects ambiguous/missing', () => {
  const threads = [fakeThread({ id: 'abcd1234' }), fakeThread({ id: 'abef5678', title: 'Other' })];
  assert.equal(findThread(threads, 'abcd1234').title, 'Add login page');
  assert.equal(findThread(threads, 'abcd').id, 'abcd1234');
  assert.throws(() => findThread(threads, 'ab'), /Ambiguous/);
  assert.throws(() => findThread(threads, 'zzzz'), /No thread matches/);
});

test('threads: renderThreadList groups active and closed', () => {
  const lines = renderThreadList([
    fakeThread(),
    fakeThread({ id: 'deadbeef', title: 'Old work', status: 'closed', prUrl: 'https://github.com/x/y/pull/3' }),
  ]);
  const text = lines.join('\n');
  assert.match(text, /Active threads:/);
  assert.match(text, /abcd1234  Add login page/);
  assert.match(text, /Closed threads:/);
  assert.match(text, /PR: https:\/\/github\.com\/x\/y\/pull\/3/);
  assert.deepEqual(renderThreadList([]), ['No threads yet. Start one with `scode thread new "<task>"`.']);
});

test('threads: renderThreadStatus shows the thread facts', () => {
  const lines = renderThreadStatus(fakeThread({ prUrl: 'https://github.com/x/y/pull/3' }));
  assert.match(lines.join('\n'), /branch: scode\/abcd1234-add-login-page \(from main\)/);
  assert.match(lines.join('\n'), /turns: 2/);
  assert.match(lines.join('\n'), /PR: https:\/\/github\.com\/x\/y\/pull\/3/);
});

test('threads: createThread makes a branch, worktree, and store entry', async () => {
  await withTempHome(async () => {
    const repo = await fixtureRepo();
    const thread = await createThread('Add login page', { cwd: repo });
    assert.equal(thread.baseBranch, 'main');
    assert.match(thread.branch, /^scode\/[0-9a-f]{8}-add-login-page$/);
    const branches = await git(['branch', '--list'], repo);
    assert.match(branches, new RegExp(thread.branch.replace('/', '\\/')));
    const worktrees = await git(['worktree', 'list'], repo);
    assert.match(worktrees, new RegExp(thread.branch.replace('/', '\\/')));
    const stored = await loadThreads();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.id, thread.id);
    // Prompt pack seeded into the worktree.
    const { access } = await import('node:fs/promises');
    await access(join(thread.worktree, 'AGENTS.md'));
    // Close it.
    const closed = await closeThread(thread.id);
    assert.equal(closed.status, 'closed');
  });
});

test('threads: createThread refuses outside a repo', async () => {
  await withTempHome(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scode-not-a-repo-'));
    await assert.rejects(() => createThread('Do a thing', { cwd: dir }), /not inside one/);
  });
});
