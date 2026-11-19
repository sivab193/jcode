# Threads

A thread is a durable task: one branch, one worktree, one backend session.
T3 Code's threads are the model — scode's version is the same idea as
plain commands, no server and no GUI needed.

```sh
scode thread new "Add a login page"     # branch + worktree + first turn
scode thread continue 5e52e480 "Also add logout"   # next turn, same session
scode thread list                       # active and closed threads
scode thread status 5e52e480            # branch, turns, change summary
scode thread close 5e52e480             # archive (branch + worktree kept)
```

## How a thread works

`thread new` creates branch `scode/<id>-<slug>` from the repo's current
branch and a worktree at `<repo>/.git/scode-worktrees/<id>`, seeds the
prompt pack once, then dispatches the first turn. The first turn is
auto-routed like any `scode run`; later turns stay on the thread's
backend (session continuity) unless it is unavailable, in which case the
router picks another backend and says so. `--backend` on `new` or
`continue` pins a backend for that turn.

Each turn gets its own task id (`<thread>-turn-<n>`) in the ledger, so
`scode learn` sees turns as runs. The backend session is keyed by thread,
so follow-ups resume the agent's context instead of cold-starting. The
worktree is never removed: on success or failure, the thread's work stays
put until you ship it or clean it up by hand.

Threads live in `~/.scode/threads.json`. A thread id is 8 hex chars;
commands accept a unique prefix.

## Review and ship

```sh
scode diff 5e52e480            # full diff vs the base branch
scode diff 5e52e480 --stat     # stat only
scode pr 5e52e480              # commit, push, open the PR
scode pr 5e52e480 --draft      # draft PR
scode pr 5e52e480 --dry-run    # print every step, run nothing
```

`scode diff` shows committed changes against the base branch plus
uncommitted work in the worktree. `scode pr` commits uncommitted work
with a deterministic message, pushes the branch to `origin`, and opens
the PR with `gh pr create` using your own GitHub sign-in. The title and
body are deterministic from the thread and its diff — no model-generated
prose, so what you see in `--dry-run` is what ships. When `gh` is missing
or the create fails, the push still stands and the exact manual command
is printed. A missing `origin` remote fails fast, before any commit.

The PR URL is recorded on the thread (`thread list` shows it). Merge on
GitHub as usual; scode never merges.

## Threads in the TUI and MCP

- `G` in the TUI opens the threads list; any key returns.
- The `scode-tools` MCP server has `thread-list`, `thread-status`, and
  `thread-diff`, so a backend agent can review a thread's change before
  shipping it.
