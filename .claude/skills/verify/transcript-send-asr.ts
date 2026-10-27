let release: (() => void) | undefined;
let received = 0;
const server = Bun.serve({
  hostname: '127.0.0.1', port: Number(process.argv[2]),
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/stats') return Response.json({ received, held: !!release });
    if (path === '/release') { release?.(); return Response.json({ ok: true }); }
    await request.formData();
    received++;
    await new Promise<void>((resolve) => { release = resolve; });
    release = undefined;
    return Response.json({ text: 'Pending transcript sent once' });
  },
});
console.log(`Synthetic ASR on ${server.url}`);
