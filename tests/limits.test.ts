import test from 'node:test';
import assert from 'node:assert/strict';
import {
  elapsedShare,
  formatDuration,
  formatResetsIn,
  limitBar,
  normalizeWindows,
  paceOf,
  remainingPercent,
  renderLimits,
  sortWindows,
  type QuotaWindowDetail,
} from '../dist/core/limits.js';
import type { BackendSnapshot } from '../dist/core/types.js';

// Fixed clock: 2026-11-19 12:00:00 UTC.
const NOW = Date.parse('2026-11-19T12:00:00.000Z');

function window(overrides: Partial<QuotaWindowDetail>): QuotaWindowDetail {
  return {
    id: 'primary',
    kind: 'session',
    label: 'Session',
    usedPercent: 64,
    resetsAt: new Date(NOW + 91 * 60_000).toISOString(), // 1h 31m out
    windowMinutes: 300,
    ...overrides,
  };
}

test('limits: windows sort session, weekly, monthly, other, then id', () => {
  const sorted = sortWindows([
    window({ id: 'individual', kind: 'monthly', label: 'Monthly credit limit' }),
    window({ id: 'secondary', kind: 'weekly', label: 'Weekly' }),
    window({ id: 'primary', kind: 'session', label: 'Session' }),
    window({ id: 'zzz', kind: 'other', label: 'Quota' }),
  ]);
  assert.deepEqual(sorted.map((w) => w.id), ['primary', 'secondary', 'individual', 'zzz']);
});

test('limits: remaining is 100 minus used, clamped', () => {
  assert.equal(remainingPercent(window({ usedPercent: 64 })), 36);
  assert.equal(remainingPercent(window({ usedPercent: 0 })), 100);
  assert.equal(remainingPercent(window({ usedPercent: 120 })), 0);
});

test('limits: elapsed share is time passed over window length', () => {
  // 5h window, reset 2.5h out => half elapsed.
  assert.equal(elapsedShare(window({ resetsAt: new Date(NOW + 150 * 60_000).toISOString() }), NOW), 0.5);
  assert.equal(elapsedShare(window({ resetsAt: null }), NOW), null);
  assert.equal(elapsedShare(window({ windowMinutes: null }), NOW), null);
});

test('limits: pace compares used against elapsed with a 5 point band', () => {
  const half = window({ resetsAt: new Date(NOW + 150 * 60_000).toISOString() });
  assert.equal(paceOf({ ...half, usedPercent: 64 }, NOW), 'ahead'); // 14 ahead
  assert.equal(paceOf({ ...half, usedPercent: 36 }, NOW), 'under'); // 14 behind
  assert.equal(paceOf({ ...half, usedPercent: 52 }, NOW), 'on'); // within the band
  assert.equal(paceOf(window({ resetsAt: null }), NOW), null);
});

test('limits: durations and reset countdowns read like T3', () => {
  assert.equal(formatDuration(36 * 60_000), '36m');
  assert.equal(formatDuration(91 * 60_000), '1h 31m');
  assert.equal(formatDuration((4 * 24 + 15) * 3600_000), '4d 15h');
  assert.equal(formatResetsIn(new Date(NOW + 91 * 60_000).toISOString(), NOW), '↻ 1h 31m');
  assert.equal(formatResetsIn(new Date(NOW - 1000).toISOString(), NOW), 'resets now');
  assert.equal(formatResetsIn(null, NOW), null);
});

test('limits: bar fills with remaining and ticks the even-pace position', () => {
  // 36% left of 16 cells = 6 filled; half elapsed => tick at index 7.
  const bar = limitBar(window({ usedPercent: 64, resetsAt: new Date(NOW + 150 * 60_000).toISOString() }), 16, NOW);
  assert.equal(bar, '██████░|░░░░░░░░');
  // No reset known => no tick.
  assert.equal(limitBar(window({ usedPercent: 50, resetsAt: null }), 10, NOW), '█████░░░░░');
});

