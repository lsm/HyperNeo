import { mergeConfig } from 'vitest/config';
import online from './vitest.online.config.ts';

export default mergeConfig(online, {
  test: { include: ['tests/reproductions/spent-admission-restart.proof.ts'] },
});
