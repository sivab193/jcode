# Code graph (Graphify)

scode gives every dispatched agent a map of the repo it is working in, so it
can answer "who calls X?" with one query instead of grepping and re-reading
whole files. The map comes from **Graphify** — the open-source CLI
([Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify),
Apache-2.0, installed from PyPI as `graphifyy`).

## The one decision that matters: CLI, not Cloud

Graphify has two halves. scode uses only the first:

- **Open-source CLI** — free, local, no account. `graphify update` parses
  code with tree-sitter into a graph, with zero LLM calls and nothing leaving
  the machine. This is the scode-compatible half.
- **Hosted Graphify Cloud** (app.graphify.com) — free for up to 3 repos, then
  paid; it sends code to OpenAI/Anthropic subprocessors. This half conflicts
  with scode's local-first, no-paid-credits rules and is **not** used.

## How it works

- **One graph per repo**, at `<repo>/graphify-out/graph.json` (or
  `$GRAPHIFY_OUT` when set). Nodes are functions, classes, files; edges are
  calls, imports, inheritance. Freshness is checked against graph.json's
  `built_at_commit` vs `git rev-parse HEAD`.
- **`scode graph init [path]`** — build the graph for a repo, add
  `graphify-out/` to its `.gitignore`, and install graphify's git hooks so
  the graph refreshes on commit. Run once per repo; new project, same one
  command.
- **`scode graph status [path]`** — is there a graph, how many nodes, built
  at which commit, current or stale.
- **`scode graph refresh [path]`** — rebuild now (`--force` after refactors
  that delete a lot of code).
- **Pre-dispatch indexing** — before dispatching a job, scode builds the
  graph when it is missing or stale (config `graphify.autoBuild`, default
  true; `SCODE_GRAPHIFY=false` turns the whole thing off). A missing or
  failing graph never fails a job: the dispatcher warns and continues.
- **Query path** — agents query through the `graph-query` tool in the
  `scode-tools` MCP suite (kinds: `query`, `explain`, `path`, `affected`,
  `god-nodes`), or directly with `graphify query` on the command line. The
  tool resolves the graph from the agent's cwd — including from a scode
  worktree, where it walks to the main checkout via
  `git rev-parse --git-common-dir`. scode deliberately does **not** wire
  `graphify-mcp` per backend: that server takes the graph path as a startup
  argument, but backend MCP configs are per-user/global, so one static
  config cannot point at every repo's graph.
- **Prompt pack** — the seeded AGENTS.md/CLAUDE.md/kiro-steering.md tell
  agents to query the graph before grepping for structure, and to use grep
  only for exact strings (error messages, config keys).
- **Ledger** — each run-started record carries `graphPresent`,
  `graphBuiltAtCommit`, and `graphAction`, so `scode learn` can later
  compare graph-vs-no-graph token use.
- **`scode doctor`** checks the graphify binary, Python >= 3.11, and the
  `[mcp]` extra. All three are SKIP, never FAIL, when absent.

## Rules

- **Never call `graphify extract`** (or `cluster-only`/`label` with LLM
  naming) from scode — the full pipeline needs an LLM backend and would
  break the no-paid-credits rule. Only `update` (code-only), the query
  commands, and `hook install` are ever run.
- **Never paste graph.json into context.** A 1,500-node graph is ~400K
  tokens as raw JSON. Always query it with a token budget (`--budget`,
  default 2000).
- **Query exit codes are answers, not errors:** 0 = answer, 3 = ambiguous
  name (candidates listed), 4 = no node matches.

## Token savings — what to actually expect

The mechanism is real: one query returns just the callers/callees with
file+line, a few hundred tokens instead of the tens of thousands a
grep-then-read-all-matches loop costs. The numbers floating around are
vendor or single-source and should be treated as unverified: Graphify
claims ~80% / 71.5x on a 52-file corpus (shrinking to ~1x on a 6-file
corpus), one employee experiment measured ~48,900 tokens vs ~188 for one
query, and one independent measurement (Claude Code, Oct 2026) found a
31% total reduction — with per-round-trip startup context (~140K tokens)
dominating total spend, so the index only shrinks the tool-result portion.
Realistic expectation: a big win on exploration/navigation-heavy tasks in
medium/large repos; near-zero on small repos or tasks where the agent must
read the files anyway. It complements Caveman (Caveman compresses what the
agent reads; Graphify reduces what it needs to read).

## Known gaps

- **Dart/Flutter is not parsed.** Verified Nov 18, 2026 against graphify
  0.9.112: a .dart file contributed only its import string as a node — no
  classes, no functions. Do not promise graph coverage for Flutter repos
  (SplitLLM's flutter-app included) until a later graphify version adds a
  Dart grammar.
- **Build time on big repos is unmeasured.** Seconds on Click-sized repos
  (39 TypeScript files took 2.6s), but the skill warns past 500 files / 2M
  words. Measure on the largest repo before trusting auto-build there.
- **Version churn.** The repo moves extremely fast (258 releases since
  April 2026). The integration was verified against 0.9.112; pin a
  `graphifyy` version when installing (see host-setup.md) and treat
  `graph.schema_version` as a compat signal.
- **Python 3.11+ is a new host prerequisite.** scode itself is Node-only;
  Graphify adds Python + uv to the host setup.
