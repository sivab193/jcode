/**
 * Review and ship a thread: `scode diff` shows the thread's change against
 * its base branch, `scode pr` commits, pushes, and opens a pull request in
 * one step (T3's one-button PR flow, without the model-generated prose —
 * titles and bodies are deterministic from the thread and its diff).
 *
 * PR creation uses the GitHub CLI (`gh pr create`) with the user's own
 * sign-in. When `gh` is missing or the create fails, the push still stands
 * and the exact manual command is printed — the work is never lost.
 */
import { execFile } from 'node:child_process';
import type { Thread } from './threads.js';
import { setThreadPr } from './threads.js';
import { execGit } from './worktree.js';

export interface FileChange {
  path: string;
  insertions: number;
  deletions: number;
}

export interface ThreadDiff {
  /** Committed changes on the thread branch vs its base. */
  committed: FileChange[];
  /** Uncommitted changes (git status --short lines). */
  uncommitted: string[];
  /** Full unified diff: committed vs base, then uncommitted vs HEAD. */
  diffText: string;
  insertions: number;
  deletions: number;
}

export function parseNumstat(text: string): FileChange[] {
  const files: FileChange[] = [];
  for (const line of text.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!match) continue;
    files.push({
      path: match[3] as string,
      insertions: match[1] === '-' ? 0 : Number(match[1]),
      deletions: match[2] === '-' ? 0 : Number(match[2]),
    });
  }
  return files;
}

const MAX_DIFF_CHARS = 200_000;

export async function threadDiff(thread: Thread): Promise<ThreadDiff> {
  const base = `${thread.baseBranch}...HEAD`;
  const numstat = await execGit(['diff', '--numstat', base], thread.worktree);
  const committed = numstat.exitCode === 0 ? parseNumstat(numstat.stdout) : [];
  const status = await execGit(['status', '--short'], thread.worktree);
  const uncommitted = status.exitCode === 0
    ? status.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
    : [];
  const committedDiff = await execGit(['diff', base], thread.worktree);
  const uncommittedDiff = await execGit(['diff', 'HEAD'], thread.worktree);
  let diffText = '';
  if (committedDiff.exitCode === 0 && committedDiff.stdout.trim()) {
    diffText += committedDiff.stdout;
  }
  if (uncommittedDiff.exitCode === 0 && uncommittedDiff.stdout.trim()) {
    if (diffText) diffText += '\n';
    diffText += uncommittedDiff.stdout;
  }
  if (diffText.length > MAX_DIFF_CHARS) {
    diffText = `${diffText.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated at ${MAX_DIFF_CHARS} chars; run git diff in the worktree for the rest)`;
  }
  const insertions = committed.reduce((sum, f) => sum + f.insertions, 0);
  const deletions = committed.reduce((sum, f) => sum + f.deletions, 0);
  return { committed, uncommitted, diffText, insertions, deletions };
}

export function renderDiffSummary(diff: ThreadDiff, thread: Thread): string[] {
  const lines: string[] = [`${thread.id}  ${thread.title}`, `  branch: ${thread.branch} (base: ${thread.baseBranch})`];
  if (diff.committed.length === 0 && diff.uncommitted.length === 0) {
    lines.push('  No changes yet — the branch matches its base and the worktree is clean.');
    return lines;
  }
  if (diff.committed.length > 0) {
    lines.push(`  Committed vs ${thread.baseBranch}: ${diff.committed.length} file${diff.committed.length === 1 ? '' : 's'}, +${diff.insertions} −${diff.deletions}`);
    for (const file of diff.committed) {
      lines.push(`    +${file.insertions} −${file.deletions}  ${file.path}`);
    }
  }
  if (diff.uncommitted.length > 0) {
    lines.push(`  Uncommitted (${diff.uncommitted.length}):`);
    for (const line of diff.uncommitted) lines.push(`    ${line}`);
  }
  return lines;
}

/** Deterministic commit message from the thread and its diff. */
export function generateCommitMessage(thread: Thread, diff: ThreadDiff): string {
  const files = diff.committed.map((f) => f.path);
  const header = thread.title;
  const body = [
    '',
    `Thread ${thread.id} (${thread.turns} turn${thread.turns === 1 ? '' : 's'}), routed by scode.`,
    '',
    `Changed: ${files.length > 0 ? files.join(', ') : 'uncommitted work in progress'}`,
    `+${diff.insertions} −${diff.deletions} vs ${thread.baseBranch}`,
  ];
  return [header, ...body].join('\n');
}

/** PR body for a dry run: uncommitted files are listed without counts. */
export function previewPrBody(thread: Thread, diff: ThreadDiff): { title: string; body: string } {
  const title = thread.title;
  const lines: string[] = [
    thread.briefs[0] ? thread.briefs[0] : thread.title,
    '',
    '## Changes',
    '',
    `+${diff.insertions} −${diff.deletions} across ${diff.committed.length} committed file${diff.committed.length === 1 ? '' : 's'} (vs \`${thread.baseBranch}\`).`,
    '',
  ];
  for (const file of diff.committed) {
    lines.push(`- \`${file.path}\` (+${file.insertions} −${file.deletions})`);
  }
  const uncommittedPaths = diff.uncommitted.map((line) => line.replace(/^\?\?\s+/, '').trim()).filter(Boolean);
  if (uncommittedPaths.length > 0) {
    lines.push('', `${uncommittedPaths.length} uncommitted file${uncommittedPaths.length === 1 ? '' : 's'} (would be committed first):`);
    for (const path of uncommittedPaths) lines.push(`- \`${path}\` (uncommitted)`);
  }
  lines.push('', '---', 'Created with [scode](https://github.com/sivab193/scode).');
  return { title, body: lines.join('\n') };
}

