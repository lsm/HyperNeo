import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketClientTransport } from '../../../../shared/src/mod.ts';

const initialize = WebSocketClientTransport.prototype.initialize;
const order = [];
const record = (value) => {
  order.push(value);
  writeFileSync(join(process.argv.at(-1), 'evidence/boot-frame-order.json'), JSON.stringify(order));
};
WebSocketClientTransport.prototype.initialize = function () {
  const createSocket = this.createSocket;
  this.createSocket = (address) => {
    const socket = createSocket(address);
    let requestId;
    let held;
    return new Proxy(socket, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === 'send')
          return (data, ...args) => {
            try {
              const frame = JSON.parse(String(data));
              if (
                frame.method === 'liveQuery.subscribe' &&
                frame.data?.subscriptionId === 'bun-boot-live'
              )
                requestId = frame.id;
            } catch {}
            return value.call(target, data, ...args);
          };
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, key, value) {
        if (key !== 'onmessage') return Reflect.set(target, key, value, target);
        target.onmessage = (event) => {
          const frame = JSON.parse(String(event.data));
          if (
            frame.method === 'liveQuery.snapshot' &&
            frame.data?.subscriptionId === 'bun-boot-live'
          ) {
            held = event;
            record('snapshot-held');
            return;
          }
          if (held && (frame.requestId ?? frame.id) === requestId) {
            record('ack-released');
            value.call(target, event);
            setTimeout(() => {
              if (target.readyState !== 1) return;
              record('snapshot-released');
              value.call(target, held);
            }, 100);
            return;
          }
          value.call(target, event);
        };
        return true;
      },
    });
  };
  return initialize.call(this);
};
