15. **A session with no registered provider fails once and says why.** A fresh run
    dir has no provider records, so Anthropic is not registered there. Launch with
    `VERIFY_LOG_LEVEL=error`, then run
    `VERIFY_PORT=<port> .claude/skills/verify/missing-provider-check.sh "$RUN"`. It
    sends one message to root Neo and waits for its delivery job to settle. End
    state: the job is `dead` with `retry_count` 0 and the error `Provider
    'anthropic' is not registered. Log in or add an API key for it under Providers,
    or switch this session to another provider.`, the message is `failed`, and
    `daemon.log` has that one `[ErrorManager] model` entry.
