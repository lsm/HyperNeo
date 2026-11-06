# One human message recovers a stuck session

Run with the in-process proof wrapper, after building web:

```bash
NODE_PATH=<playwright modules> VERIFY_BROWSER=<chromium> \
TMPDIR=/private/tmp bash .claude/skills/verify/proof-run.sh <fresh-abs-dir> \
  .claude/skills/verify/human-send-recovery.ts
```

The helper owns a loopback model on an ephemeral port, the daemon and a static
web listener. It uses `NODE_ENV=test`, its own HOME and DB, and no provider key.
`--only=<case,case>` narrows the run. The silence window is 2 seconds and the
stall bound 6 seconds here.

Each case starts from a stuck state with the model available again and sends
exactly one `neo.message.send`. The model must answer that message.

- `healthy_chat_send_is_not_rebuilt`: a plain chat send on a healthy session keeps
  its session object
- `failure_latch`, `network_pause`, `restored_rate_limit_cooldown`
- `hung_process`: a turn is silent past the window before the message arrives
- `slow_first_token_is_not_killed`: a reply slower than the silence window but
  inside the stall bound finishes on the same session object
- `swallowed_message`: the process takes the message and never answers, so the
  watchdog recovers it
- `two_messages_in_a_hang`: a second message sent during the hang also gets through
- `parked_deliveries`: system deliveries parked behind a latch run right after
- `expired_token_401`: the refresh runs once and the turn succeeds
- `waiting_lines`: a silent turn shows the model line after the silence window, the reconnecting line at recovery, and neither once output returns; the browser sees all three
- `fast_reply_shows_no_line`: a normal reply never sets a waiting reason
- `daemon_restart_mid_outage`
- `no_network`: the message waits, the session reports `reason: network`, web
  Neo shows the one line with Send disabled, and the turn finishes on its own
  when the model returns, with no second message
- `real_quota`: the model is tried at once and the human is told
- `history_survives`: the last model request still carries the first message

Stuck states are seeded through the daemon's recorded facts, except the hang,
429, 401 and outage, which the loopback model produces. The 401 case replaces
the credential reads and the refresh call, so no real OAuth endpoint is reached.
