import { startFakeMcpOAuthServer } from '../../../packages/daemon/tests/helpers/fake-mcp-oauth-server.ts';

const fake = await startFakeMcpOAuthServer({ port: 18347 });
console.log(`fake: ${fake.url}`);
await new Promise(() => {});
