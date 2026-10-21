import { writeFileSync, statSync } from 'node:fs';
import { Server } from 'node:http';

const output = process.env.VERIFY_SESSION_DOOR_OBSERVATION;
if (process.env.NODE_ENV !== 'test' || !output) throw new Error('isolated test observer only');
const emit = Server.prototype.emit;
Server.prototype.emit = function (event: string | symbol, ...args: unknown[]) {
  const path = this.address();
  if (event === 'listening' && typeof path === 'string' && path.endsWith('/session-door.sock'))
    writeFileSync(
      output,
      JSON.stringify({ path, modeBeforeChmod: statSync(path).mode & 0o777, umask: process.umask() })
    );
  return emit.call(this, event, ...args);
};
