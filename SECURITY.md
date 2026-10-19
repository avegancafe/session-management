# Security Policy

## Supported Versions

The latest released version is supported. See [`CHANGELOG.md`](CHANGELOG.md).

## Reporting a Vulnerability

This plugin runs inside Claude Code as a hooks module (`hooks/register.ts`). It
sends your first prompt, or for `/autoname` a digest of the session's messages,
to Haiku to generate a title, then runs the built-in `/rename` command. If you find
a security issue, for example a way a prompt could make it run something other
than `/rename`, report it privately:

- Open a [GitHub security advisory](https://github.com/avegancafe/session-management/security/advisories/new), or
- Contact the maintainer directly rather than filing a public issue.

Please don't disclose the issue publicly until it has been addressed.
