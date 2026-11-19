# iTerm2 — evaluation for scode (Nov 18, 2026)

[iTerm2](https://github.com/gnachman/iTerm2) (macOS only, GPL, ~18k stars,
current 3.7.x) is the deepest terminal on the Mac. Evaluated against scode:
it helps the Mac workflow, but nothing in the router depends on it — scode's
Ink TUI runs in any terminal, and the first host is a Mac.

## What actually helps

### 1. tmux `-CC` is the `scode attach` story (use this)

iTerm2's tmux integration maps tmux windows to native iTerm2 tabs and panes
(`tmux -CC` instead of `tmux`). Sessions survive dropped SSH connections and
app restarts, with iTerm2's scrollback, search, and mouse support inside them.

That is exactly the optional `scode attach` idea from the handoff — keep the
TUI alive across SSH sessions — with **zero scode code**:

```sh
# On the Mac mini (or any remote host), inside tmux:
tmux new-session -s scode 'scode'

# From iTerm2 on the Mac:
ssh user@host -t 'tmux -CC attach-session -t scode'
```

One caveat: if someone else attaches the same tmux session without `-CC`,
the control-mode sequences show as garbage in their terminal. Single-user
setup, so this is a non-issue in practice.

### 2. Python API — later garnish, not core

iTerm2 3.3+ has a Python API (scripts control windows, tabs, panes, and the
status bar). Possible scode companion, Phase 2+ at the earliest:

- a status-bar component showing the tightest quota window at a glance
  (reads `~/.scode/quota.json`, no scode changes needed);
- a launcher script that opens scode in a dedicated tab with a profile.

This is a separate small script, not a router feature. Don't build it until
the TUI itself is done.

### 3. Triggers — cheap alerting

Regex triggers can fire on output text (e.g. highlight `rate limit` or
`cooling down` lines, or pop a Notification Center alert when a long job
finishes). Config-only, no code. Worth setting up once long runs are common.

## What does not help

- **Inline images / imgcat** — the Ink TUI is text; no images needed.
- **Shell integration** — prompt/command marks help interactive shells, not
  a full-screen TUI that owns its own rendering.
- **The built-in AI chat / Claude Code integration** (3.7 added Claude Code
  session status; 3.7.4 beta adds Codex CLI status) — iTerm2 is growing its
  own agent awareness, but it watches sessions, it doesn't route jobs across
  quota windows. That is scode's job. No conflict, no overlap worth coding
  against.
- **Windows/Linux** — iTerm2 is macOS-only. The cross-platform equivalent
  of the tmux story is plain tmux over SSH in a capable terminal.

## Verdict

Use iTerm2 as the Mac client: run scode in tmux on the Mac mini, attach with
`tmux -CC`. Don't add iTerm2-specific code to the router. Revisit the Python
API status-bar idea after Phase 2.
