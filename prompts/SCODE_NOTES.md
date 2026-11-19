# SCODE_NOTES.md — shared lessons across backends

This file is the one piece of context every backend reads: codex, kiro, agy,
copilot, opencode, and claude all see the same file. scode copies this
template into each job's worktree when the repo has no SCODE_NOTES.md of its
own. Add lessons that future runs should know — decisions, gotchas, things
that failed and why. Your edits to this file are part of the job's diff, so
they get reviewed like any other change.

## Standing rules

- Quota and usage data is never faked. If a probe returns nothing, the
  backend reports "unknown", not a guess.
- Structure questions go to the code graph first: use the `graph-query`
  tool (or `graphify query`) before grepping for who calls what. Never read
  graph.json directly; always query it with a budget.
- The run ledger is append-only. Never edit or delete ledger lines.
- A failed job's worktree is kept for inspection; a successful one is removed.

## Lessons

<!-- Add dated lessons here. One line each: what happened, what to do. -->
