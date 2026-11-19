# Usage limits

`scode usage` (or `u` in the TUI) shows every quota window per backend —
the view T3 Code calls Usage > Limits, as plain text. One row per window:

```
Codex · account A — updated 2m ago
  Session                 36% left  ████|█░░░░░░░░░░  ↻ 1h 30m · under pace
  Weekly                  18% left  ███░░░░░░░|░░░░░  ↻ 4d 14h · ahead of pace
  Reset credits: 2 available (next expires ↻ 2d 23h)
```

- **% left** is 100 − used. The bar fills with remaining.
- **The `|` tick** marks where remaining *should* be if usage were evenly
  spread across the window. Burning faster than time passes is "ahead of
  pace"; slower is "under pace". Within 5 points either way is on pace and
  shows no label.
- **↻ countdown** is the time until that window resets. A window with no
  known reset shows no countdown rather than a guessed one.
- **Reset credits** (Codex) are display-only: how many are available and
  when the next one expires. scode never spends one on your behalf.

Routing still uses the tightest window per backend — the limits view
changes what you *see*, not what the router *does*. A failed probe keeps
the last good reading (with its age shown) instead of blanking the row.

## Where each backend's windows come from

| Backend | Source | Windows |
| ------- | ------ | ------- |
| codex-a / codex-b | app-server `account/rateLimits/read` | Session (primary), Weekly (secondary), Monthly credit limit (individual) |
| claude | status-line rate-limits file | Session (five_hour), Weekly (seven_day), model-scoped weeklies, Monthly spend |
| kiro | `kiro-cli chat /usage` text | One window, no kind known |
| agy | `agy-cli-usage --json` when installed | One window when the reader exists |
| copilot | — | None: no account-level quota via the CLI |
| opencode | — | None: no native quota (bring-your-own-provider) |

Codex details, following T3's mapping: primary is the Session window (5h)
and secondary the Weekly window; free/go plans bill monthly instead, so
their primary is Monthly. Model-specific snapshots (`rateLimitsByLimitId`
entries other than `codex`) are excluded from the main rows — a per-model
limit is not the account's allowance. When Codex writes the reset into an
error message ("Try again at 3:37 PM."), the dispatcher uses it for the
cooldown when the probe snapshot is unavailable (e.g. behind a proxy).

Claude details: the status-line file may also carry `model_scoped`
weeklies ("Weekly · Opus") and a monthly spend budget; both are parsed
when present and ignored when absent. The spend window can bind routing
when it is the tightest — that is honest, an exhausted spend cap blocks
runs just like an exhausted time window.

## What T3 does that scode deliberately does not

T3 reads Antigravity, Cursor, and Grok limits by reusing the vendor's
stored OAuth token (refreshing it and calling the vendor's quota API).
scode never extracts or reuses a vendor login token — adapters only spawn
official CLIs — so those three probes stay CLI-only here: agy reports
through the community `agy-cli-usage` reader when installed, and Cursor /
Grok have no usage probe until an official CLI surface reports quota. If
that rule ever changes, it is the user's call, not a quiet exception.
