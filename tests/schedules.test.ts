import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addSchedule,
  dueSchedules,
  findSchedule,
  installHint,
  loadSchedules,
  nextRunAfter,
  parseDuration,
  removeSchedule,
  runDueSchedules,
  setScheduleEnabled,
  validateCron,
  type Schedule,
} from '../dist/core/schedules.js';
import type { RunResult } from '../dist/core/types.js';

function fakeResult(success = true): RunResult {
  return {
    taskId: 't1', backend: 'codex-a', startedAt: '2026-11-18T12:00:00.000Z',
    finishedAt: '2026-11-18T12:01:00.000Z', durationMs: 60000, exitCode: 0,
    signal: null, success, errorClass: success ? null : 'backend-error',
  };
}

async function withTempHome(fn: () => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'scode-schedules-'));
  const savedHome = process.env.SCODE_HOME;
  process.env.SCODE_HOME = dir;
  try {
    await fn();
  } finally {
    if (savedHome === undefined) delete process.env.SCODE_HOME;
    else process.env.SCODE_HOME = savedHome;
  }
}

test('schedules: parseDuration handles units and combos', () => {
  assert.equal(parseDuration('30m'), 30 * 60 * 1000);
  assert.equal(parseDuration('2h'), 2 * 60 * 60 * 1000);
  assert.equal(parseDuration('1d'), 24 * 60 * 60 * 1000);
  assert.equal(parseDuration('90s'), 90 * 1000);
  assert.equal(parseDuration('1h30m'), 90 * 60 * 1000);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('1w'), null);
});

test('schedules: nextRunAfter follows cron in local time', () => {
  // Wednesday Nov 18, 2026, noon local — next 9am weekday is Thursday 9am.
  const from = new Date(2026, 10, 18, 12, 0, 0);
  const next = nextRunAfter({ kind: 'cron', cron: '0 9 * * 1-5' }, from);
  assert.ok(next);
  const date = new Date(next);
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 10);
  assert.equal(date.getDate(), 19);
  assert.equal(date.getHours(), 9);
  assert.equal(date.getMinutes(), 0);
});

test('schedules: nextRunAfter for one-shot returns the time only when future', () => {
  const from = new Date('2026-11-18T12:00:00Z');
  assert.equal(nextRunAfter({ kind: 'once', at: '2026-11-20T09:00:00Z' }, from), '2026-11-20T09:00:00.000Z');
  assert.equal(nextRunAfter({ kind: 'once', at: '2026-11-18T11:00:00Z' }, from), null);
});

test('schedules: validateCron rejects garbage', () => {
  assert.throws(() => validateCron('not a cron'));
  assert.doesNotThrow(() => validateCron('*/5 * * * *'));
});

test('schedules: add + load round-trip, and past one-shot is rejected', async () => {
  await withTempHome(async () => {
    const created = await addSchedule({ brief: 'review open PRs', cron: '0 9 * * 1-5', now: new Date(2026, 10, 18, 12, 0, 0) });
    assert.equal(created.id.length, 8);
    assert.equal(created.kind, 'cron');
    assert.equal(created.enabled, true);
    assert.ok(created.nextRunAt);
    const once = await addSchedule({ brief: 'ping me', inMs: 60 * 60 * 1000, now: new Date('2026-11-18T12:00:00Z') });
    assert.equal(once.kind, 'once');
    assert.equal(once.nextRunAt, '2026-11-18T13:00:00.000Z');
    const all = await loadSchedules();
    assert.equal(all.length, 2);
    await assert.rejects(
      addSchedule({ brief: 'too late', at: '2026-11-18T11:00:00Z', now: new Date('2026-11-18T12:00:00Z') }),
      /already past/,
    );
  });
});

test('schedules: find/remove/enable by unique prefix', async () => {
  await withTempHome(async () => {
    const first = await addSchedule({ brief: 'one', cron: '0 9 * * *', now: new Date(2026, 10, 18, 12, 0, 0) });
    const all = await loadSchedules();
    assert.equal(findSchedule(all, first.id.slice(0, 4)).id, first.id);
    assert.throws(() => findSchedule(all, 'zzzz'), /No schedule matches/);
    const disabled = await setScheduleEnabled(first.id, false);
    assert.equal(disabled.enabled, false);
    const removed = await removeSchedule(first.id.slice(0, 6));
    assert.equal(removed.id, first.id);
    assert.equal((await loadSchedules()).length, 0);
  });
});

test('schedules: due detection skips disabled, future, and mid-run entries', () => {
  const now = new Date('2026-11-18T12:00:00Z');
  const base: Schedule = {
    id: 'aaaa0001', brief: 'x', cwd: '/tmp', kind: 'cron', cron: '0 9 * * *',
    enabled: true, createdAt: now.toISOString(), lastRunAt: null,
    nextRunAt: '2026-11-18T11:00:00Z', runCount: 0, runningSince: null,
  };
  const list: Schedule[] = [
    base,
    { ...base, id: 'aaaa0002', enabled: false },
    { ...base, id: 'aaaa0003', nextRunAt: '2026-11-18T13:00:00Z' },
    { ...base, id: 'aaaa0004', runningSince: '2026-11-18T11:30:00Z' },
    { ...base, id: 'aaaa0005', runningSince: '2026-11-18T09:00:00Z' }, // stale (>2h) — due again
  ];
  const due = dueSchedules(list, now).map((item) => item.id);
  assert.deepEqual(due, ['aaaa0001', 'aaaa0005']);
});

