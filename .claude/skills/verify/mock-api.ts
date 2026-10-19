import { createMockApiServer } from '../../../packages/daemon/tests/helpers/mock-api-server.ts';

const server = await createMockApiServer({ port: 8000 });
await server.start();
console.log(`mock Anthropic API ready on ${server.serverUrl}`);
await new Promise(() => {});
