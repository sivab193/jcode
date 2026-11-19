# Host setup (macOS)

scode runs on the machine where the coding CLIs are installed and logged in.
When Bivia is configured, scode sends the task brief and available-backend
summaries to its decision API; without Bivia, routing uses local rules. In
either case, adapters launch the official coding CLIs, which keep their own
logins. See [Bivia routing](bivia-routing.md) for details.

## 1. Prereqs

- Node.js 22+ (`node --version`)
- git
- A terminal that supports Ink (Terminal and iTerm2 are both fine)
- Python 3.11+ (for the Graphify code graph — optional; everything else
  works without it, the graph features just skip silently)

## 2. Install the CLIs and log each one in

| Backend | Install | Login |
|---|---|---|
| codex-a / codex-b | `npm i -g @openai/codex` (or the Codex installer) | `codex login` once per account, each under its own `CODEX_HOME` (below) |
| kiro | `kiro-cli` installer | `kiro-cli` first run, or `KIRO_API_KEY` in the environment |
| agy | Google Antigravity CLI installer | `agy` first run |
| copilot | `npm i -g @github/copilot` (>= v1.0.28) | `copilot` first run |
| opencode | opencode installer (v2) | none for free models |
| claude | Claude Code installer | only after Claude Pro is live (see below) |

Optional, for the code graph (see docs/graphify.md):

```sh
brew install uv
uv tool install "graphifyy[mcp]"     # pin a version in production, e.g. graphifyy==0.9.112
graphify --version                   # verify it is on PATH
```

## 3. Two Codex accounts, two homes

One login per `CODEX_HOME` — this is the clean official path, and it is why
scode treats codex-a and codex-b as separate quota pools.

```sh
CODEX_HOME="$HOME/.codex-a" codex login   # account A
CODEX_HOME="$HOME/.codex-b" codex login   # account B
```

Then point scode at them in `~/.scode/config.json`
(see `config.example.json` in the repo):

```json
{ "codexHomes": { "a": "/Users/you/.codex-a", "b": "/Users/you/.codex-b" } }
```

If codex-b has no home configured, scode reports it unavailable rather than
silently sharing account A's login.

## 4. Config

Copy `config.example.json` to `~/.scode/config.json` and edit it.
The fields:

- `quotaFloor` (0.1) — backends below this remaining fraction are skipped
  unless they are the only option.
- `defaultTimeoutMs` — per-job timeout (30 min default).
- `claudeEnabled` — **leave false** until Claude Pro is live and the smoke
  test passes. Enabling also needs `SCODE_CLAUDE_ENABLED=true` in the
  environment (double-gate).
- `opencodeModel` — free model for the opencode backend.
- `copilotMaxContinues` — cap on Copilot autonomous steps per run (premium
  requests). Set this to match the Copilot plan.
- `claudeMaxTurns` / `claudeMaxBudgetUsd` / `claudeMcpConfig` — only used
  when claude is enabled.
- `caveman` — token-efficiency layer. Off by default; `mode: "proxy"` wraps
  the CLI, `"skill-only"` never wraps. `perBackend` overrides per backend.

Environment variables (all optional):

- `SCODE_HOME` — state dir (default `~/.scode`).

## Renamed from jcode

State, env vars, the MCP server, and thread branches were renamed from
`jcode` to `scode`. Existing installs migrate without losing anything:

- State: the first run moves `~/.jcode` to `~/.scode` (whole directory,
  one move). Nothing is written to both dirs.
- Env vars: the old `JCODE_*` names are still honored when the matching
  `SCODE_*` name is unset (`SCODE_HOME`, `SCODE_CODEX_A_HOME`,
  `SCODE_CODEX_B_HOME`, `SCODE_CLAUDE_ENABLED`,
  `SCODE_CLAUDE_RATE_LIMITS_FILE`, `SCODE_CAVEMAN`, `SCODE_GRAPHIFY`,
  `SCODE_OPENCODE_ATTACH`, `SCODE_LAYA_URL`, `SCODE_BIVIA`,
  `SCODE_BIVIA_API_KEY`). Prefer the new names going forward.
- MCP: the server is now `scode-tools`. Run `scode tools install` once
  to rewrite backend configs; it removes the old `jcode-tools` entry.
  `scode tools status` flags any config that still has one.
- Threads: new threads branch from `scode/<id>-<slug>` and worktrees
  live in `.git/scode-worktrees/`. Existing threads keep their stored
  `jcode/` branch and worktree paths and keep working.
- The `jcode` command remains available as a compatibility alias.
- `SCODE_CODEX_A_HOME` / `SCODE_CODEX_B_HOME` — same as `codexHomes`.
- `SCODE_OPENCODE_ATTACH` — attach to a warm `opencode serve`.
- `SCODE_CAVEMAN=true` — enable the Caveman layer.
- `SCODE_LAYA_URL` — Laya classification endpoint (`POST /classify`).
- `SCODE_CLAUDE_RATE_LIMITS_FILE` — claude status-line rate-limits file.

## 5. Verify

```sh
npm ci
npm test          # expect all 129 tests green
scode doctor      # Phase 0 gate — see docs/codex-local-testing.md
scode tools install   # wire the scode-tools MCP server into the backends
```

## 6. Weekly habit

Run `scode learn` once a week. It writes the report to
`~/.scode/learn-report.md` and appends the fold to
`~/.scode/lessons.md`. Proposals are presented, never
auto-applied — read them, then change `config.json` by hand if you agree.

## Decisions still open

These are the user's to make, not defaults to guess:

- **Copilot plan** (Free / Pro / GitHub Student / org) — sets the
  premium-request budget and `copilotMaxContinues`.
- **OpenCode default provider** — free models unless he says otherwise.
- **Claude Pro live date** — expected by Nov 30, 2026. Only then enable the
  claude adapter and run its smoke test.
