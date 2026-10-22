## Explicit answer linking after holder removal

#8114 deletes holder-bound input envelopes and automatic turn-end publications.
The old worker-answered-linking helper depended on that removed runtime and has
been retired. For mid-turn receipt and interruption use
[ordinary restart delivery](spent-admission-restart.md), which runs real daemon
RPC and SDK requests for both Neo and an ordinary session.

Explicit answer linking is verified in the subsequent replyTo PR. That proof
must prefix human Neo conversation messages with their ids in the conversation
write path only, validate human ids in that conversation, and refuse foreign or
non-human ids. Ordinary sessions and session-messages keep their existing text.
No replyTo behavior is claimed by the deletion-only PR.
