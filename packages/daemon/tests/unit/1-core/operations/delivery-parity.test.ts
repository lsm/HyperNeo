import { setStandaloneTaskDependencies } from '../../../../src/storage/tasks/set-task-dependencies';
import { transitionStandaloneTask } from '../../../../src/storage/tasks/transition-task';
import { editStandaloneTask } from '../../../../src/storage/tasks/edit-task';
import { listTaskCores } from '../../../../src/storage/tasks/list-tasks';
import { createStandaloneTask } from '../../../../src/storage/tasks/create-task';
import { readTaskCore } from '../../../../src/storage/tasks/task-reader';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { InProcessTransport, MessageHub, type Session } from '@hyperneo/shared';
import { createMailboxDeliveryHandler } from '../../../../src/lib/mailbox/delivery';
import { MAILBOX_LANE } from '../../../../src/lib/mailbox/enqueue';
import { MESSAGE_DELIVERY } from '../../../../src/lib/job-queue-constants';
import { createDaemonOperationCatalog } from '../../../../src/lib/operations/catalog';
import { createOperationMcpServer } from '../../../../src/lib/operations/mcp-server';
import { setupOperationHandlers } from '../../../../src/lib/rpc-handlers/operation-handlers';
import { createTestSession } from '../../../helpers/database';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

const categories = [undefined, 'lobby', 'worker', 'space_chat', 'space_task_agent'] as const;
const cases = categories.flatMap((targetType) => [
  { source: 'rpc' as const, sourceType: undefined, targetType },
  ...categories.map((sourceType) => ({ source: 'mcp' as const, sourceType, targetType })),
]);
const message = {
  type: 'user',
  message: { content: 'Cross-session hello' },
  parent_tool_use_id: null,
};
type Receipt = { kind: string; mailboxId: string; messageId: string };

function session(id: string, type: Session['type'], spaceId: string): Session {
  return {
    ...createTestSession(id),
    type,
    ...(type === 'worker' || type === 'space_chat' || type === 'space_task_agent'
      ? { context: { spaceId } }
      : {}),
  };
}

describe('shared operation delivery parity', () => {
  let mailbox: MailboxTestDb;
  let client: MessageHub;
  let server: MessageHub;
  let transports: [InProcessTransport, InProcessTransport];

  beforeEach(async () => {
    mailbox = createMailboxTestDb();
    client = new MessageHub();
    server = new MessageHub();
    transports = InProcessTransport.createPair();
    client.registerTransport(transports[0]);
    server.registerTransport(transports[1]);
    setupOperationHandlers(
      server,
      createDaemonOperationCatalog(mailbox.jobQueue, {
        readTask: (taskId) => readTaskCore(mailbox.db, taskId),
        createTask: (input, creatorSessionId) =>
          createStandaloneTask(mailbox.db, input, creatorSessionId, () => {}),
        listTasks: (input) => listTaskCores(mailbox.db, input),
        editTask: (input) => editStandaloneTask(mailbox.db, input, () => {}),
        transitionTask: (input) => transitionStandaloneTask(mailbox.db, input, () => {}),
        setDependencies: (input) => setStandaloneTaskDependencies(mailbox.db, input, () => {}),
      })
    );
    await Promise.all(transports.map((transport) => transport.initialize()));
  });

  afterEach(async () => {
    client.cleanup();
    server.cleanup();
    await Promise.all(transports.map((transport) => transport.close()));
    mailbox.close();
  });

  test.each(cases)(
    'delivers the same content through %j',
    async ({ source, sourceType, targetType }) => {
      const sender = session('sender', sourceType, 'space-a');
      const target = session('destination', targetType, 'space-b');
      mailbox.db.prepare('INSERT INTO sessions (id) VALUES (?)').run(target.id);
      const getSession = mock(async (id: string) => (id === target.id ? target : null));
      const deliver = createMailboxDeliveryHandler({
        ...mailbox,
        getSession,
        isSessionArchived: () => false,
      });
      const input = { sessionId: target.id, message };
      let receipt: Receipt;
      if (source === 'rpc') {
        receipt = await client.request<Receipt>('operation.invoke', {
          name: 'message.send',
          input,
        });
      } else {
        const mcp = createOperationMcpServer(
          createDaemonOperationCatalog(mailbox.jobQueue, {
            readTask: (taskId) => readTaskCore(mailbox.db, taskId),
            createTask: (input, creatorSessionId) =>
              createStandaloneTask(mailbox.db, input, creatorSessionId, () => {}),
            listTasks: (input) => listTaskCores(mailbox.db, input),
            editTask: (input) => editStandaloneTask(mailbox.db, input, () => {}),
            transitionTask: (input) => transitionStandaloneTask(mailbox.db, input, () => {}),
            setDependencies: (input) => setStandaloneTaskDependencies(mailbox.db, input, () => {}),
          }),
          () => ({
            sessionId: sender.id,
          })
        );
        const result = await mcp.tools[0].handler({ name: 'message.send', input }, {});
        expect(result.isError).not.toBe(true);
        const content = result.content[0];
        if (content.type !== 'text') throw new Error('Expected an MCP text receipt');
        receipt = JSON.parse(content.text) as Receipt;
      }
      expect(receipt.kind).toBe('accepted');
      expect(getSession).not.toHaveBeenCalled();
      expect(mailbox.sdkRows()).toEqual([]);
      const [job] = mailbox.jobQueue.dequeue(MAILBOX_LANE, 1);
      expect(job.payload).toMatchObject({
        id: receipt.mailboxId,
        messageUuid: receipt.messageId,
        to: { kind: 'session', sessionId: target.id },
        origin: source === 'rpc' ? 'chat' : 'session:sender',
      });
      await deliver(job);
      expect(getSession).toHaveBeenCalledWith(target.id);
      const [row] = mailbox.sdkRows();
      expect(mailbox.sdkRows()).toHaveLength(1);
      expect(row.session_id).toBe(target.id);
      expect(row.sdk_uuid).toBe(receipt.messageId);
      expect(JSON.parse(row.sdk_message).message.content).toEqual(message.message.content);
      expect(Boolean(JSON.parse(row.sdk_message).isSynthetic)).toBe(source === 'mcp');
      expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(1);
      await deliver(job);
      expect(mailbox.sdkRows()).toHaveLength(1);
      expect(mailbox.jobsByQueue(MESSAGE_DELIVERY)).toHaveLength(1);
    }
  );
});
