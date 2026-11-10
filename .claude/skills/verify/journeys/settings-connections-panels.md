## Settings > Connections & Services groups Providers, Accounts, Devices, Remote Daemons and Advanced (Settings P13, P14)

Build the web bundle first (`cd packages/web && bun run build`). Launch per SKILL.md
on a free port (never 8399), with `NODE_PATH` holding Playwright, then run:

```bash
HYPERNEO_DATA_DIR="$RUN/data" node .claude/skills/verify/settings-connections-web.mjs <port> "$RUN"
```

No provider key is set anywhere: the custom endpoint is saved without one, and the
Anthropic version header proves headers reach the fixture.

End state, in `$RUN/evidence/`:

- `settings-connections.json`: `passed: true`, `zeroWrites: true`, no page errors.
- Each old address (`/settings?tab=providers|connections|devices|remote-daemons|exa`) opens,
  and survives reload, on its own tab. Back and Forward move between tabs.
- The sidebar has one Connections & Services entry and none of the five old ones.
- Accounts offers Connect Google. Devices allows a waiting relay code. A refused remote
  daemon Test shows its failure.
- Endpoint Test connection reaches the local fixture with no `Origin` and with the
  saved header, and a following HTTP 503 is shown rather than cached.
- Advanced (`?tab=exa`) holds Exa and GitHub polling (P14). Interval 0 and 60 are saved,
  -1 is refused and the field restored, the saved value survives reload, and Exa's switch
  is saved. No Exa key is entered: key saving and removal are component tests.
- `<section>-1280.png` and `<section>-390.png`: the tab row fits both widths.
