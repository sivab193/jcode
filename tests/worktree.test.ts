import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, gitRoot, removeWorktree, worktreeHasChanges } from '../dist/core/worktree.js';

function git(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd }, (error) => (error ? reject(error) : resolve()));
  });
}

test('worktree: creates an isolated worktree and removes it', async () => {
  const repo = join(tmpdir(), `scode-wt-test-${Date.now()}`);
  await mkdir(repo, { recursive: true });
  try {
    await git(['init', '-b', 'main'], repo);
    await git(['config', 'user.email', 'test@scode.local'], repo);
    await git(['config', 'user.name', 'scode test'], repo);
    await writeFile(join(repo, 'a.txt'), 'hello\n');
    await git(['add', '.'], repo);
    await git(['commit', '-m', 'init'], repo);

    assert.equal(await realpath((await gitRoot(repo)) as string), await realpath(repo));
    const worktree = await createWorktree('test-task-1', repo);
    assert.equal(worktree.isWorktree, true);
    assert.equal((await readFile(join(worktree.path, 'a.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'hello\n');
    assert.equal(await worktreeHasChanges(worktree), false);
    await mkdir(join(worktree.path, '.kiro', 'steering'), { recursive: true });
    await writeFile(join(worktree.path, '.kiro', 'steering', 'scode.md'), 'seeded\n');
    assert.equal(await worktreeHasChanges(worktree, ['.kiro/steering/scode.md']), false);
    await writeFile(join(worktree.path, 'a.txt'), 'changed\n');
    assert.equal(await worktreeHasChanges(worktree), true);
    assert.equal(await worktreeHasChanges(worktree, ['a.txt', '.kiro/steering/scode.md']), false);
    await removeWorktree(worktree, repo);
    await assert.rejects(readFile(join(worktree.path, 'a.txt'), 'utf8'));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('worktree: falls back to cwd outside a git repo', async () => {
  const dir = join(tmpdir(), `scode-wt-plain-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    assert.equal(await gitRoot(dir), null);
    const worktree = await createWorktree('test-task-2', dir);
    assert.equal(worktree.isWorktree, false);
    assert.equal(worktree.path, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
