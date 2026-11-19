import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeRateLimits, parseCodexRateLimits, parseCodexResetFromMessage, parseKiroUsage } from '../dist/core/probes.js';

test('codex probe: parses windows and picks the tightest as binding', () => {
  const parsed = parseCodexRateLimits({
    jsonrpc: '2.0',
    id: 1,
    result: {
      rateLimits: {
        '5h': { usedPercent: 80, windowMinutes: 300, resetsAt: '2026-11-18T20:00:00.000Z' },
        weekly: { usedPercent: 10, windowMinutes: 10080, resetsAt: '2026-11-24T00:00:00.000Z' },
      },
    },
  });
  assert.ok(parsed);
  assert.equal(parsed.remainingFraction, 0.2);
  assert.equal(parsed.windowMinutes, 300);
  assert.equal(parsed.resetsAt, '2026-11-18T20:00:00.000Z');
  assert.equal(parsed.windows?.length, 2);
});

test('codex probe: handles a missing 5h window (suspended for many accounts)', () => {
  const parsed = parseCodexRateLimits({
    result: { rateLimits: { weekly: { usedPercent: 40, windowMinutes: 10080, resetsAt: null } } },
  });
  assert.ok(parsed);
  assert.equal(parsed.remainingFraction, 0.6);
  assert.equal(parsed.windowMinutes, 10080);
});

test('codex probe: parses current primary/secondary windows and Unix reset seconds', () => {
  const parsed = parseCodexRateLimits({
    id: 2,
    result: {
      rateLimits: {
        primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1795061920 },
        secondary: { usedPercent: 35, windowDurationMins: 10080, resetsAt: 1795509096 },
      },
    },
  });
  assert.ok(parsed);
  assert.equal(parsed.remainingFraction, 0.65);
  assert.equal(parsed.windowMinutes, 10080);
  assert.equal(parsed.resetsAt, new Date(1795509096 * 1000).toISOString());
});

test('codex probe: returns null on garbage', () => {
  assert.equal(parseCodexRateLimits({ result: {} }), null);
  assert.equal(parseCodexRateLimits(null), null);
  assert.equal(parseCodexRateLimits('not json'), null);
});

test('codex probe: parses the T3-shaped snapshot (primary/secondary/individual + reset credits)', () => {
  const resetEpoch = 1794000000; // epoch seconds, as the app-server returns them
  const parsed = parseCodexRateLimits({
    jsonrpc: '2.0',
    id: 1,
    result: {
      rateLimits: {
        limitId: 'codex',
        planType: 'plus',
        primary: { usedPercent: 64, windowDurationMins: 300, resetsAt: resetEpoch },
        secondary: { usedPercent: 82, windowDurationMins: 10080, resetsAt: resetEpoch + 3600 },
        individualLimit: { remainingPercent: 90, resetsAt: resetEpoch + 7200 },
      },
      resetCredits: {
        availableCount: 2,
        credits: [
          { status: 'available', expiresAt: resetEpoch + 86400 },
          { status: 'used', expiresAt: resetEpoch + 100 },
        ],
      },
    },
  });
  assert.ok(parsed);
  assert.equal(parsed.planType, 'plus');
  assert.equal(parsed.windows?.length, 3);
  const primary = parsed.windows?.find((w) => w.name === 'primary');
  assert.equal(primary?.windowMinutes, 300);
  assert.equal(primary?.remainingFraction, 0.36);
  assert.equal(primary?.resetsAt, new Date(resetEpoch * 1000).toISOString());
  assert.equal(parsed.windows?.find((w) => w.name === 'secondary')?.windowMinutes, 10080);
  assert.equal(parsed.windows?.find((w) => w.name === 'individualLimit')?.remainingFraction, 0.9);
  assert.equal(parsed.windows?.find((w) => w.name === 'individualLimit')?.windowMinutes, 43200);
  // Tightest window (secondary, 82% used) binds routing.
  assert.equal(parsed.remainingFraction, 0.18);
  assert.equal(parsed.windowMinutes, 10080);
  assert.equal(parsed.resetCredits?.availableCount, 2);
  assert.equal(parsed.resetCredits?.nextExpiresAt, new Date((resetEpoch + 86400) * 1000).toISOString());
});

test('codex probe: prefers the codex entry of rateLimitsByLimitId, ignores model snapshots', () => {
  const parsed = parseCodexRateLimits({
    result: {
      rateLimitsByLimitId: {
        codex: { limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null } },
        'gpt-5': { limitId: 'gpt-5', primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: null } },
      },
    },
  });
  assert.ok(parsed);
  assert.equal(parsed.remainingFraction, 0.9);
  assert.equal(parsed.windows?.length, 1);
});

