/**
 * The lessons store (Phase 5 scope: "report, lessons store, weekly fold").
 *
 * `scode learn` writes the full report to learn-report.md (overwritten each
 * fold) AND appends a dated entry here, to ~/.scode/lessons.md. The store is
 * append-only: it is the durable record of what each fold concluded, so a
 * later fold — or the user — can see what was proposed, what was acted on,
 * and whether the numbers moved. Entries are short on purpose: the snapshot
 * numbers plus the proposals, nothing else.
 *
 * Cadence: run `scode learn` weekly. The report answers "what is true now";
 * this file answers "what did we learn, and when".
 */
import { appendFile } from 'node:fs/promises';
import { ensureStateHome, statePaths } from '../config.js';
import type { LearnAnalysis } from './learn.js';

/** One fold's entry. Pure — tested. */
export function formatLessonEntry(analysis: LearnAnalysis): string {
  const lines: string[] = [
    `## ${analysis.generatedAt.slice(0, 10)}`,
    '',
    `Fold over ${analysis.totalRuns} ${analysis.totalRuns === 1 ? 'run' : 'runs'} across ${analysis.totalTasks} ${analysis.totalTasks === 1 ? 'task' : 'tasks'}` +
    (analysis.overallSuccessRate !== null ? `, overall success ${Math.round(analysis.overallSuccessRate * 100)}%` : '') +
    '.',
    '',
  ];
  const best = [...analysis.classStats]
    .filter((stats) => stats.runs >= 3)
    .sort((a, b) => b.successRate - a.successRate)[0];
  const worst = [...analysis.classStats]
    .filter((stats) => stats.runs >= 3)
    .sort((a, b) => a.successRate - b.successRate)[0];
  if (best) {
    lines.push(`Strongest measured pair: ${best.backend}/${best.classType} (${best.successes}/${best.runs}).`);
  }
  if (worst && worst !== best) {
    lines.push(`Weakest measured pair: ${worst.backend}/${worst.classType} (${worst.successes}/${worst.runs}).`);
  }
  if (best || worst) lines.push('');
  if (analysis.proposals.length > 0) {
    lines.push('Proposals made:');
    for (const proposal of analysis.proposals) lines.push(`- ${proposal}`);
  } else {
    lines.push('No proposals — the numbers did not support a change.');
  }
  lines.push('', '---', '');
  return lines.join('\n');
}

export async function appendLessonEntry(analysis: LearnAnalysis): Promise<string> {
  await ensureStateHome();
  const path = statePaths().lessons;
  await appendFile(path, formatLessonEntry(analysis), 'utf-8');
  return path;
}
