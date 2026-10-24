# Neo drawer follows applicable iOS Settings

Build web, then launch a fresh isolated verify daemon on a free non-8399 port.
Use env -i, NODE_ENV=test and a dedicated HOME/data/DB; no provider is needed.
Pair a disposable headless browser using a test-only CLI human code.

Open /neo and its Settings and connection drawer. Connection is first, with
Reconnect and Refresh Neo. No project list, Move under selects or section editor
is present. Make a test CLI relay code after pairing the browser; reopen the
drawer and verify Pending devices follows Connection. Allow must remove the row
through device.pair.approve. Refused/expired codes must show a failure.

Capture settled desktop and 390px screenshots with reducedMotion=reduce and
animations disabled. Assert the drawer bounds start at x=0 and fit the viewport.
Use only an isolated iOS simulator pointed at the same test port, or an existing
sourced iOS Settings screenshot. Capture Connection and a synthetic pending row;
keep the original images and a labeled side-by-side composition. iOS retains
its URL/pairing controls. This PR changes no iOS source.

Routing and other-daemon drafts are conditional on actual data sources. Current
web/backend snapshot has no routeFailure and web has no other-daemon inventory;
do not fabricate empty settings or add new stores. Demo mode is iOS-only.

Focused tests: NeoDrawer and NeoFloatingControls. Stop only the test daemon/mock,
close the headless browser and remove any dedicated simulator when done.