test('codex probe: a model-specific snapshot alone yields no windows', () => {
  assert.equal(parseCodexRateLimits({
    result: {
      rateLimitsByLimitId: {
        'gpt-5': { limitId: 'gpt-5', primary: { usedPercent: 99, windowDurationMins: 300 } },
      },
    },
  }), null);
});

test('codex probe: free plan primary bills monthly without a duration in the payload', () => {
  const parsed = parseCodexRateLimits({
    result: { rateLimits: { limitId: 'codex', planType: 'free', primary: { usedPercent: 50, resetsAt: null } } },
  });
  assert.ok(parsed);
  assert.equal(parsed.windows?.[0]?.windowMinutes, 43200);
});

test('codex reset text: parses today and dated forms, rejects the past', () => {
  const failedAt = new Date(2026, 10, 19, 14, 0, 0); // local time, 2:00 PM
  assert.equal(
    parseCodexResetFromMessage('You hit your limit. Try again at 3:37 PM.', failedAt),
    new Date(2026, 10, 19, 15, 38).toISOString(), // +1 minute: Codex drops seconds
  );
  assert.equal(
    parseCodexResetFromMessage('limit reached, try again at Nov 25th, 2026 3:37 PM.', failedAt),
    new Date(2026, 10, 25, 15, 38).toISOString(),
  );
  assert.equal(parseCodexResetFromMessage('Try again at 3:37 PM.', new Date(2026, 10, 19, 16, 0, 0)), null);
  assert.equal(parseCodexResetFromMessage('no reset here', failedAt), null);
});

test('kiro probe: parses used percent', () => {
  const parsed = parseKiroUsage('Usage this month\nUsed: 35%\nResets 2026-12-01T00:00:00Z');
  assert.ok(parsed);
  assert.equal(parsed.remainingFraction, 0.65);
  assert.equal(parsed.resetsAt, '2026-12-01T00:00:00.000Z');
});

test('kiro probe: parses remaining percent directly', () => {
  const parsed = parseKiroUsage('Remaining: 42% of your quota');
  assert.ok(parsed);
  assert.equal(parsed.remainingFraction, 0.42);
});

test('kiro probe: returns null when nothing parses', () => {
  assert.equal(parseKiroUsage('hello world, no numbers here'), null);
});

test('kiro probe: monthly limit reached is an honest zero quota', () => {
  const parsed = parseKiroUsage("You've reached your monthly usage limit.");
  assert.ok(parsed);
  assert.equal(parsed.remainingFraction, 0);
});

test('claude probe: parses status-line rate_limits', () => {
  const parsed = parseClaudeRateLimits({
    rate_limits: {
      five_hour: { used_percentage: 60, resets_at: '2026-11-18T19:00:00.000Z' },
      seven_day: { used_percentage: 20, resets_at: '2026-11-25T00:00:00.000Z' },
    },
  });
  assert.ok(parsed);
  assert.equal(parsed.remainingFraction, 0.4);
  assert.equal(parsed.windowMinutes, 300);
});

test('claude probe: returns null on garbage', () => {
  assert.equal(parseClaudeRateLimits({}), null);
  assert.equal(parseClaudeRateLimits(null), null);
});

test('claude probe: parses model-scoped weeklies and monthly spend', () => {
  const parsed = parseClaudeRateLimits({
    rate_limits: {
      five_hour: { utilization: 60, resets_at: '2026-11-18T19:00:00.000Z' },
      seven_day: { utilization: 20, resets_at: '2026-11-25T00:00:00.000Z' },
      model_scoped: [{ display_name: 'Opus', utilization: 45, resets_at: '2026-11-25T00:00:00.000Z' }],
      spend: {
        enabled: true,
        used: { amount_minor: 2500, currency: 'USD', exponent: 2 },
        limit: { amount_minor: 10000, currency: 'USD', exponent: 2 },
      },
    },
  });
  assert.ok(parsed);
  assert.equal(parsed.windows?.length, 4);
  assert.equal(parsed.windows?.find((w) => w.name === 'seven_day_opus')?.remainingFraction, 0.55);
  assert.equal(parsed.windows?.find((w) => w.name === 'seven_day_opus')?.windowMinutes, 10080);
  assert.equal(parsed.windows?.find((w) => w.name === 'spend')?.remainingFraction, 0.75);
  // Tightest (five_hour, 60% used) still binds routing.
  assert.equal(parsed.remainingFraction, 0.4);
});
