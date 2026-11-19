# What Codex needs to test on the Mac host

Everything buildable in a clean environment is built: all six phases, the
lessons store, the real claude adapter (disabled), the prompt pack, CI, and
these docs. What is left can only be verified where the CLIs are installed
and logged in. This is that list, in order. Work from a fresh clone of
`sivab193/scode` after PR #1 merges, on a branch named with the day's date.

## 0. Baseline

- `npm ci` then `npm test` — expect all 201 tests green (200 pass, 1 live Graphify test skipped when graphify is not installed).
  If any fail on macOS, that is a real bug: fix it on the branch, do not
  skip it.
- `scode status` — every installed backend should show a version string.
  Missing CLIs show as unavailable with the reason. Nothing should show a
  quota number that was not probed or manually entered.

## 1. Phase 0 gate: `scode doctor`

Run the full doctor (not `--quick`). Every dispatch check needs a real,
logged-in CLI:

- **codex-a and codex-b dispatch smoke** — each must create SMOKE.md with
  the exact line in a temp dir. If codex-b fails with an auth error, check
  that its `CODEX_HOME` is really a separate login; if both accounts share
  one home, scode will see one pool twice.
- **kiro / agy / copilot / opencode dispatch smoke** — same check, one per
  backend. If a backend's headless command differs from the handoff table
  (flags change between releases), update the adapter AND the handoff
  command table in this doc's notes — do not silently work around it.
- **Quota probes** — codex app-server JSON-RPC should return real windows
  (this failed on the build VM only because codex was unauthenticated).
  kiro `/usage` parsing is the fragile one: if the format changed, paste
  the raw `/usage` output into the fix commit message and update the parser.
- **Caveman wrap test** (`scode doctor --full`) — needs Caveman installed
  (`npx @caveman-ai/cli@latest`). If the wrap breaks a CLI's JSON output,
  that backend goes on the do-not-wrap list (`caveman.perBackend`).
- **MCP server load test** — must pass; it spawns the real server and lists
  all four tools over JSON-RPC.

Doctor writes `~/.scode/smoke.json`. Keep it — it is the record
of what this machine can do.

## 2. One real run per backend

For each installed backend, run a real task through the router (not a
smoke test): `scode run --backend <id> "<a small real task in a test repo>"`.
Check each run in the ledger (`~/.scode/ledger.jsonl`):

- `run-started` and `run-finished` records exist with matching task ids.
- The worktree was created under `.git/scode-worktrees/<taskId>` and removed
  on success.
- Tokens / cost / premium-requests are recorded when the backend reports
  them; absent when it does not. Never a fabricated number.
- Session ids are captured in `sessions.json`, and a follow-up
  `scode run` on the same task resumes the session.

## 3. Prompt pack

- Run a job in a repo that has NO AGENTS.md / CLAUDE.md / SCODE_NOTES.md.
  The job's worktree diff must contain the four seeded files, and the agent
  must have read them (check the run output for a reference to the working
  rules or SCODE_NOTES.md).
- Run a job in a repo that HAS its own AGENTS.md. scode must not overwrite
  it — the file must be byte-identical afterwards.
- If a backend ignores its steering file (some versions do), note which one
  and how you confirmed it. Do not work around it by duplicating the rules
  into every brief.

## 4. TUI

Bare `scode` in Terminal or iTerm2. Check: task bar accepts input, backends
pane shows quota bars and reset times, `m` opens manual quota entry and the
entry shows as MANUAL, up/down cycles the backend override, `?` shows help,
`r` refreshes probes, jobs show live elapsed time, and `q` quits cleanly.
If Ink misbehaves on this terminal, report the exact symptom — do not
replace the TUI.

## 5. MCP tools

- `scode tools install`, then `scode tools status` — all five backends
  should show configured (agy is skipped by design; see §7).
- Ask a backend to use `file-peek` on a real file, `pdf-read` on a real PDF,
  `latex-build` on a real .tex file, and `graph-query` on an initialized
  repo. Each call is logged to `tool-calls.jsonl` — verify all four calls.
- If a backend does not pick up the server, check its config file first
  (paths are in `src/mcp/install.ts`); the wiring is the usual suspect, not
  the server.

## 6. Caveman (only after §1's wrap test passes)

- One real run with `SCODE_CAVEMAN=true` per backend. Compare token counts
  in the ledger against the same task run without it. If a backend's output
  degrades or its JSON breaks under the wrap, add it to
  `caveman.perBackend` as disabled and note it here.

## 7. Known unknowns — resolve on the host, do not guess

- **agy MCP config path** — unconfirmed, which is why `tools install`
  skips agy. Find the real path on the machine and add it to install.ts.
- **kiro `/usage` format** — the probe parses the current text format.
  If it changed, update the parser with the raw output in the commit.
- **Copilot premium-request accounting** — confirm the per-run count in the
  ledger matches what Copilot reports. This sets the real budget.
- **OpenCode default provider** — the user's decision, not Codex's. Ask
  before changing `opencodeModel` away from free models.
- **claude status-line rate-limits file** — the probe reads
  `SCODE_CLAUDE_RATE_LIMITS_FILE` or `~/.scode/claude-rate-limits.json`.
  Confirm the real path once Claude Code is installed.

## 8. Claude (only after Pro is live, ~Nov 30)

Do not enable before then. When Pro is live:

1. Set `claudeEnabled: true` in config AND `SCODE_CLAUDE_ENABLED=true`.
2. `scode doctor` — the claude dispatch smoke must pass.
3. One real `scode run --backend claude` task; verify `total_cost_usd`
   lands in the ledger.
