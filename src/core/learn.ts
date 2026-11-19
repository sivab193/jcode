/**
 * Phase 5 — the learning loop (handoff §9).
 *
 * `scode learn` folds the ledger into a report. It answers, from real runs:
 * 1. Per (backend, task class): success rate, median time, tokens, quota cost.
 * 2. Token autopsy: mean tokens per (class, backend), tasks retried 3+ times,
 *    and Caveman on vs off per backend.
 * 3. Prompt patterns: which brief features correlate with success.
 * 4. Tool backlog: what agents hand-rolled instead of calling a tool
 *    (heuristic scan of output tails) + dead tools (no calls in 30 days).
 * 5. What to tweak: proposed classifier/policy edits, with the numbers.
 *
 * Proposals are presented, never auto-applied — edits are his, manually or
 * by PR. Small samples are labeled as such; nothing is claimed from n < 3.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { ensureStateHome, statePaths } from '../config.js';
import { appendLessonEntry } from './lessons.js';
import { TOOL_NAMES } from '../mcp/tools.js';
import type { TaskClass } from './classifier.js';
import type { BackendId } from './types.js';

export interface JoinedRun {
  taskId: string;
  backend: BackendId;
  classType: TaskClass;
  effort: string;
  brief: string;
  success: boolean;
  errorClass: string | null;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  premiumRequests?: number;
  totalCostUsd?: number;
  cavemanWrapped: boolean;
  finishedAt: string;
  stdoutTail: string;
}

export interface ClassStats {
  backend: BackendId;
  classType: TaskClass;
  runs: number;
  successes: number;
  successRate: number;
  medianDurationMs: number;
  meanInputTokens: number | null;
  meanOutputTokens: number | null;
  meanCostUsd: number | null;
  totalPremiumRequests: number;
}

export interface CavemanComparison {
  backend: BackendId;
  onRuns: number;
  offRuns: number;
  onMeanInputTokens: number | null;
  offMeanInputTokens: number | null;
  inputTokenChangePct: number | null;
  onSuccessRate: number | null;
  offSuccessRate: number | null;
}

export interface RetryTask {
  taskId: string;
  runs: number;
  backends: BackendId[];
  finalSuccess: boolean;
  brief: string;
}

export interface PromptPattern {
  feature: string;
  withRuns: number;
  withSuccessRate: number;
  withoutRuns: number;
  withoutSuccessRate: number;
  deltaPp: number;
}

export interface ToolBacklogCandidate {
  pattern: string;
  suggestion: string;
  occurrences: number;
}

export interface LearnAnalysis {
  generatedAt: string;
  totalRuns: number;
  totalTasks: number;
  overallSuccessRate: number | null;
  dateRange: { from: string; to: string } | null;
  classStats: ClassStats[];
  caveman: CavemanComparison[];
  retries: RetryTask[];
  promptPatterns: PromptPattern[];
  toolBacklog: ToolBacklogCandidate[];
  deadTools: string[];
  toolHistoryDays: number | null;
  proposals: string[];
}

interface LedgerRecord {
  event?: string;
  taskId?: string;
  backend?: BackendId;
  brief?: string;
  classification?: { taskClass?: TaskClass; difficulty?: string };
  success?: boolean;
  errorClass?: string | null;
  durationMs?: number;
  usage?: { inputTokens?: number; outputTokens?: number; premiumRequests?: number; totalCostUsd?: number };
  cavemanWrapped?: boolean;
  finishedAt?: string;
  stdoutTail?: string;
}

/** Join run-finished records to their run-started classification by task+backend. */
export function joinRuns(records: LedgerRecord[]): JoinedRun[] {
  const started = new Map<string, LedgerRecord>();
  for (const record of records) {
    if (record.event === 'run-started' && record.taskId && record.backend) {
      started.set(`${record.taskId}:${record.backend}`, record);
    }
  }
  const runs: JoinedRun[] = [];
  for (const record of records) {
    if (record.event !== 'run-finished' || !record.taskId || !record.backend) continue;
    // A cancelled run is the user stopping the job, not a backend outcome —
    // counting it as a failure would teach the router the wrong lesson.
    if (record.errorClass === 'cancelled') continue;
    const start = started.get(`${record.taskId}:${record.backend}`);
    runs.push({
      taskId: record.taskId,
      backend: record.backend,
      classType: start?.classification?.taskClass ?? 'general',
      effort: start?.classification?.difficulty ?? 'unknown',
      brief: start?.brief ?? '',
      success: record.success ?? false,
      errorClass: record.errorClass ?? null,
      durationMs: record.durationMs ?? 0,
      inputTokens: record.usage?.inputTokens,
      outputTokens: record.usage?.outputTokens,
      premiumRequests: record.usage?.premiumRequests,
      totalCostUsd: record.usage?.totalCostUsd,
      cavemanWrapped: record.cavemanWrapped ?? false,
      finishedAt: record.finishedAt ?? '',
      stdoutTail: record.stdoutTail ?? '',
    });
  }
  return runs;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mean(values: Array<number | undefined>): number | null {
  const defined = values.filter((value): value is number => typeof value === 'number');
  if (defined.length === 0) return null;
  return defined.reduce((sum, value) => sum + value, 0) / defined.length;
}

const WORKAROUND_PATTERNS: Array<{ pattern: RegExp; label: string; suggestion: string }> = [
  { pattern: /pdftotext|pdftk|PyPDF2|pdfplumber|pypdf/i, label: 'hand-rolled PDF text extraction', suggestion: 'pdf-read already exists — briefs may need to mention it' },
  { pattern: /latexmk|pdflatex|xelatex/i, label: 'hand-rolled LaTeX builds', suggestion: 'latex-build already exists — briefs may need to mention it' },
  { pattern: /sed -n|head -n|tail -n|awk 'NR/, label: 'shell line-slicing instead of file-peek', suggestion: 'file-peek already exists — briefs may need to mention it' },
  { pattern: /git log --|git diff --stat|git show /i, label: 'hand-rolled git history reads', suggestion: 'consider a git-history tool (log/diff/show in one call)' },
  { pattern: /jq\s+['"]?\./, label: 'jq JSON munging', suggestion: 'consider a json-query tool' },
  { pattern: /curl .*api\.|wget .*api\./i, label: 'hand-rolled API calls', suggestion: 'consider per-API tools if one endpoint repeats' },
];

const BRIEF_FEATURES: Array<{ label: string; test: (brief: string) => boolean }> = [
  { label: 'mentions tests', test: (brief) => /\btests?\b/i.test(brief) },
  { label: 'mentions docs', test: (brief) => /\bdocs?\b|documentation/i.test(brief) },
  { label: 'mentions a file path', test: (brief) => /[\w./-]+\.(ts|tsx|js|py|md|json|tex)\b/.test(brief) },
  { label: 'long brief (>200 chars)', test: (brief) => brief.length > 200 },
  { label: 'mentions refactor', test: (brief) => /refactor/i.test(brief) },
  { label: 'mentions fix/bug', test: (brief) => /\bfix\b|\bbug\b/i.test(brief) },
];

export interface ToolCallEntry {
  timestamp: string;
  tool: string;
  ok: boolean;
}

export function analyzeLedger(records: LedgerRecord[], toolCalls: ToolCallEntry[], now: Date = new Date()): LearnAnalysis {
  const runs = joinRuns(records);
  const tasks = new Set(runs.map((run) => run.taskId));
  const finishedDates = runs.map((run) => run.finishedAt).filter((date) => date !== '').sort();

  // Per (backend, class) stats.
  const byClass = new Map<string, JoinedRun[]>();
  for (const run of runs) {
    const key = `${run.backend}:${run.classType}`;
    byClass.set(key, [...(byClass.get(key) ?? []), run]);
  }
  const classStats: ClassStats[] = [...byClass.entries()].map(([key, group]) => {
    const [backend, classType] = key.split(':') as [BackendId, TaskClass];
    const successes = group.filter((run) => run.success).length;
    return {
      backend,
      classType,
      runs: group.length,
      successes,
      successRate: group.length > 0 ? successes / group.length : 0,
      medianDurationMs: Math.round(median(group.map((run) => run.durationMs))),
      meanInputTokens: mean(group.map((run) => run.inputTokens)),
      meanOutputTokens: mean(group.map((run) => run.outputTokens)),
      meanCostUsd: mean(group.map((run) => run.totalCostUsd)),
      totalPremiumRequests: group.reduce((sum, run) => sum + (run.premiumRequests ?? 0), 0),
    };
  }).sort((a, b) => b.runs - a.runs);

  // Caveman on vs off per backend (needs >= 2 runs on each side).
  const caveman: CavemanComparison[] = [];
  const byBackend = new Map<BackendId, JoinedRun[]>();
  for (const run of runs) byBackend.set(run.backend, [...(byBackend.get(run.backend) ?? []), run]);
  for (const [backend, group] of byBackend) {
    const on = group.filter((run) => run.cavemanWrapped);
    const off = group.filter((run) => !run.cavemanWrapped);
    if (on.length < 2 || off.length < 2) continue;
    const onMean = mean(on.map((run) => run.inputTokens));
    const offMean = mean(off.map((run) => run.inputTokens));
    caveman.push({
      backend,
      onRuns: on.length,
      offRuns: off.length,
      onMeanInputTokens: onMean,
      offMeanInputTokens: offMean,
      inputTokenChangePct: onMean !== null && offMean !== null && offMean > 0
        ? Math.round(((onMean - offMean) / offMean) * 1000) / 10
        : null,
      onSuccessRate: on.filter((run) => run.success).length / on.length,
      offSuccessRate: off.filter((run) => run.success).length / off.length,
    });
  }

  // Tasks retried 3+ times.
  const byTask = new Map<string, JoinedRun[]>();
  for (const run of runs) byTask.set(run.taskId, [...(byTask.get(run.taskId) ?? []), run]);
  const retries: RetryTask[] = [...byTask.entries()]
    .filter(([, group]) => group.length >= 3)
    .map(([taskId, group]) => ({
      taskId,
      runs: group.length,
      backends: [...new Set(group.map((run) => run.backend))],
      finalSuccess: group[group.length - 1].success,
      brief: group[0].brief,
    }))
    .sort((a, b) => b.runs - a.runs);

  // Prompt patterns (needs >= 5 runs on each side; report |delta| >= 10pp).
  const promptPatterns: PromptPattern[] = [];
  for (const feature of BRIEF_FEATURES) {
    const withRuns = runs.filter((run) => feature.test(run.brief));
    const withoutRuns = runs.filter((run) => !feature.test(run.brief));
    if (withRuns.length < 5 || withoutRuns.length < 5) continue;
    const withRate = withRuns.filter((run) => run.success).length / withRuns.length;
    const withoutRate = withoutRuns.filter((run) => run.success).length / withoutRuns.length;
    const deltaPp = Math.round((withRate - withoutRate) * 1000) / 10;
    if (Math.abs(deltaPp) >= 10) {
      promptPatterns.push({
        feature: feature.label,
        withRuns: withRuns.length,
        withSuccessRate: withRate,
        withoutRuns: withoutRuns.length,
        withoutSuccessRate: withoutRate,
        deltaPp,
      });
    }
  }

  // Tool backlog: heuristic scan of output tails (one count per run per pattern).
  const toolBacklog: ToolBacklogCandidate[] = [];
  for (const { pattern, label, suggestion } of WORKAROUND_PATTERNS) {
    const occurrences = runs.filter((run) => pattern.test(run.stdoutTail)).length;
    if (occurrences >= 3) toolBacklog.push({ pattern: label, suggestion, occurrences });
  }

  // Dead tools: no calls in the last 30 days (needs 30 days of history to judge).
  const callDates = toolCalls.map((call) => new Date(call.timestamp).getTime()).filter((time) => !Number.isNaN(time));
  const oldestCall = callDates.length > 0 ? Math.min(...callDates) : null;
  const toolHistoryDays = oldestCall !== null ? Math.floor((now.getTime() - oldestCall) / 86_400_000) : null;
  const deadTools: string[] = [];
  if (toolHistoryDays !== null && toolHistoryDays >= 30) {
    const cutoff = now.getTime() - 30 * 86_400_000;
    for (const tool of TOOL_NAMES) {
      const recent = toolCalls.some((call) => call.tool === tool && new Date(call.timestamp).getTime() >= cutoff);
      if (!recent) deadTools.push(tool);
    }
  }

  // Proposals (presented, never auto-applied).
  const proposals: string[] = [];
  for (const stats of classStats) {
    if (stats.runs < 3 || stats.successRate > 1 / 3) continue;
    const better = classStats.find((other) =>
      other.classType === stats.classType && other.backend !== stats.backend
      && other.runs >= 3 && other.successRate >= 0.8);
    if (better) {
      proposals.push(
        `Consider deprioritizing ${stats.backend} for ${stats.classType} ` +
        `(${stats.successes}/${stats.runs} succeeded) in favor of ${better.backend} ` +
        `(${better.successes}/${better.runs}). Edit src/core/policy.ts preferences.`,
      );
    }
  }
  for (const stats of classStats) {
    if (stats.runs >= 5 && stats.successRate === 1) {
      proposals.push(`${stats.backend} is ${stats.runs}/${stats.runs} on ${stats.classType} — already the reliable pick; no change needed.`);
    }
  }
  for (const retry of retries) {
    proposals.push(
      `Task ${retry.taskId} ran ${retry.runs} times across ${retry.backends.join(', ')} ` +
      `and ${retry.finalSuccess ? 'eventually succeeded' : 'still failed'} — consider decomposing the brief or raising its effort class.`,
    );
  }
  for (const comparison of caveman) {
    if (comparison.inputTokenChangePct !== null && comparison.inputTokenChangePct <= -15
      && (comparison.onSuccessRate ?? 0) >= (comparison.offSuccessRate ?? 0) - 0.1) {
      proposals.push(
        `Caveman on ${comparison.backend}: ${Math.abs(comparison.inputTokenChangePct)}% fewer input tokens ` +
        `(${comparison.onRuns} on / ${comparison.offRuns} off runs) with similar success — consider enabling it for more backends.`,
      );
    }
    if ((comparison.onSuccessRate ?? 1) < (comparison.offSuccessRate ?? 0) - 0.2) {
      proposals.push(
        `Caveman on ${comparison.backend}: success dropped from ${Math.round((comparison.offSuccessRate ?? 0) * 100)}% to ` +
        `${Math.round((comparison.onSuccessRate ?? 0) * 100)}% — consider disabling it there.`,
      );
    }
  }
  for (const candidate of toolBacklog) {
    proposals.push(`Agents ${candidate.pattern} ${candidate.occurrences} times — ${candidate.suggestion}.`);
  }
  for (const tool of deadTools) {
    proposals.push(`Tool ${tool} has had no calls in 30 days — consider removing it or checking its wiring.`);
  }

  return {
    generatedAt: now.toISOString(),
    totalRuns: runs.length,
    totalTasks: tasks.size,
    overallSuccessRate: runs.length > 0 ? runs.filter((run) => run.success).length / runs.length : null,
    dateRange: finishedDates.length > 0 ? { from: finishedDates[0], to: finishedDates[finishedDates.length - 1] } : null,
    classStats,
    caveman,
    retries,
    promptPatterns,
    toolBacklog,
    deadTools,
    toolHistoryDays,
    proposals,
  };
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${Math.round(value * 100)}%`;
}

function tokens(value: number | null): string {
  return value === null ? 'n/a' : Math.round(value).toLocaleString('en-US');
}

export function renderLearnReport(analysis: LearnAnalysis): string {
  const lines: string[] = [
    '# scode learn report',
    '',
    `Generated ${analysis.generatedAt}.`,
    '',
    `Runs: ${analysis.totalRuns} across ${analysis.totalTasks} tasks` +
    (analysis.overallSuccessRate !== null ? `, overall success ${pct(analysis.overallSuccessRate)}` : '') +
    (analysis.dateRange ? `, ${analysis.dateRange.from.slice(0, 10)} to ${analysis.dateRange.to.slice(0, 10)}` : '') +
    '.',
    '',
  ];
  if (analysis.totalRuns === 0) {
    lines.push('No runs in the ledger yet — dispatch some tasks, then run `scode learn` again.', '');
    return lines.join('\n');
  }
  lines.push('## Per backend × task class', '');
  lines.push('| backend | class | runs | success | median time | mean in tokens | mean out tokens | mean cost | premium req |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const stats of analysis.classStats) {
    lines.push(`| ${stats.backend} | ${stats.classType} | ${stats.runs} | ${pct(stats.successRate)} | ${Math.round(stats.medianDurationMs / 1000)}s | ${tokens(stats.meanInputTokens)} | ${tokens(stats.meanOutputTokens)} | ${stats.meanCostUsd === null ? 'n/a' : `$${stats.meanCostUsd.toFixed(4)}`} | ${stats.totalPremiumRequests} |`);
  }
  lines.push('');
  const measured = analysis.classStats.filter((stats) => stats.runs >= 20);
  lines.push(measured.length > 0
    ? `Measured pairs (≥20 runs — Phase 6 scoring is active for these): ${measured.map((stats) => `${stats.backend}/${stats.classType}`).join(', ')}.`
    : 'No (backend, class) pair has 20 runs yet — scoring stays on the rule-based order until one does.');
  lines.push('');
  if (analysis.caveman.length > 0) {
    lines.push('## Caveman on vs off', '');
    for (const comparison of analysis.caveman) {
      lines.push(`- ${comparison.backend}: ${comparison.onRuns} on / ${comparison.offRuns} off runs; ` +
        `input tokens ${comparison.inputTokenChangePct === null ? 'n/a' : `${comparison.inputTokenChangePct > 0 ? '+' : ''}${comparison.inputTokenChangePct}%`} on vs off; ` +
        `success ${pct(comparison.onSuccessRate)} on vs ${pct(comparison.offSuccessRate)} off.`);
    }
    lines.push('');
  }
  if (analysis.retries.length > 0) {
    lines.push('## Tasks retried 3+ times', '');
    for (const retry of analysis.retries) {
      lines.push(`- ${retry.taskId}: ${retry.runs} runs (${retry.backends.join(', ')}), final: ${retry.finalSuccess ? 'success' : 'failure'} — "${retry.brief.slice(0, 80)}"`);
    }
    lines.push('');
  }
  if (analysis.promptPatterns.length > 0) {
    lines.push('## Prompt patterns', '');
    for (const pattern of analysis.promptPatterns) {
      lines.push(`- Briefs that ${pattern.feature}: ${pct(pattern.withSuccessRate)} success (n=${pattern.withRuns}) vs ${pct(pattern.withoutSuccessRate)} without (n=${pattern.withoutRuns}) — ${pattern.deltaPp > 0 ? '+' : ''}${pattern.deltaPp}pp.`);
    }
    lines.push('');
  }
  if (analysis.toolBacklog.length > 0) {
    lines.push('## Tool backlog (heuristic — from output tails)', '');
    for (const candidate of analysis.toolBacklog) {
      lines.push(`- ${candidate.pattern}: ${candidate.occurrences} runs — ${candidate.suggestion}.`);
    }
    lines.push('');
  }
  if (analysis.deadTools.length > 0) {
    lines.push(`## Dead tools\n\nNo calls in 30 days: ${analysis.deadTools.join(', ')}.\n`);
  } else if (analysis.toolHistoryDays !== null && analysis.toolHistoryDays < 30) {
    lines.push(`Tool-call history is only ${analysis.toolHistoryDays} days old — dead-tool detection needs 30 days.\n`);
  }
  lines.push('## Proposed tweaks (presented, not applied)', '');
  if (analysis.proposals.length === 0) {
    lines.push('Nothing to propose yet — the numbers do not support a change.');
  } else {
    for (const proposal of analysis.proposals) lines.push(`- ${proposal}`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function runLearn(): Promise<number> {
  await ensureStateHome();
  const paths = statePaths();
  let records: LedgerRecord[] = [];
  try {
    const text = await readFile(paths.ledger, 'utf-8');
    records = text.split('\n').filter((line) => line.trim() !== '').map((line) => {
      try {
        return JSON.parse(line) as LedgerRecord;
      } catch {
        return {};
      }
    });
  } catch {
    records = [];
  }
  let toolCalls: ToolCallEntry[] = [];
  try {
    const text = await readFile(paths.toolCalls, 'utf-8');
    toolCalls = text.split('\n').filter((line) => line.trim() !== '').map((line) => {
      try {
        return JSON.parse(line) as ToolCallEntry;
      } catch {
        return { timestamp: '', tool: '', ok: false };
      }
    });
  } catch {
    toolCalls = [];
  }
  const analysis = analyzeLedger(records, toolCalls);
  const report = renderLearnReport(analysis);
  await writeFile(paths.learnReport, report, 'utf-8');
  const lessonsPath = await appendLessonEntry(analysis);
  console.log(report);
  console.log(`Report written to ${paths.learnReport}`);
  console.log(`Fold appended to the lessons store at ${lessonsPath}`);
  return 0;
}
