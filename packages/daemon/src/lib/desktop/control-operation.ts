import { z } from 'zod';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { neoTodoDesktopControlWrite } from '../../storage/repositories/neo-todo-desktop-control-write.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import { defineOperation } from '../operations/registry.ts';

export function createDesktopControlOperation(db: Database) {
  return defineOperation({
    name: 'desktop.control.set',
    description: "Turn desktop control on or off for one unfinished todo's worker.",
    inputSchema: z.object({ todoId: z.string().min(1), on: z.boolean() }).strict(),
    resultSchema: z.union([
      z.object({ accepted: z.literal(true), desktopControl: z.boolean() }),
      z.object({ accepted: z.literal(false), reason: z.enum(['todo_not_found', 'todo_finished']) }),
    ]),
    policy: { safetyClass: 'human_only', caller: 'local_user' },
    execute: (input) =>
      gatewayFor(db).run(neoTodoDesktopControlWrite, { ...input, now: Date.now() }),
  });
}
