import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { NeoAskSessionView } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import type { PlaceGroup, WorkRef, WorkStatus } from '../drivers/types.ts';
import type { Logger } from '../logger.ts';
import { invokeOperation } from '../operations/invoke.ts';
import type { OperationRegistry } from '../operations/registry.ts';
import { readDriverLastInputAt, readDriverLive, readDriverOpenedPrs } from './driver-work.ts';
import {
  describeNeoAskSessions,
  keepNeoSessionPrs,
  linkNeoSessionsToAsks,
  type NeoAskPrs,
  type NeoSessionAskLink,
  planNeoHeldSessionNotices,
  planNeoSessionPrReads,
} from './session-ask-links.ts';
import {
  keepNeoSessionNoticeGroups,
  keepNeoSessionNotices,
  listNeoWatchedSessions,
  neoSessionNoticeGroup,
  planNeoSessionNotice,
  planNeoSessionNoticeGroup,
  planNeoSessionWatch,
  savedNeoSessionNoticeGroups,
  NEO_SESSION_GROUPS_MAX,
  NEO_SESSION_WATCH_LIMIT,
  type NeoListedSession,
  type NeoSessionNotice,
  type NeoSessionNoticeGroup,
  type NeoSessionSeen,
} from './session-watch.ts';

export type NeoSessionWatcherDeps = {
  db: Pick<Database, 'getSDKMessageRepo'>;
  rootSessionId: () => string | undefined;
  announceSessionNoticeGroup: (group: NeoSessionNoticeGroup) => void;
  announceSessionNotice: (notice: NeoSessionNotice) => void;
  log: Logger;
  registry: () => OperationRegistry;
  followedCardRefs: (now: number) => WorkRef[];
  mutedSessions: () => readonly string[] | undefined;
  liveAskPrs: () => NeoAskPrs[];
  sessionBranchPrs: (ref: WorkRef | null) => Promise<string[]>;
  notifyChanged: () => void;
};

export class NeoSessionWatcher {
  sessionNotices: NeoSessionNotice[] = [];
  sessionNoticeGroups: NeoSessionNoticeGroup[] = [];
  openSessionNotices: NeoSessionNotice[] = [];
  askSessions = new Map<string, NeoAskSessionView[]>();
  private readonly sessionsSeen = new Map<string, NeoSessionSeen>();
  private sessionPrs = new Map<string, string[]>();
  private sessionPrsCheckedAt = new Map<string, number>();
  private heldSessionNotices = new Map<string, NeoSessionNotice>();

  constructor(private readonly deps: NeoSessionWatcherDeps) {}

