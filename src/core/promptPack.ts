/**
 * The repo-root prompt pack (handoff §8, "Shared context"): one brief
 * template plus per-backend steering translations and a shared lessons file.
 *
 * - `formatBrief()` wraps the user's brief in the template (brief verbatim
 *   under `## Task`, working rules below). The ledger still records the raw
 *   brief, so the learn loop analyses what the user actually wrote.
 * - `installPromptPack()` seeds a job's worktree with AGENTS.md (codex/agy),
 *   CLAUDE.md (claude), `.kiro/steering/scode.md` (kiro) and SCODE_NOTES.md
 *   (shared lessons) — but only when the target repo does not already have
 *   that file. It never overwrites the repo's own steering.
 *
 * The seeded files are part of the job's diff, so the user reviews them like
 * any other change. The pack is installed only into real git worktrees, never
 * into a bare cwd fallback (no review step there).
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function formatBrief(brief: string): string {
  return [
    '## Task',
    '',
    brief,
    '',
    '## Working rules',
    '',
    '- Work in this repository. If SCODE_NOTES.md exists here, read it first — it',
    '  carries the lessons from earlier runs.',
    '- Do not invent data, files, or results. Say plainly what you could not verify.',
    '- Keep the change minimal and scoped to the task. Do not refactor unrelated code.',
    '- Run the project\'s checks for what you touched and report what passed and',
    '  what failed.',
    '',
  ].join('\n');
}

const PACK_FILES: { src: string; dest: string }[] = [
  { src: 'AGENTS.md', dest: 'AGENTS.md' },
  { src: 'CLAUDE.md', dest: 'CLAUDE.md' },
  { src: 'SCODE_NOTES.md', dest: 'SCODE_NOTES.md' },
  { src: 'kiro-steering.md', dest: '.kiro/steering/scode.md' },
];

function packSource(name: string): string {
  // Compiled code lives in dist/core/; the pack ships at the repo root.
  return fileURLToPath(new URL(`../../prompts/${name}`, import.meta.url));
}

export async function installPromptPack(worktreeDir: string): Promise<{ installed: string[]; skipped: string[] }> {
  const installed: string[] = [];
  const skipped: string[] = [];
  for (const file of PACK_FILES) {
    const dest = join(worktreeDir, file.dest);
    try {
      await access(dest);
      skipped.push(file.dest); // repo already has its own — never overwrite
      continue;
    } catch {
      // Absent: seed it.
    }
    try {
      const content = await readFile(packSource(file.src), 'utf-8');
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, content, 'utf-8');
      installed.push(file.dest);
    } catch {
      // A missing or unreadable pack file must never fail a job.
      skipped.push(file.dest);
    }
  }
  return { installed, skipped };
}
