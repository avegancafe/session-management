# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-10-19

### Fixed
- Works under managed Claude Code orgs. When Haiku is out of reach (the org's `availableModels` allowlist makes the engine refuse the call, or its provider/gateway answers 400/401/403/404 for it), titles now come from the session's own model instead of silently never appearing. Transient errors (rate limits, overload, timeouts) still don't spend a second call.

## [1.0.0] - 2026-10-19

### Added
- The `session-title` mod, moved out of the `avegancafe` plugin (where it shipped through 2.2.0) so it can be installed on its own. Auto-titles the session once from your first prompt in `feat|fix|chore(Scope): summary` form; `/session-title` shows the title; `/autoname [hint]` re-titles from the session history. Its state now lives under the `session-management` plugin key.
