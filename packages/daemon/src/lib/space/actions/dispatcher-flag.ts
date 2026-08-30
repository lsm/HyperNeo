export function isSpaceActionsDispatcherEnabled(): boolean {
  const v = process.env.HYPERNEO_SPACE_ACTIONS_DISPATCHER;
  if (v === undefined) return true;
  return v === '1' || v === 'true';
}
