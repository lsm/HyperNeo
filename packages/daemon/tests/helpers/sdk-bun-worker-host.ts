const worker = new Worker(process.argv[2], { type: 'module' });
worker.onmessage = ({ data }) => process.send?.({ data });
worker.onerror = (event) => {
  event.preventDefault();
  process.send?.({ error: event.message });
};
process.on('message', (data) => worker.postMessage(data));
const stop = () => {
  worker.terminate();
  process.exit(0);
};
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.send?.({ ready: true });
