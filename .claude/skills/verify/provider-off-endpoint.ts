const upstream = `http://127.0.0.1:${process.env.VERIFY_MOCK_PORT}`;

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const { pathname, search } = new URL(request.url);
    if (pathname === '/v1/models') return Response.json({ data: [] });
    return fetch(`${upstream}${pathname}${search}`, request);
  },
});
console.log(server.port);
