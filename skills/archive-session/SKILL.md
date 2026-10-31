---
name: archive-session
description: Use when the user runs /archive-session or explicitly asks to archive this (the current) Claude Code desktop session, e.g. "archive this session", "archive yourself". Not for archiving other sessions, and never on your own initiative.
argument-hint: "[reason]"
---

# Archive this session

Archives the session you are running in through the Claude desktop app's session tools. The session can be reopened later from the sidebar's Archived list. The conversation ends as soon as the archive call returns, so finish everything else first.

## 1. Check for work that archiving would lose

By default, archiving a worktree session also removes its worktree. In the session's working directory, run:

```bash
git status --porcelain 2>/dev/null; git log --oneline @{u}.. 2>/dev/null
```

- Not a git checkout, or both outputs empty: go to step 2.
- Uncommitted changes or unpushed commits: list them briefly, then ask the user whether to commit/push first or archive anyway. Archive only after they answer. Never commit or push without being told to.

## 2. Load the archive tool

If `mcp__ccd_session_mgmt__archive_session` is only listed as a deferred tool, load it on its own:

```
ToolSearch  query: "select:mcp__ccd_session_mgmt__archive_session"
```

If no such tool exists, either loaded or deferred, this isn't a Claude desktop session (for example, the terminal CLI). Tell the user that archiving needs the Claude desktop app, then stop.

## 3. Archive

Say one short line first, such as "Archiving this session.", because nothing you say after the call will reach the user. Then call:

```
mcp__ccd_session_mgmt__archive_session
  session_id: "self"
  reason: <the text after /archive-session, or "Archived via /archive-session">
```

Never set `_consent`. The app sets it.

## 4. If the call is refused

Report the reason the result gives, plus the fix, and don't retry in a loop:

| Refusal | What the user can do |
|---------|----------------------|
| Session is pinned | Unpin it in the sidebar, then run `/archive-session` again. |
| Open on screen, approval needed | Approve the app's card, or archive from the sidebar. |
| A side session sharing the worktree is still working | Wait for it to finish, or stop it, then retry. |
| User declined the approval | Leave the session as it is. |