  readonly watchSessions = (superpipe({})('neo-session-watch') as PipelineAPI)
    .input(['now'])
    .pipe(
      () => {
        const root = this.deps.rootSessionId();
        return root ? { value: root } : { reason: 'no_root' as const };
      },
      'now',
      'result:root'
    )
    .pipe(
      async (root: string, now: number) => {
        const outcome = await invokeOperation(
          this.deps.registry(),
          'work.find',
          { localOnly: true, limit: NEO_SESSION_WATCH_LIMIT },
          { source: 'internal', sessionId: root, role: 'neo' }
        );
        const value =
          outcome.kind === 'completed'
            ? (outcome.value as {
                places?: PlaceGroup[];
                unreachable?: unknown[];
                more?: boolean;
              } | null)
            : null;
        return {
          sessions: listNeoWatchedSessions(
            value?.places ?? [],
            this.deps.followedCardRefs(now),
            now,
            this.deps.mutedSessions()
          ),
          complete: !!value?.places && !value.unreachable?.length && !value.more,
        };
      },
      ['root', 'now'],
      'listed'
    )
    .pipe(
      (listed: { sessions: NeoListedSession[]; complete: boolean }) =>
        planNeoSessionWatch(listed.sessions, this.sessionsSeen),
      'listed',
      'plan'
    )
    .pipe(
      (
        listed: { sessions: NeoListedSession[]; complete: boolean },
        plan: ReturnType<typeof planNeoSessionWatch>,
        now: number
      ) => ({
        sessions: planNeoSessionPrReads(
          listed.sessions,
          this.sessionPrs,
          plan.reads,
          this.sessionPrsCheckedAt,
          now
        ),
      }),
      ['listed', 'plan', 'now'],
      'prReads'
    )
    .pipe(
      async (
        root: string,
        plan: ReturnType<typeof planNeoSessionWatch>,
        prReads: { sessions: NeoListedSession[] }
      ) => {
        const sessions = [...plan.reads, ...prReads.sessions];
        const reads = await Promise.all(
          sessions.map(async (session) => {
            const outcome = await invokeOperation(
              this.deps.registry(),
              'work.status',
              { ref: session.ref },
              { source: 'internal', sessionId: root, role: 'neo' }
            );
            const live = readDriverLive(outcome);
            return live
              ? {
                  detail: { status: live.status, lastInputAt: readDriverLastInputAt(outcome) },
                  opened: [
                    ...readDriverOpenedPrs(outcome),
                    ...(await this.deps.sessionBranchPrs(session.ref)),
                  ],
                }
              : null;
          })
        );
        return {
          details: reads.slice(0, plan.reads.length).map((read) => read?.detail ?? null),
          statuses: new Map(
            prReads.sessions.flatMap((session, index) => {
              const detail = reads[plan.reads.length + index]?.detail;
              return detail ? [[session.key, detail.status] as const] : [];
            })
          ),
          found: new Map(
            sessions.flatMap((session, index) => {
              const opened = reads[index]?.opened;
              return opened ? [[session.key, opened] as const] : [];
            })
          ),
        };
      },
      ['root', 'plan', 'prReads'],
      'read'
    )
    .pipe(
      (
        plan: ReturnType<typeof planNeoSessionWatch>,
        read: { details: ({ status: WorkStatus; lastInputAt: number | null } | null)[] },
        now: number
      ) => ({
        planned: plan.reads.map((session, index) =>
          planNeoSessionNotice(
            session,
            this.sessionsSeen.get(session.key)!,
            read.details[index],
            now
          )
        ),
      }),
      ['plan', 'read', 'now'],
      'notices'
    )
    .pipe(
      (
        listed: { sessions: NeoListedSession[]; complete: boolean },
        read: { found: ReadonlyMap<string, readonly string[]> }
      ) => {
        const kept = keepNeoSessionPrs(this.sessionPrs, read.found);
        const keep = new Set(listed.sessions.map((session) => session.key));
        const prs = listed.complete ? new Map([...kept].filter(([key]) => keep.has(key))) : kept;
        const watched = new Map([...prs].filter(([key, urls]) => keep.has(key) && urls.length));
        const asks = watched.size ? this.deps.liveAskPrs() : [];
        return { prs, links: linkNeoSessionsToAsks(asks, watched) };
      },
      ['listed', 'read'],
      'linked'
    )
    .pipe(
      (
        listed: { sessions: NeoListedSession[] },
        plan: ReturnType<typeof planNeoSessionWatch>,
        notices: { planned: ReturnType<typeof planNeoSessionNotice>[] },
        linked: { links: NeoSessionAskLink[] }
      ) => {
        const shown = new Set(listed.sessions.map((session) => session.key));
        const read = new Map(
          plan.reads.map((session, index) => [session.key, notices.planned[index]?.seen.status])
        );
        const next = planNeoHeldSessionNotices(
          this.heldSessionNotices,
          notices.planned.flatMap((item) => (item.notice ? [item.notice] : [])),
          new Set(linked.links.map((link) => link.key)),
          (key) =>
            shown.has(key) ? (read.get(key) ?? this.sessionsSeen.get(key)?.status) : undefined
        );
        this.heldSessionNotices = next.held;
        return { notices: next.notices };
      },
      ['listed', 'plan', 'notices', 'linked'],
      'added'
    )
    .pipe(
      (added: { notices: NeoSessionNotice[] }, now: number) =>
        planNeoSessionNoticeGroup(this.openSessionNotices, added.notices, now),
      ['added', 'now'],
      'grouped'
    )
    .pipe(
      (
        listed: { sessions: NeoListedSession[]; complete: boolean },
        plan: ReturnType<typeof planNeoSessionWatch>,
        notices: { planned: ReturnType<typeof planNeoSessionNotice>[] },
        read: { statuses: ReadonlyMap<string, WorkStatus>; found: ReadonlyMap<string, unknown> },
        now: number
      ) => {
        const keep = new Set(listed.sessions.map((session) => session.key));
        if (listed.complete)
          for (const key of [...this.sessionsSeen.keys()])
            if (!keep.has(key)) this.sessionsSeen.delete(key);
        for (const [key, seen] of plan.baseline) this.sessionsSeen.set(key, seen);
        plan.reads.forEach((session, index) =>
          this.sessionsSeen.set(session.key, notices.planned[index].seen)
        );
        for (const [key, status] of read.statuses) {
          const seen = this.sessionsSeen.get(key);
          if (seen) this.sessionsSeen.set(key, { ...seen, status });
        }
        for (const key of read.found.keys()) this.sessionPrsCheckedAt.set(key, now);
        for (const key of [...this.sessionPrsCheckedAt.keys()])
          if (!this.sessionsSeen.has(key)) this.sessionPrsCheckedAt.delete(key);
      },
      ['listed', 'plan', 'notices', 'read', 'now']
    )
    .pipe(
      (
        root: string,
        listed: { sessions: NeoListedSession[]; complete: boolean },
        linked: { prs: Map<string, string[]>; links: NeoSessionAskLink[] },
        added: { notices: NeoSessionNotice[] },
        grouped: ReturnType<typeof planNeoSessionNoticeGroup>
      ) => {
        const askSessions = describeNeoAskSessions(
          linked.links,
          listed.sessions,
          (session) => this.sessionsSeen.get(session.key)?.status ?? session.status
        );
        const moved = JSON.stringify([...askSessions]) !== JSON.stringify([...this.askSessions]);
        this.sessionPrs = linked.prs;
        this.askSessions = askSessions;
        this.openSessionNotices = grouped.open;
        this.sessionNotices = keepNeoSessionNotices(this.sessionNotices, added.notices);
        for (const notice of added.notices) this.deps.announceSessionNotice(notice);
        for (const group of grouped.closed) this.postSessionNoticeGroup(root, group);
        if (added.notices.length || grouped.closed.length || moved) this.deps.notifyChanged();
      },
      ['root', 'listed', 'linked', 'added', 'grouped']
    )
    .endAsync('root') as (now: number) => Promise<unknown>;

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
