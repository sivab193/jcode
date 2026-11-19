# Task brief template

This is the template `formatBrief()` in `src/core/promptPack.ts` applies to
every dispatched task. The user's brief goes in verbatim under `## Task`; the
working rules below it are the same for every backend, so no backend needs a
separate prompt translation for the rules themselves.

```markdown
## Task

<brief, verbatim>

## Working rules

- Work in this repository. If SCODE_NOTES.md exists here, read it first — it
  carries the lessons from earlier runs.
- Do not invent data, files, or results. Say plainly what you could not verify.
- Keep the change minimal and scoped to the task. Do not refactor unrelated code.
- Run the project's checks for what you touched and report what passed and
  what failed.
```

The ledger records the user's brief, not the wrapped version, so the learn
loop's prompt-pattern analysis sees what the user actually wrote.
