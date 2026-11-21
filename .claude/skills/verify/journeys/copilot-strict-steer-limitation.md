# Copilot steering

Use the Copilot Desktop and CLI journey in `cli`, `control` and `both-control`
modes. Invoke `work.send` with `mode: steer` during an active session. Confirm
each Copilot peer receives exactly one immediate request. Ordinary sends and
explicit queue requests must still enqueue.

Use `work.status` with the returned receipt to confirm the input was observed.
An unobserved input must stay unconfirmed. Copilot may process immediate input
in a later turn, so HyperNeo does not claim a specific destination turn.