test('schedules: tick fires due jobs, advances cron, disables one-shot', async () => {
  await withTempHome(async () => {
    // Local noon: cron times are local, so the tick time must be local too.
    const now = new Date(2026, 10, 18, 12, 0, 0);
    const cron = await addSchedule({ brief: 'daily review', cron: '0 9 * * *', now: new Date(2026, 10, 17, 12, 0, 0) });
    const once = await addSchedule({ brief: 'one ping', at: '2026-11-18T11:00:00Z', now: new Date('2026-11-18T10:00:00Z') });
    const seen: string[] = [];
    let calls = 0;
    const result = await runDueSchedules({
      now,
      dispatchFn: async (schedule) => {
        calls += 1;
        seen.push(schedule.id);
        return fakeResult(true);
      },
      onStart: ({ jobId, schedule }) => seen.push(`start:${jobId}:${schedule.id}`),
      onFinish: ({ jobId }, runResult) => seen.push(`finish:${jobId}:${runResult.success}`),
    });
    assert.equal(calls, 2);
    assert.equal(result.fired.length, 2);
    assert.ok(result.fired.every((item) => item.success));
    assert.ok(seen.some((entry) => entry.startsWith(`start:sch-${cron.id}-`)));
    const after = await loadSchedules();
    const cronAfter = after.find((item) => item.id === cron.id) as Schedule;
    const onceAfter = after.find((item) => item.id === once.id) as Schedule;
    assert.equal(cronAfter.runCount, 1);
    assert.equal(cronAfter.enabled, true);
    assert.ok(cronAfter.nextRunAt && Date.parse(cronAfter.nextRunAt) > now.getTime());
    assert.equal(onceAfter.runCount, 1);
    assert.equal(onceAfter.enabled, false);
    assert.equal(onceAfter.nextRunAt, null);
    // A second tick right away fires nothing — the one-shot is done and the
    // cron's next run is tomorrow.
    const again = await runDueSchedules({ now, dispatchFn: async () => fakeResult(true) });
    assert.equal(again.fired.length, 0);
  });
});

test('schedules: dry-run fires nothing and leaves the store alone', async () => {
  await withTempHome(async () => {
    // Local noon: cron times are local, so the tick time must be local too.
    const now = new Date(2026, 10, 18, 12, 0, 0);
    await addSchedule({ brief: 'x', cron: '0 9 * * *', now: new Date(2026, 10, 17, 12, 0, 0) });
    let calls = 0;
    const result = await runDueSchedules({ now, dryRun: true, dispatchFn: async () => { calls += 1; return fakeResult(true); } });
    assert.equal(calls, 0);
    assert.equal(result.dryRun, true);
    assert.equal(result.fired.length, 1);
    const after = await loadSchedules();
    assert.equal(after[0].runCount, 0);
    assert.equal(after[0].runningSince, null);
  });
});

test('schedules: a throwing dispatch still advances the schedule (no re-fire loop)', async () => {
  await withTempHome(async () => {
    // Local noon: cron times are local, so the tick time must be local too.
    const now = new Date(2026, 10, 18, 12, 0, 0);
    const created = await addSchedule({ brief: 'x', cron: '0 9 * * *', now: new Date(2026, 10, 17, 12, 0, 0) });
    const result = await runDueSchedules({
      now,
      dispatchFn: async () => { throw new Error('no backend is available'); },
    });
    assert.equal(result.fired.length, 1);
    assert.equal(result.fired[0].success, false);
    const after = await loadSchedules();
    assert.equal(after[0].runCount, 1);
    assert.equal(after[0].runningSince, null);
    assert.ok(after[0].nextRunAt && Date.parse(after[0].nextRunAt) > now.getTime());
    assert.equal(created.id, after[0].id);
  });
});

test('schedules: cancellation reaches the active dispatch and stops later due jobs', async () => {
  await withTempHome(async () => {
    const now = new Date(2026, 10, 18, 12, 0, 0);
    await addSchedule({ brief: 'first', cron: '0 9 * * *', now: new Date(2026, 10, 17, 12, 0, 0) });
    await addSchedule({ brief: 'second', cron: '0 9 * * *', now: new Date(2026, 10, 17, 12, 0, 0) });
    const controller = new AbortController();
    let calls = 0;
    const result = await runDueSchedules({
      now,
      signal: controller.signal,
      dispatchFn: async (_schedule, _onOutput, signal) => {
        calls += 1;
        assert.equal(signal, controller.signal);
        controller.abort();
        return { ...fakeResult(false), errorClass: 'cancelled', exitCode: 143 };
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.fired.length, 1);
    assert.equal(result.fired[0].success, false);
  });
});

test('schedules: install hint is per-platform', () => {
  assert.match(installHint('win32'), /schtasks/);
  assert.match(installHint('linux'), /crontab -e/);
  assert.match(installHint('darwin'), /crontab -e/);
});
