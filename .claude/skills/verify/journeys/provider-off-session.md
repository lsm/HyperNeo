# A session whose provider is off moves or waits

Launch a fresh run with `VERIFY_LOG_LEVEL=error` and export `VERIFY_MOCK_PORT`, then run
`.claude/skills/verify/provider-off-session.sh "$RUN" none` and, in another fresh run,
`.claude/skills/verify/provider-off-session.sh "$RUN" other-on`. Both seed an old-style
Space chat session pinned to Anthropic and send six messages at once.

- `none`: no message fails, the session shows one notice, and `daemon.log` has no
  `is not registered; cannot prepare` line. After Anthropic is added, the messages go out.
- `other-on`: the session moves to the provider that is on and shows one notice.
