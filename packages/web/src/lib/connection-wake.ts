export type ConnectionWakeEvent =
  | 'hidden'
  | 'hidden_settled'
  | 'visible'
  | 'pageshow'
  | 'network'
  | 'online_settled';

export interface ConnectionWakeState {
  hidden: boolean;
  reachable: boolean;
  hasTransport: boolean;
  suspended: boolean;
  ready: boolean;
  resumeWaiting: boolean;
}

export type ConnectionWakeAction =
  | 'none'
  | 'schedule_suspend'
  | 'suspend'
  | 'suspend_now'
  | 'resume'
  | 'validate'
  | 'schedule_online'
  | 'force_reconnect';

export function decideConnectionWake(
  event: ConnectionWakeEvent,
  state: ConnectionWakeState
): ConnectionWakeAction {
  switch (event) {
    case 'hidden':
      return 'schedule_suspend';
    case 'hidden_settled':
      return state.hidden ? 'suspend' : 'none';
    case 'visible':
      if (state.suspended) return state.reachable ? 'resume' : 'none';
      return state.resumeWaiting ? 'none' : 'validate';
    case 'pageshow':
      return !state.hidden && state.reachable && state.suspended ? 'resume' : 'none';
    case 'network':
      return state.reachable ? 'schedule_online' : 'suspend_now';
    case 'online_settled':
      if (state.hidden || !state.reachable || !state.hasTransport) return 'none';
      if (state.suspended) return 'resume';
      return state.ready ? 'none' : 'force_reconnect';
  }
}
