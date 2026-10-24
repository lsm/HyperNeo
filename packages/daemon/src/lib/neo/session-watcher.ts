import type { SDKMessage } from '@hyperneo/shared/sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/database.ts';
import type { PlaceGroup, WorkRef, WorkStatus } from '../drivers/types.ts';
import type { NeoSessionSeenRepository } from '../../storage/repositories/neo-session-seen-repository.ts';
import type { Logger } from '../logger.ts';
import { invokeOperation } from '../operations/invoke.ts';
import type { OperationRegistry } from '../operations/registry.ts';
import { readDriverLastInputAt, readDriverLive, readDriverSessionFacts } from './driver-work.ts';
import type { NeoSessionFacts } from './pack-contract.ts';
import { keepNeoSessionPrs, planNeoSessionPrReads } from './session-ask-links.ts';
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
  db: Pick<Database, 'getSDKMessageRepo' | 'writeSDKMessage'>;
  defaultSessionId: () => string | undefined;
  announceSessionNoticeGroup: (group: NeoSessionNoticeGroup) => void;
  announceSessionNotice: (notice: NeoSessionNotice) => void;
  log: Logger;
  seen: Pick<NeoSessionSeenRepository, 'list' | 'replace'>;
  registry: () => OperationRegistry;
  followedCardRefs: (now: number) => WorkRef[];
  mutedSessions: () => readonly string[] | undefined;
  sessionBranchPrs: (ref: WorkRef) => Promise<string[]>;
  readRemotes: (folder: string) => Promise<string[]>;
  observeSessions: (sessions: NeoSessionFacts[]) => Promise<void>;
  notifyChanged: () => void;
};

export class NeoSessionWatcher {
  sessionNotices: NeoSessionNotice[] = [];
  sessionNoticeGroups: NeoSessionNoticeGroup[] = [];
  openSessionNotices: NeoSessionNotice[] = [];
  private readonly sessionsSeen: Map<string, NeoSessionSeen>;
  private savedSeen: string;
  private sessionPrs = new Map<string, string[]>();
  private sessionPrsCheckedAt = new Map<string, number>();

  constructor(private readonly deps: NeoSessionWatcherDeps) {
    this.sessionsSeen = new Map(deps.seen.list());
    this.savedSeen = JSON.stringify([...this.sessionsSeen]);
  }

  readonly watchSessions = (superpipe({})('neo-session-watch') as PipelineAPI)
    .input(['now'])
    .pipe(
      () => {
        const root = this.deps.defaultSessionId();
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
            const facts = live ? readDriverSessionFacts(outcome) : null;
            return live && facts
              ? {
                  detail: { status: live.status, lastInputAt: readDriverLastInputAt(outcome) },
                  facts: {
                    ...facts,
                    ref: session.ref,
                    status: live.status,
                    lastActivityAt: session.lastActivityAt,
                    remotes: facts.folder ? await this.deps.readRemotes(facts.folder) : [],
                  },
                  branchPrs: await this.deps.sessionBranchPrs(session.ref),
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
          facts: reads.flatMap((read) => (read ? [read.facts] : [])),
          found: new Map(
            sessions.flatMap((session, index) => {
              const read = reads[index];
              const facts = read?.facts;
              return facts
                ? [
                    [
                      session.key,
                      [
                        ...facts.openedPrs,
                        ...(facts.linkedPrs ?? []).flatMap((pr) => (pr.dismissed ? [] : [pr.url])),
                        ...read.branchPrs,
                      ],
                    ] as const,
                  ]
                : [];
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
        return { prs };
      },
      ['listed', 'read'],
      'linked'
    )
    .pipe((read: { facts: NeoSessionFacts[] }) => this.deps.observeSessions(read.facts), 'read')
    .pipe(
      (notices: { planned: ReturnType<typeof planNeoSessionNotice>[] }) => ({
        notices: notices.planned.flatMap((item) => (item.notice ? [item.notice] : [])),
      }),
      'notices',
      'added'
    )
    .pipe(
      (added: { notices: NeoSessionNotice[] }, now: number) =>
        planNeoSessionNoticeGroup(this.openSessionNotices, added.notices, now),
      ['added', 'now'],
      'grouped'
    )
    .pipe(
      async (
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
        await this.saveSeen();
      },
      ['listed', 'plan', 'notices', 'read', 'now']
    )
    .pipe(
      async (
        root: string,
        listed: { sessions: NeoListedSession[]; complete: boolean },
        linked: { prs: Map<string, string[]> },
        added: { notices: NeoSessionNotice[] },
        grouped: ReturnType<typeof planNeoSessionNoticeGroup>
      ) => {
        this.sessionPrs = linked.prs;
        this.openSessionNotices = grouped.open;
        this.sessionNotices = keepNeoSessionNotices(this.sessionNotices, added.notices);
        for (const notice of added.notices) this.deps.announceSessionNotice(notice);
        for (const group of grouped.closed) await this.postSessionNoticeGroup(root, group);
        if (added.notices.length || grouped.closed.length) this.deps.notifyChanged();
      },
      ['root', 'listed', 'linked', 'added', 'grouped']
    )
    .endAsync('root') as (now: number) => Promise<unknown>;

  private async saveSeen(): Promise<void> {
    const entries = [...this.sessionsSeen];
    const signature = JSON.stringify(entries);
    if (signature === this.savedSeen) return;
    try {
      await this.deps.seen.replace(entries);
      this.savedSeen = signature;
    } catch (error) {
      this.deps.log.warn('Neo session watch state could not be saved', error);
    }
  }

  async flushSessionNoticeGroup(): Promise<void> {
    const group = neoSessionNoticeGroup(this.openSessionNotices);
    this.openSessionNotices = [];
    const root = group && this.deps.defaultSessionId();
    if (!group || !root) return;
    try {
      await this.postSessionNoticeGroup(root, group);
    } catch (error) {
      this.deps.log.warn('Neo session notice group could not be saved at shutdown', error);
    }
  }

  loadSessionNoticeGroups(): void {
    const root = this.deps.defaultSessionId();
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

  async postSessionNoticeGroup(root: string, group: NeoSessionNoticeGroup): Promise<void> {
    if (this.sessionNoticeGroups.some((kept) => kept.id === group.id)) return;
    const saved = await this.deps.db.writeSDKMessage('saveSDKMessage', root, {
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
