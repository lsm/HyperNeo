const commands = {
  relay:
    '  hyperneo relay <question-id> --where <place> --when <time> -- <exact words>\n                                      Relay a human answer with its original place and time',
  read: '  hyperneo read <link>                Read a card Markdown page with the read-only agent credential',
  send: `  hyperneo send <session-id> [--kind done|blocked|question|failed] <text>
                                      Message another session; --kind marks a milestone report`,
  question: `  hyperneo question <question-id>     Read a Neo question and whether the human answered it`,
  build: `  hyperneo build                      Read daemon build and health through the owner-only session socket`,
  pair: `  hyperneo pair [--kind human|relay|daemon|agent] [--name <name>]
                                      Make a 10-minute pairing code; after the first device, it waits for Allow on a paired device
  hyperneo pair --qr [--name <name>] [--address <tailnet origin>]
                                      Show a QR code for the HyperNeo app over Tailscale; type the code shown on the phone to allow
  hyperneo pair --reset-lockout       Reopen pairing after too many bad codes`,
  devices: `  hyperneo devices                    List paired devices (never their credentials)
  hyperneo devices revoke <id>        Revoke a paired device and close its connections
  hyperneo devices reset-human        Lost-phone recovery: clear human devices, reopen one human pairing, and notify Neo`,
};

export const SESSION_CLI_HELP = [
  Object.values(commands).join('\n'),
  '  hyperneo desktop-mcp --worker <id>   Serve bounded desktop tools over stdio MCP',
].join('\n');
export const SESSION_CLI_USAGE = `Usage:\n${SESSION_CLI_HELP}`;

export function isSessionCommand(command: string | undefined): boolean {
  return Object.hasOwn(commands, command ?? '');
}
