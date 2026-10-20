# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-10-20

### Fixed
- A title cut to fit the length limit no longer ends on a dangling filler word (`… skipping and`): trailing conjunctions, articles and prepositions the cut leaves behind are dropped.

## [1.2.0] - 2026-10-19

### Fixed
- The first-prompt title now appears on managed machines. It hooked the classic `UserPromptSubmit` event, which Claude Code's built-in `sec-default` plugin sends past every user-installed plugin wherever managed settings exist (and for Team and Enterprise orgs), so it never ran there. It now hooks `prompt.submit` and applies the title with `/rename`, as `/autoname` does.

### Changed
- The title is generated off the turn's critical path: your first prompt no longer waits on the model call. The title lands a moment later.
- A session you `/rename` by hand before your first prompt keeps its name, and a resumed session (one where you'd already spoken) is never retitled.

## [1.1.0] - 2026-10-19

### Fixed
- Works under managed Claude Code orgs. When Haiku is out of reach (the org's `availableModels` allowlist makes the engine refuse the call, or its provider/gateway answers 400/401/403/404 for it), titles now come from the session's own model instead of silently never appearing. Transient errors (rate limits, overload, timeouts) still don't spend a second call.

## [1.0.0] - 2026-10-19

### Added
- The `session-title` mod, moved out of the `avegancafe` plugin (where it shipped through 2.2.0) so it can be installed on its own. Auto-titles the session once from your first prompt in `feat|fix|chore(Scope): summary` form; `/session-title` shows the title; `/autoname [hint]` re-titles from the session history. Its state now lives under the `session-management` plugin key.
