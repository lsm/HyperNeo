# Anthropic sign-in

Sign in under **Settings → Providers → Anthropic** to use that account for
Claude SDK sessions and subscription usage. Before the first Settings sign-in,
HyperNeo can inherit the Claude Code login. Signing out from Settings keeps
Anthropic signed out across daemon restarts, even if Claude Code is signed in.

## Credential storage

The daemon stores the Settings login in its encrypted credential database. On
sign-out, it replaces that record with a signed-out marker in the same database.
Keeping both states in one store prevents a stale credential from becoming active
when Keychain availability changes. HyperNeo leaves Claude Code's own credentials
in their original store.

By default, the database encryption key is stored in the daemon's data directory.
Someone who gains access to both the database and that key can recover the saved
credential. This has a different at-rest security boundary from macOS Keychain.
