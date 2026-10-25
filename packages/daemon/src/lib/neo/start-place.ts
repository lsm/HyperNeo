import { mkdirSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { NeoConversationAskRepository } from '../../storage/repositories/neo-conversation-ask-repository.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import { extractTextBlockContents } from '../../storage/repositories/sdk-message-projections.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import { reject, type WorkVerbDeps } from '../drivers/work-operations.ts';
import { neoFolderPath } from './folder.ts';

function namesPath(text: string, folder: string): boolean {
  return text
    .split(folder)
    .some(
      (part, index, parts) =>
        index < parts.length - 1 &&
        !/[\p{L}\p{N}_./~-]$/u.test(part) &&
        !/^[\p{L}\p{N}_./~-]/u.test(parts[index + 1])
    );
}

function userNamedPath(
  db: Database,
  repo: NeoRepository,
  sessionId: string,
  folder: string
): boolean {
  const conversation = repo.conversationId();
  if (!conversation) return false;
  const inputs = new NeoConversationAskRepository(db);
  let after = 0;
  for (;;) {
    const page = inputs.list(conversation, after, 100) ?? [];
    if (
      page.some(
        (input) =>
          input.askOrigin.sessionId === sessionId &&
          namesPath(
            extractTextBlockContents({ message: { content: input.content } }, 'join-all').join(
              '\n'
            ),
            folder
          )
      )
    )
      return true;
    if (page.length < 100) return false;
    after = page[page.length - 1].sequence;
  }
}

export function neoStartPlace(deps: {
  db: Database;
  machine: string;
  workspaceRoot?: string;
}): NonNullable<WorkVerbDeps['startPlace']> {
  return (input, caller, create = false) => {
    if (caller.role !== 'neo' && input.place) return { value: { ...input, place: input.place } };
    const store = new NeoAskTodoRepository(deps.db);
    const todo = input.todoId ? store.getTodo(input.todoId) : null;
    const candidate = todo ? store.getAsk(todo.askId) : null;
    const ask =
      candidate?.sessionId === caller.sessionId && candidate?.status === 'open' ? candidate : null;
    const repo = new NeoRepository(deps.db);
    const coding = !!(todo?.repo || ask?.repo || todo?.check?.pack === 'coding');
    if (coding && input.place) return { value: { ...input, place: input.place } };
    const home = resolve(deps.workspaceRoot ?? join(neoFolderPath(), 'projects'), 'home');
    const place =
      input.place ??
      (!coding && ask ? { machine: deps.machine, folder: home, name: 'Home' } : null);
    if (!place)
      return {
        reason: reject(
          'invalid_place',
          'Choose a repository place for coding, or an open non-coding todo to use the shared home.'
        ),
      };
    const folder = place.folder;
    const local = !place.daemon && place.machine === deps.machine;
    if (
      input.place &&
      (!local || folder !== home) &&
      (!caller.sessionId || !userNamedPath(deps.db, repo, caller.sessionId, folder ?? place.name))
    )
      return {
        reason: reject(
          'invalid_place',
          'A different place requires an exact path named by the user in chat. Omit place for the shared non-coding home; never invent a folder under home.'
        ),
      };
    if (folder && (!input.place || input.createFolder)) {
      if (!isAbsolute(folder) || normalize(folder) !== folder)
        return { reason: reject('invalid_place', `${folder} is not a plain absolute path.`) };
      if (!place.daemon && !local)
        return {
          reason: reject('invalid_place', `${place.name} is on ${place.machine}, not here.`),
        };
      if (local && create) {
        try {
          mkdirSync(folder, { recursive: true });
        } catch (error) {
          return {
            reason: reject('invalid_place', `Could not create ${folder}: ${String(error)}`),
          };
        }
      }
    }
    return {
      value: {
        ...input,
        place,
        inPlace: local && folder === home,
        createFolder: !input.place || input.createFolder,
      },
    };
  };
}
