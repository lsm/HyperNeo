export function isSpaceActionsDispatcherEnabled(): boolean {
  const v = process.env.HYPERNEO_SPACE_ACTIONS_DISPATCHER;
  return v === '1' || v === 'true';
}