4. If the adapter's command needs flags for the installed Claude version,
   update the adapter and the handoff table together.

## 9. Learn loop (after a few days of real runs)

- `scode learn` — the report must show real per-backend x class stats.
- `~/.scode/lessons.md` must accumulate one entry per fold.
- If a proposal looks wrong, say which numbers disagree — do not tune the
  thresholds to make the report look nicer.

## 10. Scheduled jobs

- `scode schedule add "say hello" --in 1m`, then `scode schedule tick
  --dry-run` — must say "Would fire" after the minute passes.
- `scode schedule tick` — must dispatch through the real router (check the
  ledger: the run-started record carries a `scheduleId`), and the one-shot
  must show disabled in `scode schedule list` afterwards.
- `scode schedule install` — must print a crontab line on macOS, not a
  `schtasks` command. Do NOT install it without asking — changing the
  user's crontab is a system change.
- Open the TUI with a due schedule pending: it must fire as a `[sched]`
  job within a minute, and the Jobs pane must show upcoming schedules.

## 11. Token dashboard

- After the §2 runs, `scode tokens` must show non-zero today totals that
  match the ledger's `usage` fields (spot-check one run by hand).
- The TUI bottom bar must show the same two numbers; `t` must open the
  dashboard and any key must return to the task view with an empty task
  bar (the `t` must not leak into the task text).
- A backend that reports no usage must appear as "without usage data",
  never as zero-token runs silently folded into the totals.

## 12. Graphify code graph

- Install Python 3.11+ and `uv tool install "graphifyy[mcp]"` (pin the
  version), then `scode doctor` must PASS the three Graphify checks.
- `scode graph init` on the scode repo itself: graph builds in seconds,
  `graphify-out/` appears in .gitignore, hooks install, and `scode graph
  status` reports current.
- `scode run` in a repo with no graph must build it first (look for the
  `[scode] code graph:` line) and the run-started ledger record must carry
  `graphPresent` / `graphBuiltAtCommit` / `graphAction`.
- From inside a job, the agent must be able to call the `graph-query` MCP
  tool and get an answer about the repo (it resolves the graph from the
  worktree to the main checkout). If the tool is missing, `scode tools
  install` was not run for that backend.
- Commit a change, then run a dispatch: the graph must rebuild (stale
  detection via `built_at_commit` vs HEAD).
- Do NOT run `graphify extract` — the full pipeline needs an LLM backend.
  scode only ever calls `update` and the query commands.
- Dart check (informational): run `graphify update` on the SplitLLM
  flutter-app and confirm whether a newer graphify version parses Dart yet
  — 0.9.112 did not.

## 13. Usage limits

- `scode usage` must show every window the probes report: Codex Session
  + Weekly (+ Monthly credit limit and reset credits when the snapshot
  carries them), Claude five_hour + seven_day (+ model-scoped weeklies
  and Monthly spend when the status-line file carries them).
- The % left must match the probe's used percent (100 − used); the reset
  countdown must match the probe's resetsAt. A backend with no quota
  surface (copilot, opencode) must say so honestly — never a zero or a
  guessed number.
- `u` in the TUI must open the same view; any key must return with an
  empty task bar (the `u` must not leak into the task text).
- Quota failure path: run a codex job to a rate limit if one is near (do
  not burn quota to test this). The dispatcher must cool the account down
  until the reset Codex printed in its error text, and the limits view
  must show the cooling-down state.

## 14. Threads, PR, and Zed

- `scode thread new` in a real repo: branch `scode/<id>-<slug>` exists,
  worktree at `.git/scode-worktrees/<id>` is on that branch (not
  detached), prompt pack seeded once, first turn runs and is recorded.
- `thread continue` twice on the same thread: turns increment, the
  backend session resumes (check the ledger `sessionResumed` flag on
  turn 2), and the worktree still exists after a successful turn.
- `scode diff` shows the committed change vs the base plus uncommitted
  work; `--stat` shows only the stat.
- `scode pr --dry-run` prints the commit, push, and `gh pr create`
  steps without running them. A real `scode pr` on a repo with an
  origin remote and a signed-in `gh` must open the PR and record its
  URL on the thread. A repo without an origin must fail BEFORE any
  commit is created.
- `G` in the TUI opens the threads list; any key returns with an empty
  task bar (the `G` must not leak into the task text). Lowercase `g`
  must still start a task normally.
- `scode tools install` then a backend run: the agent can call
  `thread-list`, `thread-status`, and `thread-diff` (check
  `tool-calls.jsonl`).
- Zed: `scode zed-setup`, paste the block into settings.json, pick
  scode in the Agent Panel. A prompt must create a thread (same id as
  the Zed session), stream output, and appear in `scode thread list`.
  Stopping a prompt mid-run must cancel the dispatch — the vendor CLI
  must not keep running after Zed stops it. `scode zed <id>` opens the
  thread's worktree in Zed.

## What to change vs what to report

- **Fix on the branch:** test failures, adapter command changes, probe
  parser updates, prompt-pack bugs, TUI bugs. One commit per fix, then a PR.
- **Update these docs:** anything in §7 that gets resolved, any CLI version
  requirement that changes, any host-setup step that turns out wrong.
- **Report back without changing:** the three open decisions in
  docs/host-setup.md §6, any ToS wording a CLI shows about third-party
  harnesses, and any quota number that looks wrong (with the raw probe
  output attached).
