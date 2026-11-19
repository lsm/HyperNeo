import type { SessionEvent } from '@github/copilot-sdk';
import { readCopilotHistory } from './copilot-history.ts';
import { projectCopilotEvent } from './copilot-worker.ts';
import { recentWorkInputs, workInput, TURN_REPLIES } from './work-messages.ts';
import { readTurnUrls } from '../../storage/hyperneo-turn-facts-read.ts';
import { reject } from './work-operations.ts';
import type { WorkInput, WorkDetail, WorkTurnFact, Result } from './types.ts';

type State = Parameters<typeof projectCopilotEvent>[0];

function readCopilotInputs(
  file: string,
  id: string,
  inputs: State['inputs'],
  known: (inputId: string) => boolean
) {
  let state: State = { status: 'queued', inputs: {} };
  readCopilotHistory(file, id, undefined, 10, 10, undefined, undefined, (event) => {
    const inputId = event.type === 'user.message' ? event.data.messageId : undefined;
    if (
      !event.agentId &&
      inputId &&
      !Object.hasOwn(state.inputs, inputId) &&
      ['done', 'failed', 'stopped'].includes(state.status)
    )
      state.status = 'queued';
    if (!event.agentId && inputId && !Object.hasOwn(state.inputs, inputId) && known(inputId))
      state.inputs[inputId] = {
        state: 'pending',
        replyReport: '',
        replyAvailability: 'incomplete',
        human: false,
      };
    state = projectCopilotEvent(state, {
      ...event,
      id: event.id ?? event.timestamp,
      parentId: null,
    } as SessionEvent);
    const retained = Object.keys(state.inputs);
    if (retained.length > 64) delete state.inputs[retained[0]];
  });
  const observations = { ...state.inputs };
  for (const [inputId, input] of Object.entries(inputs))
    observations[inputId] = { ...observations[inputId], ...input };
  return observations;
}

export function readCopilotTurnFacts(
  file: string,
  id: string,
  cursor?: string,
  limit = 10,
  inputs: State['inputs'] = {}
): Result<{ turns: WorkTurnFact[] }> {
  const turns: Omit<WorkTurnFact, 'cursor'>[] = [];
  for (const [inputId, input] of Object.entries(readCopilotInputs(file, id, inputs, () => false))) {
    const { at, endedAt, outcome } = input;
    if (
      input.state !== 'observed' ||
      at === undefined ||
      endedAt === undefined ||
      !outcome ||
      !Number.isFinite(at) ||
      !Number.isFinite(endedAt) ||
      endedAt < 0
    )
      continue;
    const finalUrls = readTurnUrls([input.replyReport]);
    turns.push({
      id: inputId,
      startedAt: at,
      endedAt,
      ended: outcome,
      inputs: [inputId],
      urls: finalUrls,
      finalUrls,
      complete: input.replyAvailability === 'complete',
    });
  }
  turns.sort((a, b) => a.endedAt - b.endedAt || a.id.localeCompare(b.id));
  let consumed = 0;
  const indexed = turns.map((turn, index) => {
    const seq = turn.endedAt;
    consumed = turns[index - 1]?.endedAt === seq ? consumed + 1 : 0;
    return { ...turn, cursor: JSON.stringify({ seq, consumed }) };
  });
  const offset = cursor ? indexed.findIndex((turn) => turn.cursor === cursor) + 1 : 0;
  if (cursor && !offset)
    return reject('not_found', 'Copilot turn cursor is outside retained history.');
  return { ok: true, value: { turns: indexed.slice(offset, offset + limit) } };
}

export function readCopilotObservations(
  file: string,
  id: string,
  inputs: State['inputs'],
  known: (inputId: string) => boolean,
  since?: number
) {
  const recentInputs: WorkInput[] = [];
  const turnEnds: NonNullable<WorkDetail['turnEnds']> = [];
  const observations = readCopilotInputs(file, id, inputs, known);
  for (const [inputId, input] of Object.entries(observations)) {
    if (input.state !== 'observed' || input.at === undefined || !Number.isFinite(input.at))
      continue;
    const entry = workInput(input.at, input.text ?? '', input.human, inputId);
    if (entry) recentInputs.push(entry);
    if (since !== undefined && input.endedAt !== undefined && input.endedAt > since)
      turnEnds.push({
        id: inputId,
        startedAt: input.at,
        at: input.endedAt,
        message: input.replyReport,
      });
  }
  recentInputs.sort((a, b) => a.at - b.at);
  const ends = turnEnds.sort((a, b) => a.at - b.at).slice(-TURN_REPLIES);
  const ended = new Set(ends.map((turn) => turn.id));
  const selected = new Set(
    since === undefined
      ? recentWorkInputs(recentInputs)
      : recentWorkInputs(
          [
            ...recentInputs.filter((input) => ended.has(input.inputId!)),
            ...recentInputs.filter((input) => !ended.has(input.inputId!)).reverse(),
          ],
          since
        )
  );
  return {
    recentInputs: recentInputs.filter((input) => selected.has(input)),
    turnEnds: ends,
  };
}
