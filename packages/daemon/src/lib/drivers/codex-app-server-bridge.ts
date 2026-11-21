import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, rename, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { getDataDir } from '../data-dir.ts';
import { codexAppServerSocketPath } from './worker-directories.ts';

export const CODEX_BRIDGE_PORT = 47912;
const tokenDirectory = () => join(getDataDir(), 'codex-app-server-bridge');

async function checkTokenDirectory(directory: string) {
  const parent = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  );
  try {
    const stat = await parent.stat();
    if (stat.uid !== process.getuid?.()) throw new Error('Invalid token directory owner.');
    if ((stat.mode & 0o777) !== 0o700) await parent.chmod(0o700);
  } finally {
    await parent.close();
  }
}

export async function removeCodexBridgeToken() {
  const directory = tokenDirectory();
  try {
    await checkTokenDirectory(directory);
    await rm(join(directory, 'token'), { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function bridgeToken(rotate: boolean): Promise<Buffer> {
  const directory = tokenDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await checkTokenDirectory(directory);

  const path = join(directory, 'token');
  const read = () => open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const generate = async (replace: boolean) => {
    const temporary = join(directory, randomBytes(16).toString('hex'));
    const generated = await open(temporary, 'wx', 0o600);
    try {
      try {
        await generated.writeFile(randomBytes(32).toString('base64url'));
      } finally {
        await generated.close();
      }
      if (replace) await rename(temporary, path);
      else
        await link(temporary, path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'EEXIST') throw error;
        });
    } finally {
      await rm(temporary, { force: true });
    }
  };
  const file = await read().catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    await generate(false);
    return read();
  });
  let token: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size !== 43) {
      throw new Error('Invalid bridge token file.');
    }
    if ((stat.mode & 0o777) !== 0o600) await file.chmod(0o600);
    token = await file.readFile('utf8');
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid bridge token.');
  } finally {
    await file.close();
  }
  if (!rotate) return Buffer.from(token);
  await generate(true);
  return bridgeToken(false);
}

export function loadCodexBridgeToken(rotate = false) {
  return bridgeToken(rotate).catch(() => {
    throw new Error(
      'Check ownership and permissions of the Codex bridge token directory and file.'
    );
  });
}

export async function startCodexAppServerBridge(
  port = CODEX_BRIDGE_PORT,
  currentToken?: () => Buffer
): Promise<() => Promise<void>> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Set a valid Codex bridge port before restarting HyperNeo.');
  }
  const stored = currentToken ? undefined : await loadCodexBridgeToken();
  const upstreamPath = codexAppServerSocketPath();
  const clients = new Set<Socket>();
  const server = createServer((_request, response) => response.writeHead(404).end());
  server.on('connection', (socket) => {
    clients.add(socket);
    socket.once('close', () => clients.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    const match = /^\/rpc\?token=([A-Za-z0-9_-]{43})$/.exec(request.url ?? '');
    if (!match || !timingSafeEqual(Buffer.from(match[1]), currentToken?.() ?? stored!)) {
      socket.destroy();
      return;
    }
    const upstream = connect(upstreamPath);
    socket.once('error', () => upstream.destroy());
    socket.once('close', () => upstream.destroy());
    upstream.once('error', () => socket.destroy());
    upstream.once('close', () => socket.end());
    const headers = Object.entries(request.headers)
      .flatMap(([name, values]) => [values].flat().map((value) => `${name}: ${value}`))
      .join('\r\n');
    upstream.write(`GET / HTTP/1.1\r\n${headers}\r\n\r\n`);
    upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(
        new Error(
          error.code === 'EADDRINUSE'
            ? `Codex bridge port ${port} is busy. Stop the existing listener before restarting HyperNeo.`
            : 'Codex bridge could not listen on loopback.'
        )
      );
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
  return () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of clients) socket.destroy();
    });
}