test('limits: normalize accepts probe windows and top-level-only quota', () => {
  const fromProbe = normalizeWindows({
    remainingFraction: 0.18, resetsAt: null, windowMinutes: 10080,
    source: 'probe', observedAt: new Date(NOW).toISOString(),
    windows: [
      { name: 'primary', remainingFraction: 0.36, resetsAt: new Date(NOW + 91 * 60_000).toISOString(), windowMinutes: 300 },
      { name: 'secondary', remainingFraction: 0.18, resetsAt: null, windowMinutes: 10080 },
      { name: 'individualLimit', remainingFraction: 0.9, resetsAt: null, windowMinutes: 43200 },
      { name: 'seven_day_opus', remainingFraction: 0.55, resetsAt: null, windowMinutes: 10080 },
    ],
  });
  assert.equal(fromProbe.length, 4);
  assert.equal(fromProbe[0]?.label, 'Session');
  assert.equal(fromProbe[0]?.usedPercent, 64);
  assert.equal(fromProbe.find((w) => w.id === 'individualLimit')?.label, 'Monthly credit limit');
  assert.equal(fromProbe.find((w) => w.id === 'seven_day_opus')?.label, 'Weekly · Opus');

  // Manual entry / kiro: no windows array, synthesize one from the top level.
  const fromTop = normalizeWindows({
    remainingFraction: 0.5, resetsAt: null, windowMinutes: null,
    source: 'manual', observedAt: new Date(NOW).toISOString(),
  });
  assert.equal(fromTop.length, 1);
  assert.equal(fromTop[0]?.label, 'Quota');

  // Unknown: nothing to show.
  assert.deepEqual(normalizeWindows({
    remainingFraction: null, resetsAt: null, windowMinutes: null,
    source: 'placeholder', observedAt: new Date(NOW).toISOString(),
  }), []);
});

function snapshot(overrides: Partial<BackendSnapshot>): BackendSnapshot {
  return {
    id: 'codex-a',
    status: 'available',
    model: 'vendor default',
    quota: {
      remainingFraction: null, resetsAt: null, windowMinutes: null,
      source: 'placeholder', observedAt: new Date(NOW).toISOString(),
    },
    cliPresent: true,
    ...overrides,
  };
}

test('limits: render shows every window, reset credits, and honest unknowns', () => {
  const lines = renderLimits([
    snapshot({
      quota: {
        remainingFraction: 0.18,
        resetsAt: new Date(NOW + 4 * 24 * 3600_000 + 15 * 3600_000).toISOString(),
        windowMinutes: 10080,
        source: 'probe',
        observedAt: new Date(NOW - 2 * 60_000).toISOString(),
        windows: [
          { name: 'primary', remainingFraction: 0.36, resetsAt: new Date(NOW + 91 * 60_000).toISOString(), windowMinutes: 300 },
          { name: 'secondary', remainingFraction: 0.18, resetsAt: new Date(NOW + (4 * 24 + 15) * 3600_000).toISOString(), windowMinutes: 10080 },
        ],
        resetCredits: { availableCount: 2 },
      },
    }),
    snapshot({ id: 'copilot', status: 'available', note: 'quota unknown' }),
    snapshot({ id: 'claude', status: 'disabled', note: 'Claude Pro not confirmed', cliPresent: false }),
  ], new Date(NOW));
  const text = lines.join('\n');
  assert.match(text, /Codex · account A — updated 2m ago/);
  assert.match(text, /Session\s+36% left/);
  assert.match(text, /↻ 1h 31m/);
  assert.match(text, /Weekly\s+18% left/);
  assert.match(text, /↻ 4d 15h/);
  assert.match(text, /Reset credits: 2 available/);
  assert.match(text, /Copilot\n  quota unknown/);
  assert.match(text, /Claude — disabled \(Claude Pro not confirmed\)/);
});