/** Deterministic PR title + body from the thread and its diff. */
export function generatePrBody(thread: Thread, diff: ThreadDiff): { title: string; body: string } {
  const title = thread.title;
  const lines: string[] = [
    thread.briefs[0] ? thread.briefs[0] : thread.title,
    '',
    '## Changes',
    '',
    `+${diff.insertions} −${diff.deletions} across ${diff.committed.length} file${diff.committed.length === 1 ? '' : 's'} (vs \`${thread.baseBranch}\`).`,
    '',
  ];
  for (const file of diff.committed) {
    lines.push(`- \`${file.path}\` (+${file.insertions} −${file.deletions})`);
  }
  if (thread.turns > 1) {
    lines.push('', `Built over ${thread.turns} turns on thread \`${thread.id}\`.`);
  }
  lines.push('', '---', 'Created with [scode](https://github.com/sivab193/scode).');
  return { title, body: lines.join('\n') };
}

export interface PrOutcome {
  pushed: boolean;
  committed: boolean;
  prUrl: string | null;
  /** The manual command to finish the PR when `gh` could not. */
  manualCommand: string | null;
  detail: string;
}

function ghAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('gh', ['--version'], { timeout: 10_000, windowsHide: true }, (error) => {
      resolve(!error || (error as NodeJS.ErrnoException).code !== 'ENOENT');
    });
  });
}

/**
 * Ship a thread: commit uncommitted work, push the branch, open the PR.
 * Dry run prints every step without running it. Returns the outcome —
 * a missing `gh` (or a failed create) leaves the push in place and hands
 * back the exact manual command instead of failing the whole flow.
 */
export async function createPr(
  thread: Thread,
  options?: { draft?: boolean; dryRun?: boolean },
): Promise<PrOutcome> {
  const diff = await threadDiff(thread);
  if (diff.committed.length === 0 && diff.uncommitted.length === 0) {
    throw new Error(`Thread ${thread.id} has no changes to ship.`);
  }
  const prArgsFor = (title: string, body: string): string[] => {
    const args = ['pr', 'create', '--base', thread.baseBranch, '--head', thread.branch, '--title', title, '--body', body];
    if (options?.draft) args.push('--draft');
    return args;
  };
  const manualFor = (args: string[]): string =>
    `gh ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;

  if (options?.dryRun) {
    const preview = previewPrBody(thread, diff);
    const manualCommand = manualFor(prArgsFor(preview.title, preview.body));
    const steps = [
      diff.uncommitted.length > 0 ? `git add -A && git commit -m ${JSON.stringify(generateCommitMessage(thread, diff))}` : null,
      `git push -u origin ${thread.branch}`,
      manualCommand,
    ].filter((step): step is string => step !== null);
    return {
      pushed: false,
      committed: false,
      prUrl: null,
      manualCommand,
      detail: `Dry run — would run in ${thread.worktree}:\n${steps.map((s) => `  ${s}`).join('\n')}`,
    };
  }

  // Fail fast: a missing remote means the push cannot happen, so do not
  // create a commit the user did not ask to keep.
  const remote = await execGit(['remote', 'get-url', 'origin'], thread.worktree);
  if (remote.exitCode !== 0 || !remote.stdout.trim()) {
    throw new Error('No origin remote — push the repo somewhere first (git remote add origin <url>).');
  }

  let committed = false;
  if (diff.uncommitted.length > 0) {
    const add = await execGit(['add', '-A'], thread.worktree);
    if (add.exitCode !== 0) throw new Error(`git add failed: ${add.stderr.trim().split('\n')[0] ?? ''}`);
    const commit = await execGit(['commit', '-m', generateCommitMessage(thread, diff)], thread.worktree);
    if (commit.exitCode !== 0) {
      throw new Error(`git commit failed: ${(commit.stderr || commit.stdout).trim().split('\n')[0] ?? ''}`);
    }
    committed = true;
  }

  const push = await execGit(['push', '-u', 'origin', thread.branch], thread.worktree);
  if (push.exitCode !== 0) {
    throw new Error(`git push failed: ${(push.stderr || push.stdout).trim().split('\n').slice(-1)[0] ?? ''}`);
  }

  // The body describes the change as it now stands — re-diff after the
  // commit so uncommitted work is counted, not shown as 0 files.
  const finalDiff = await threadDiff(thread);
  const { title, body } = generatePrBody(thread, finalDiff);
  const prArgs = prArgsFor(title, body);
  const manualCommand = manualFor(prArgs);

  if (!(await ghAvailable())) {
    return {
      pushed: true,
      committed,
      prUrl: null,
      manualCommand,
      detail: `Pushed ${thread.branch}, but gh is not installed — finish the PR with:\n  ${manualCommand}`,
    };
  }
  const pr = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve) => {
    execFile('gh', prArgs, { cwd: thread.worktree, timeout: 120_000, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: error ? (error as { code?: number }).code ?? 1 : 0 });
    });
  });
  if (pr.exitCode !== 0) {
    return {
      pushed: true,
      committed,
      prUrl: null,
      manualCommand,
      detail: `Pushed ${thread.branch}, but gh pr create failed: ${(pr.stderr || pr.stdout).trim().split('\n')[0] ?? ''}\nFinish it with:\n  ${manualCommand}`,
    };
  }
  const prUrl = pr.stdout.trim().split('\n').find((line) => line.startsWith('http')) ?? null;
  if (prUrl) await setThreadPr(thread.id, prUrl);
  return {
    pushed: true,
    committed,
    prUrl,
    manualCommand: null,
    detail: prUrl ? `PR opened: ${prUrl}` : 'PR created (gh did not print a URL).',
  };
}
