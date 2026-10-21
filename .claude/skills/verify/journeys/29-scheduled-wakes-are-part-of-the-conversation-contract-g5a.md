29. **Scheduled wakes are part of the conversation contract (G5a).** Launch a fresh
    isolated daemon, then run `bun .claude/skills/verify/neo-wake-contract.ts <port> "$RUN"`.
    The helper validates the test DB and seeds synthetic delivered inputs through
    the production repositories, including all five addition kinds. The real
    `neo.conversation.read` and `neo.snapshot` RPCs must expose the same wake.
    Inputs are enqueued and consumed through production APIs and terminal results
    use the production response-origin stamp; no sequence is rewritten. Only the
    self-origin scheduler delivery creates a wake; question/recovery continuations
    inherit metadata without creating duplicates. A recovered or steered turn's
    terminal settles its recorded wake. A different turn must neither settle an
    unfinished wake nor replace its closing line. Unstamped legacy results use the
    next independent consumed input as a boundary. The raw daemon note
    is absent from the public output. Evidence: `evidence/neo-wake-contract.json`.
    This checks the API with synthetic recorded turns, not model behavior or the
    web disclosure row; G5b adds the rendering journey. Stop with `stop.sh`.
