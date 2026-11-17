# session-management

A Claude Code plugin that titles your sessions on demand, tidy and consistent, in
conventional-commit form: `feat|fix|chore(Scope): imperative summary` (for
example `feat(ClaudePlugins): auto-name sessions by convention`).

## Install

```
/plugin marketplace add avegancafe/avegancafe-marketplace
/plugin install session-management@avegancafe-marketplace
```

Restart Claude Code afterwards; plugins load at session start.

## What it does

| Piece | Behavior |
|-------|----------|
| `/session-title` | Shows the title `/autoname` last chose. |
| `/autoname [hint]` | Re-titles the session any time from its whole history (your messages and Claude's replies; tool calls left out, long sessions cut to the first prompt plus the latest turns), then applies it with `/rename` once no turn is running, so it never closes a question Claude is asking you. Optional text after it, e.g. `/autoname mostly the bootstrap fix`, is weighed on top of the history. |
| `/archive-session [reason]` | Archives the current session (Claude desktop app only). Checks for uncommitted or unpushed work first, since archiving removes a worktree session's worktree. You can also just ask Claude to "archive this session". |

Nothing renames a session on its own: a session keeps the name it was started with (`claude -n`) or that you gave it until you run `/autoname` or `/rename`. Each `/autoname` is one small Haiku call (about 60 output tokens).

### Managed orgs

If your organization's managed settings keep Haiku out (an `availableModels`
allowlist, or a Bedrock/Vertex/gateway setup that doesn't serve it), titles fall
back to the session's current model, so they still appear at a slightly higher
cost per title. If the org sets `allowManagedHooksOnly`, user-installed plugins
load no hooks at all; this plugin needs to be installed through managed settings
there.

## License

[MIT](LICENSE)
