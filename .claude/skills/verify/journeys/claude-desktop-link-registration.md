## Claude Desktop link registration

Starts prepare a short CLI turn in auto, exit, and import the native Desktop
record. The imported record supplies the registered link and actual permission
mode. Delivery then uses the current Desktop delivery path: direct inbox first
for live targets, a relay retry using freshly read receiver mode if needed,
and an auto headless turn for stopped targets. No forwarding helper or Desktop
warm spawn is required.

Run the shared setup and checks in [Claude Desktop delivery](claude-desktop-b1.md).
The `claude-desktop-link.ts <port> <run>` entry point delegates to that current
journey through the `claude-b1.ts` compatibility entry point.

The synthetic proof validates RPC delivery, receipt-bound target status,
fresh permission-mode retries, stopped-session delivery and unchanged settings.
Native Desktop execution and phone visibility remain distinct evidence; do not
claim either from a mock record or a queued RC request.
