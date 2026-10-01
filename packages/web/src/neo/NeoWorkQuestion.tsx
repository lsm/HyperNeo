import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { useNeoWorkQuestionObserver } from './useNeoWorkQuestionObserver.ts';
import { NeoWorkQuestionControls } from './NeoWorkQuestionControls.tsx';

export function NeoWorkQuestion({ work }: { work: NeoWork }) {
  const observation = useNeoWorkQuestionObserver(work);
  return <NeoWorkQuestionControls work={work} observation={observation} />;
}
