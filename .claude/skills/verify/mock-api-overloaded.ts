const port = Number(process.env.VERIFY_MOCK_PORT ?? 8000);
const requests: string[] = [];
Bun.serve({
  port,
  hostname: '127.0.0.1',
  fetch(request) {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    console.log(requests.at(-1));
    return Response.json(
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      { status: 529, headers: { 'x-should-retry': 'false' } }
    );
  },
});
console.log(`overloaded mock Anthropic API ready on http://127.0.0.1:${port}`);
await new Promise(() => {});
