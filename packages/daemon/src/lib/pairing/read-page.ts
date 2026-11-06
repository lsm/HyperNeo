export function isAgentReadRequest(req: Request): boolean {
  return req.method === 'GET' && /^\/ask\/[^/]+\.md$/.test(new URL(req.url).pathname);
}
