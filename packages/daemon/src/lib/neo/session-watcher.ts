import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { Database } from '../../storage/database.ts';
import type { Logger } from '../logger.ts';
import {
  keepNeoSessionNoticeGroups,
  neoSessionNoticeGroup,
  savedNeoSessionNoticeGroups,
  NEO_SESSION_GROUPS_MAX,
  type NeoSessionNotice,
  type NeoSessionNoticeGroup,
} from './session-watch.ts';

export type NeoSessionWatcherDeps = {
  db: Pick<Database, 'getSDKMessageRepo'>;
  rootSessionId: () => string | undefined;
  announceSessionNoticeGroup: (group: NeoSessionNoticeGroup) => void;
  log: Logger;
};

export class NeoSessionWatcher {
  sessionNotices: NeoSessionNotice[] = [];
  sessionNoticeGroups: NeoSessionNoticeGroup[] = [];
  openSessionNotices: NeoSessionNotice[] = [];

  constructor(private readonly deps: NeoSessionWatcherDeps) {}

  flushSessionNoticeGroup(): void {
    const group = neoSessionNoticeGroup(this.openSessionNotices);
    this.openSessionNotices = [];
    const root = group && this.deps.rootSessionId();
    if (!group || !root) return;
    try {
      this.postSessionNoticeGroup(root, group);
    } catch (error) {
      this.deps.log.warn('Neo session notice group could not be saved at shutdown', error);
    }
  }

  loadSessionNoticeGroups(): void {
    const root = this.deps.rootSessionId();
    if (!root) return;
    try {
      this.sessionNoticeGroups = savedNeoSessionNoticeGroups(
        this.deps.db
          .getSDKMessageRepo()
          .getLatestSDKMessagesByType(root, 'system', 'session_notices', NEO_SESSION_GROUPS_MAX)
      );
    } catch (error) {
      this.deps.log.warn('Neo session notice groups could not be reloaded', error);
    }
  }

  postSessionNoticeGroup(root: string, group: NeoSessionNoticeGroup): void {
    if (this.sessionNoticeGroups.some((kept) => kept.id === group.id)) return;
    const saved = this.deps.db.getSDKMessageRepo().saveSDKMessage(root, {
      type: 'system',
      subtype: 'session_notices',
      uuid: group.id,
      session_id: root,
      content: group.line,
      group,
    } as unknown as SDKMessage);
    if (!saved) {
      this.deps.log.warn(`Neo session notice group ${group.id} could not be saved`);
      return;
    }
    this.sessionNoticeGroups = keepNeoSessionNoticeGroups(this.sessionNoticeGroups, group);
    this.deps.announceSessionNoticeGroup(group);
  }
}
