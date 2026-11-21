import { choiceCard, humanPickedApply, openHumanCard } from '../neo/human-card.ts';
import { neoDerivedId } from '../neo/derived-id.ts';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';

const title = 'Set up the shared Codex server';
const text =
  'HyperNeo can share the Codex app server. Setup restarts Codex Desktop and may restart its managed server. Restarting Desktop interrupts any work in its private server. HyperNeo waits for managed turns, but a turn started from Desktop or phone during the cutover may still be interrupted. Set up the shared server?';

export function codexSetupQuestion(store: NeoAskTodoRepository, ensureNeo: () => Promise<string>) {
  const settle = (id: string, approved: boolean) => {
    const question = store.getQuestion(id);
    const ask = question && store.getAsk(question.askId);
    if (ask?.status === 'open')
      store.settleAsk(
        ask,
        approved ? 'done' : 'dropped',
        approved ? 'Codex setup approved.' : 'Codex setup declined.',
        Date.now()
      );
  };
  return {
    async open(id: string) {
      if (store.getQuestion(id)) return;
      const askId = neoDerivedId(`codex-setup:${id}`);
      const now = Date.now();
      const ask =
        store.getAsk(askId) ??
        store.openAsk({
          id: askId,
          sessionId: await ensureNeo(),
          projectId: null,
          originMessageId: null,
          title,
          request: text,
          createdAt: now,
        });
      openHumanCard(
        store,
        id,
        ask.id,
        { ...choiceCard(text, ['Set up Codex', 'Keep current setup']), todos: [] },
        now
      );
    },
    answer(id: string) {
      const question = store.getQuestion(id);
      return question?.state === 'answered' ? humanPickedApply(question) : undefined;
    },
    retire: settle,
  };
}
