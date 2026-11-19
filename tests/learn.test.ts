import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLedger, joinRuns, renderLearnReport } from '../dist/core/learn.js';

function started(taskId: string, backend: string, brief: string, type: string) {
  return {
    event: 'run-started', taskId, backend, brief,
    classification: { taskClass: type, difficulty: 'medium', reason: 'test' },
  };
}

function finished(taskId: string, backend: string, success: boolean, options: {
  durationMs?: number;
  inputTokens?: number;
  cavemanWrapped?: boolean;
  stdoutTail?: string;
  finishedAt?: string;
  errorClass?: string | null;
} = {}) {
  return {
    event: 'run-finished', taskId, backend, success,
    errorClass: options.errorClass ?? (success ? null : 'backend-error'),
    durationMs: options.durationMs ?? 60_000,
    usage: options.inputTokens !== undefined ? { inputTokens: options.inputTokens, outputTokens: 500 } : undefined,
    cavemanWrapped: options.cavemanWrapped ?? false,
    finishedAt: options.finishedAt ?? '2026-11-18T12:00:00.000Z',
    stdoutTail: options.stdoutTail ?? '',
  };
}

test('learn: empty ledger reports honestly', () => {
  const analysis = analyzeLedger([], []);
  assert.equal(analysis.totalRuns, 0);
  assert.equal(analysis.overallSuccessRate, null);
  assert.match(renderLearnReport(analysis), /No runs in the ledger yet/);
});

test('learn: joins finished runs to started classifications', () => {
  const records = [
    started('t1', 'codex-a', 'fix the bug', 'backend'),
    finished('t1', 'codex-a', true, { inputTokens: 1000 }),
    started('t2', 'kiro', 'add AWS lambda', 'aws'),
    finished('t2', 'kiro', false),
  ];
  const runs = joinRuns(records as never);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].classType, 'backend');
  assert.equal(runs[1].classType, 'aws');
  const analysis = analyzeLedger(records as never, []);
  assert.equal(analysis.totalRuns, 2);
  assert.equal(analysis.overallSuccessRate, 0.5);
  const codex = analysis.classStats.find((s) => s.backend === 'codex-a');
  assert.equal(codex?.successRate, 1);
  assert.equal(codex?.meanInputTokens, 1000);
});

test('learn: proposes deprioritizing a weak backend when a better one exists', () => {
  const records = [];
  for (let i = 0; i < 3; i++) {
    records.push(started(`k${i}`, 'kiro', 'aws task', 'aws'), finished(`k${i}`, 'kiro', i === 0));
  }
  for (let i = 0; i < 3; i++) {
    records.push(started(`c${i}`, 'codex-a', 'aws task', 'aws'), finished(`c${i}`, 'codex-a', true));
  }
  const analysis = analyzeLedger(records as never, []);
  assert.ok(analysis.proposals.some((p) => p.includes('deprioritizing kiro') && p.includes('codex-a')));
});

test('learn: flags tasks retried 3+ times', () => {
  const records = [];
  for (let i = 0; i < 3; i++) {
    records.push(started('retry-task', i === 2 ? 'codex-a' : 'kiro', 'hard task', 'backend'));
    records.push(finished('retry-task', i === 2 ? 'codex-a' : 'kiro', i === 2));
  }
  const analysis = analyzeLedger(records as never, []);
  assert.equal(analysis.retries.length, 1);
  assert.equal(analysis.retries[0].runs, 3);
  assert.equal(analysis.retries[0].finalSuccess, true);
  assert.ok(analysis.proposals.some((p) => p.includes('retry-task')));
});

test('learn: caveman comparison needs 2 runs each side', () => {
  const records = [];
  for (let i = 0; i < 3; i++) {
    records.push(started(`on${i}`, 'codex-a', 'task', 'backend'), finished(`on${i}`, 'codex-a', true, { inputTokens: 600, cavemanWrapped: true }));
    records.push(started(`off${i}`, 'codex-a', 'task', 'backend'), finished(`off${i}`, 'codex-a', true, { inputTokens: 1000, cavemanWrapped: false }));
  }
  const analysis = analyzeLedger(records as never, []);
  assert.equal(analysis.caveman.length, 1);
  assert.equal(analysis.caveman[0].inputTokenChangePct, -40);
  assert.ok(analysis.proposals.some((p) => p.includes('Caveman on codex-a') && p.includes('40% fewer')));
});

test('learn: tool backlog heuristic counts workaround patterns', () => {
  const records = [];
  for (let i = 0; i < 3; i++) {
    records.push(started(`g${i}`, 'codex-a', 'task', 'backend'));
    records.push(finished(`g${i}`, 'codex-a', true, { stdoutTail: 'ran git log --oneline -20 and git diff --stat' }));
  }
  const analysis = analyzeLedger(records as never, []);
  assert.equal(analysis.toolBacklog.length, 1);
  assert.match(analysis.toolBacklog[0].pattern, /git history/);
  assert.equal(analysis.toolBacklog[0].occurrences, 3);
});

test('learn: dead tools need 30 days of history', () => {
  const now = new Date('2026-11-18T12:00:00Z');
  // Only 5 days of history — no dead-tool verdict.
  const young = [{ timestamp: '2026-11-13T12:00:00Z', tool: 'file-peek', ok: true }];
  const youngAnalysis = analyzeLedger([], young, now);
  assert.deepEqual(youngAnalysis.deadTools, []);
  assert.equal(youngAnalysis.toolHistoryDays, 5);
  // 40 days of history; file-peek and pdf-read called recently, latex-build
  // and graph-query never called.
  const old = [
    { timestamp: '2026-10-09T12:00:00Z', tool: 'file-peek', ok: true },
    { timestamp: '2026-11-17T12:00:00Z', tool: 'file-peek', ok: true },
    { timestamp: '2026-11-17T12:00:00Z', tool: 'pdf-read', ok: true },
  ];
  const oldAnalysis = analyzeLedger([], old, now);
  assert.deepEqual(oldAnalysis.deadTools, ['latex-build', 'graph-query', 'thread-list', 'thread-status', 'thread-diff']);
});

test('learn: prompt patterns need 5 runs per side and 10pp delta', () => {
  const records = [];
  for (let i = 0; i < 5; i++) {
    records.push(started(`w${i}`, 'codex-a', 'add tests for the parser', 'backend'), finished(`w${i}`, 'codex-a', true));
    records.push(started(`x${i}`, 'codex-a', 'change the parser', 'backend'), finished(`x${i}`, 'codex-a', i < 2));
  }
  const analysis = analyzeLedger(records as never, []);
  const pattern = analysis.promptPatterns.find((p) => p.feature === 'mentions tests');
  assert.ok(pattern);
  assert.equal(pattern.deltaPp, 60);
});

test('learn: cancelled runs are skipped, not counted as failures', () => {
  const records = [
    started('c1', 'codex-a', 'task one', 'general'),
    finished('c1', 'codex-a', false, { errorClass: 'cancelled' }),
    started('c2', 'codex-a', 'task two', 'general'),
    finished('c2', 'codex-a', true),
  ];
  const runs = joinRuns(records as never);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].taskId, 'c2');
  assert.equal(analyzeLedger(records as never, []).totalRuns, 1);
});
