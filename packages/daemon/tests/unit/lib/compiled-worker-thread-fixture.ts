import { parentPort } from 'node:worker_threads';

interface Reply {
  text: string;
}
const reply: Reply = { text: 'compiled-worker-ready' };
parentPort!.postMessage(reply.text);
