import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPr,
  generateCommitMessage,
  generatePrBody,
  parseNumstat,
  renderDiffSummary,
  threadDiff,
} from '../dist/core/pr.js';
import { createThread } from '../dist/core/threads.js';

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.toString() || error.message));
      else resolvePromise(stdout.toString());
    });
  });
}

async function withTempHome(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'scode-pr-test-'));
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
  const dir = await mkdtemp(join(tmpdir(), 'scode-pr-repo-'));
  await git(['init', '-b', 'main'], dir);
  await git(['config', 'user.name', 'Test'], dir);
  await git(['config', 'user.email', 'test@example.com'], dir);
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\n');
  await git(['add', '.'], dir);
  await git(['commit', '-m', 'initial'], dir);
  return dir;
}

test('pr: parseNumstat reads insertions/deletions, binaries, and skips garbage', () => {
  const files = parseNumstat('12\t3\tsrc/a.ts\n-\t-\tlogo.png\nnot a line\n0\t5\tREADME.md\n');
  assert.deepEqual(files, [
    { path: 'src/a.ts', insertions: 12, deletions: 3 },
    { path: 'logo.png', insertions: 0, deletions: 0 },
    { path: 'README.md', insertions: 0, deletions: 5 },
  ]);
});

test('pr: generateCommitMessage and generatePrBody are deterministic', () => {
  const thread = {
    id: 'abcd1234', title: 'Add login page', repoCwd: '/tmp/r', baseBranch: 'main',
    branch: 'scode/abcd1234-add-login-page', worktree: '/tmp/r/.git/scode-worktrees/abcd1234',
    backend: 'codex-a' as const, status: 'active' as const,
    createdAt: '', updatedAt: '', turns: 2, briefs: ['Add login page', 'Also add logout'],
  };
  const diff = {
    committed: [{ path: 'src/login.ts', insertions: 40, deletions: 2 }],
    uncommitted: [] as string[], diffText: '', insertions: 40, deletions: 2,
  };
  const message = generateCommitMessage(thread, diff);
  assert.match(message, /^Add login page\n/);
  assert.match(message, /Thread abcd1234 \(2 turns\)/);
  const { title, body } = generatePrBody(thread, diff);
  assert.equal(title, 'Add login page');
  assert.match(body, /Add login page/);
  assert.match(body, /`src\/login\.ts` \(\+40 −2\)/);
  assert.match(body, /Built over 2 turns/);
});

test('pr: threadDiff sees committed and uncommitted changes', async () => {
  await withTempHome(async () => {
    const repo = await fixtureRepo();
    const thread = await createThread('Change a file', { cwd: repo });
    // Drop the seeded prompt pack so the diff is exactly what we create.
    await git(['clean', '-fd'], thread.worktree);
    // Committed change in the worktree.
    await writeFile(join(thread.worktree, 'a.txt'), 'one\ntwo\nthree\n');
    await git(['add', 'a.txt'], thread.worktree);
    await git(['commit', '-m', 'add three'], thread.worktree);
    // Uncommitted change on top.
    await writeFile(join(thread.worktree, 'b.txt'), 'new file\n');
    const diff = await threadDiff(thread);
    assert.equal(diff.committed.length, 1);
    assert.equal(diff.committed[0]?.path, 'a.txt');
    assert.equal(diff.committed[0]?.insertions, 1);
    assert.equal(diff.uncommitted.length, 1);
    assert.match(diff.uncommitted[0] ?? '', /b\.txt/);
    assert.match(diff.diffText, /three/);
    const summary = renderDiffSummary(diff, thread).join('\n');
    assert.match(summary, /Committed vs main: 1 file, \+1 −0/);
    assert.match(summary, /Uncommitted \(1\)/);
  });
});

test('pr: createPr dry-run prints steps without running them', async () => {
  await withTempHome(async () => {
    const repo = await fixtureRepo();
    const thread = await createThread('Change a file', { cwd: repo });
    await writeFile(join(thread.worktree, 'a.txt'), 'one\ntwo\nthree\n');
    const outcome = await createPr(thread, { dryRun: true });
    assert.equal(outcome.pushed, false);
    assert.equal(outcome.prUrl, null);
    assert.match(outcome.detail, /Dry run/);
    assert.match(outcome.detail, /git push -u origin/);
    assert.match(outcome.detail, /gh pr create/);
    assert.match(outcome.manualCommand ?? '', /gh pr create/);
    // Nothing was committed or pushed.
    const log = await git(['log', '--oneline'], thread.worktree);
    assert.equal(log.trim().split('\n').length, 1);
  });
});

test('pr: createPr refuses an unchanged thread', async () => {
  await withTempHome(async () => {
    const repo = await fixtureRepo();
    const thread = await createThread('Do nothing', { cwd: repo });
    // The prompt pack seeds files into the worktree — remove them so the
    // thread is genuinely unchanged.
    await git(['clean', '-fd'], thread.worktree);
    await assert.rejects(() => createPr(thread, { dryRun: true }), /no changes to ship/);
  });
});
