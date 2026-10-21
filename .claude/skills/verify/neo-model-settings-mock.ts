import { createMockApiServer } from '../../../packages/daemon/tests/helpers/mock-api-server.ts';
const port = Number(process.argv[2]);
if (!port || port === 8399) throw new Error('Use an isolated mock port');
const server = await createMockApiServer({ port });
await server.start();
await new Promise(() => {});
