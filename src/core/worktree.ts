/**
 * One git worktree per job (handoff §5): parallel jobs never share a working
 * tree, and a failed job's worktree is kept for inspection and resume.
 * Falls back to running in cwd when cwd is not inside a git repo.
 */
import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Run git in `cwd`. Exported for the PR module's diff/commit/push steps. */
export function execGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 60_000, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: error ? (error as { code?: number }).code ?? 1 : 0 });
    });
  });
}

export async function gitRoot(cwd: string): Promise<string | null> {
  const { stdout, exitCode } = await execGit(['rev-parse', '--show-toplevel'], cwd);
  if (exitCode !== 0) return null;
  return stdout.trim() || null;
}

export interface Worktree {
  path: string;
  /** True when this is a real git worktree (vs a cwd fallback). */
  isWorktree: boolean;
  /** scode-seeded context files excluded from the agent-edit signal. */
  ignoredPaths?: string[];
}

/**
 * Create a worktree for `taskId` at <repo>/.git/scode-worktrees/<taskId>,
 * branched off the current HEAD. Returns a cwd fallback when not in a repo.
 */
export async function createWorktree(taskId: string, cwd: string): Promise<Worktree> {  const root = await gitRoot(cwd);
  if (!root) return { path: cwd, isWorktree: false };
  const base = join(root, '.git', 'scode-worktrees');
  await mkdir(base, { recursive: true }).catch(() => undefined);
  const path = join(base, taskId);
  const { exitCode, stderr } = await execGit(['worktree', 'add', '--detach', path, 'HEAD'], root);
  if (exitCode !== 0) {
    // Worktree creation failed (e.g. dirty index edge cases) — run in cwd
    // rather than failing the job; the ledger records the fallback.
    console.error(`[scode] worktree create failed, running in cwd: ${stderr.trim().split('\n')[0] ?? ''}`);
    return { path: cwd, isWorktree: false };
  }
  return { path, isWorktree: true };
}

/** The current branch of the repo containing `cwd` (null outside a repo or on a detached HEAD). */
export async function currentBranch(cwd: string): Promise<string | null> {
  const { stdout, exitCode } = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (exitCode !== 0) return null;
  const branch = stdout.trim();
  return branch && branch !== 'HEAD' ? branch : null;
}

/**
 * Create a worktree on a REAL branch: `git worktree add -b <branch> <path>
 * <base>`. Threads use this (T3-style: each thread has its own branch);
 * one-shot jobs use the detached `createWorktree` instead. Throws when git
 * refuses — thread creation must not silently fall back to cwd.
 */
export async function createBranchWorktree(
  branch: string,
  base: string,
  path: string,
  repoRoot: string,
): Promise<Worktree> {
  const { exitCode, stderr } = await execGit(['worktree', 'add', '-b', branch, path, base], repoRoot);
  if (exitCode !== 0) {
    throw new Error(`git worktree add failed: ${(stderr.trim().split('\n')[0] ?? '').trim()}`);
  }
  return { path, isWorktree: true };
}

/** Remove a worktree. Kept jobs (failures) are removed only when asked. */
export async function removeWorktree(worktree: Worktree, repoCwd: string): Promise<void> {
  if (!worktree.isWorktree) return;
  const root = await gitRoot(repoCwd);
  if (root) {
    const { exitCode } = await execGit(['worktree', 'remove', '--force', worktree.path], root);
    if (exitCode === 0) return;
  }
  await rm(worktree.path, { recursive: true, force: true });
}

/** True when an agent changed tracked, staged, or untracked files. */
export async function worktreeHasChanges(worktree: Worktree, ignoredPaths: string[] = []): Promise<boolean> {
  if (!worktree.isWorktree) return false;
  const { stdout, exitCode } = await execGit(['status', '--porcelain', '--untracked-files=all'], worktree.path);
  if (exitCode !== 0) return false;
  const ignored = new Set(ignoredPaths);
  return stdout.split('\n').some((line) => {
    if (!line.trim()) return false;
    const path = line.slice(3).split(' -> ').at(-1) ?? '';
    return !ignored.has(path);
  });
}

/** Scratch dir for smoke tests and other throwaway work. */
export function tempDir(label: string): string {
  return join(tmpdir(), `scode-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}
