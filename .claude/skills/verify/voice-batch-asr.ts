const [port] = process.argv.slice(2);
let calls = 0;
let delay = 600;
Bun.serve({
  hostname: '127.0.0.1',
  port: Number(port),
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/stats') return Response.json({ calls });
    if (path === '/hold') { delay = 30_000; return Response.json({ ok: true }); }
    const call = ++calls;
    await request.formData();
    await Bun.sleep(delay);
    return path === '/fail'
      ? Response.json({ error: { message: 'synthetic ASR failure' } }, { status: 503 })
      : Response.json({ text: `synthetic stored transcript ${call}` });
  },
});
