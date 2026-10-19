# Contributing to session-management

A small Claude Code plugin that auto-names sessions, distributed through
[`avegancafe/avegancafe-marketplace`](https://github.com/avegancafe/avegancafe-marketplace).

## Golden rule: bump the version

**Every change bumps the version**, docs included. In one PR, update together:

1. `version` in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) (semver)
2. A new entry in [`CHANGELOG.md`](CHANGELOG.md)

CI checks they match. The marketplace entry updates itself after merge.

## Local development

```bash
git clone https://github.com/avegancafe/session-management.git
claude plugin validate .
# point a local marketplace at your clone, install, and restart Claude Code to try it
```

## Rules

- Manifests live in `.claude-plugin/`; hooks live at the repo root.
- `hooks/hooks.json` is auto-loaded; never also reference it from `plugin.json`.
- Keep changes focused; one logical change per PR.

See [`CLAUDE.md`](CLAUDE.md) for the maintainer guide.
