# session-management

A Claude Code plugin that keeps your session titles tidy and consistent, in
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
| Auto title | Haiku titles the session **once**, from the first message you send, and never touches it again. Wakeups, task notifications, other injected messages and slash commands don't count, and a session that already has a name (resumed, renamed, or started with `--name`) is left alone. |
| `/session-title` | Shows the title it chose. |
| `/autoname [hint]` | Re-titles the session any time from its whole history (your messages and Claude's replies; tool calls left out, long sessions cut to the first prompt plus the latest turns), then applies it with `/rename`. Optional text after it, e.g. `/autoname mostly the bootstrap fix`, is weighed on top of the history. |

Titles use a small Haiku call (about 60 output tokens) per title.

### Managed orgs

If your organization's managed settings keep Haiku out (an `availableModels`
allowlist, or a Bedrock/Vertex/gateway setup that doesn't serve it), titles fall
back to the session's current model, so they still appear at a slightly higher
cost per title. If the org sets `allowManagedHooksOnly`, user-installed plugins
load no hooks at all; this plugin needs to be installed through managed settings
there.

## License

[MIT](LICENSE)
