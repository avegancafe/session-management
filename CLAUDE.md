# CLAUDE.md — session-management

Guidance for Claude Code when working **on this repository**, not when using the plugin.

## ⚠️ CRITICAL — read before any change

1. **Bump the version on EVERY change.** Edit `version` in
   [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) (semver) and add a
   matching entry to [`CHANGELOG.md`](CHANGELOG.md); CI checks they agree. Docs-only
   changes bump the patch version too. **Don't touch the marketplace**: on merge to
   `main`, [`release.yml`](.github/workflows/release.yml) sends a `plugin-released`
   dispatch and `avegancafe-marketplace` updates its entry by itself. That needs this
   repo's `MARKETPLACE_DISPATCH_TOKEN` secret (fine-grained PAT, `avegancafe-marketplace`
   only, Contents: read & write); a failed run means the marketplace was NOT updated.
2. **`hooks/hooks.json` is auto-loaded.** Don't also reference it from `plugin.json`.
3. **This repo is public** and its marketplace entry uses an HTTPS source so anyone can
   install it. Keep anything personal or work-specific out of it.
4. **State key is `session-management`.** The atom in `hooks/register.ts` and the
   `PluginState` key in `types/index.d.ts` must match the plugin name.

## Layout

```
.claude-plugin/plugin.json   # Manifest (name, version, types)
hooks/hooks.json             # { "modules": ["./register.ts"] }
hooks/register.ts            # The session-title mod: auto title, /session-title, /autoname
hooks/register.test.ts       # Mod tests (claude-code/testing)
types/index.d.ts             # PluginState typing
.github/workflows/ci.yml     # validate + version<->CHANGELOG
.github/workflows/release.yml  # notify the marketplace on version change
```
