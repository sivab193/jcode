# Publishing scode to npm

scode is TypeScript on Node, so npm is its home. There is no PyPI package:
PyPI is for Python, and scode has no Python in it. A PyPI shim that
downloaded the Node build would only confuse installs — one registry, npm.

## Name

The npm package is `@sivab193/scode`. The primary executable is `scode`;
`jcode` remains available as a compatibility alias.

```sh
npm install
npm run build
npm link               # installs the local `scode` command
```

## One-time setup

Configure npm Trusted Publishing for `@sivab193/scode`, selecting the GitHub
repository `sivab193/scode` and the `release.yml` workflow. Allow direct
`npm publish`; npm's default for new trusted publishers may allow only staged
publishing. The workflow uses OIDC and npm provenance, so no npm token or
GitHub secret is needed. Complete a successful publish within two days of
creating the trusted publisher, or npm will require you to recreate it.

## Publishing a release

Update the package version and create a matching tag:

```sh
npm version patch
git push origin main --follow-tags
gh release create v0.1.1 --generate-notes --verify-tag
```

Replace `v0.1.1` with the tag created by `npm version`. Publishing the GitHub
Release triggers the workflow, which checks that the tag matches
`package.json`, runs the tests, and publishes to npm. You can also create the
release in GitHub's UI; `.github/release_template.md` supplies the description
template and `.github/release.yml` groups generated notes.

## What ships in the tarball

`files` in `package.json`: `dist/` (compiled JS), `prompts/` (the prompt
pack — the dispatcher resolves it relative to `dist/core/`, so it must
ship), `README.md`, `LICENSE`. Everything else (tests, docs, CI config)
stays out. Check any time with `npm pack --dry-run`.

## Versioning

SemVer. `0.x` while the CLI surface is still settling; `1.0.0` when the
host smoke tests pass and the TUI + `run` + `learn` commands are stable.
Breaking changes to `~/.scode` state files (ledger, quota, sessions) count
as breaking and bump the minor while in `0.x`.
