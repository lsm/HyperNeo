# Copilot steering

Use the Copilot Desktop and CLI journey in `cli`, `control` and `both-control`
modes. Invoke `work.send` with `mode: steer` during an active session. Confirm
each Copilot peer receives exactly one immediate request. Ordinary sends and
explicit queue requests must still enqueue.

The catalog must mark Copilot steering as `steerBehavior: best_effort`. An
acknowledged input can return a receipt before consumption. Use `work.status`
with that receipt to confirm the input was observed. Copilot may process
immediate input in a later turn.
