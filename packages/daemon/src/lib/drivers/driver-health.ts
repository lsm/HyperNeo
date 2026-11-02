import { randomUUID } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { DriverHealth } from '@hyperneo/shared/types/settings';

type Observation = Pick<DriverHealth, 'status' | 'reason' | 'clientVersions'>;
const UNVERIFIED_GUIDANCE =
  ' Unverified client version; still usable if health is ok. Schedule its verify journey.';
type Dependencies = {
  ids: readonly string[];
  now(): number;
  read(): Promise<Record<string, DriverHealth>>;
  save(id: string, health: DriverHealth): Promise<void>;
  probe(id: string): Promise<Observation>;
  notify(id: string, text: string): Promise<boolean>;
};

function newer(installed: string, verified?: string): boolean {
  if (!verified) return true;
  const parts = (value: string) => value.match(/\d+/g)?.map(Number) ?? [];
  const current = parts(installed);
  const baseline = parts(verified);
  if (!current.length || !baseline.length) return installed !== verified;
  for (let i = 0; i < Math.max(current.length, baseline.length); i++) {
    const delta = (current[i] ?? 0) - (baseline[i] ?? 0);
    if (delta) return delta > 0;
  }
  return false;
}

export function createDriverHealthMonitor(deps: Dependencies) {
  let checking: Promise<void> | undefined;
  let checkingForced = false;
  let mutation: Promise<void> = Promise.resolve();
  const exclusive = <T>(task: () => Promise<T>) => {
    const next = mutation.then(task);
    mutation = next.then(
      () => {},
      () => {}
    );
    return next;
  };
  const flush = async (id: string, health: DriverHealth) => {
    for (const notice of [...(health.pendingNotices ?? [])]) {
      if (!(await deps.notify(notice.id, notice.text))) return;
      health.notifiedSignature = notice.signature;
      health.pendingNotices!.shift();
      await deps.save(id, health);
    }
  };
  const checkDriver = async (id: string, force: boolean) => {
    const previous = (await deps.read())[id];
    if (previous) await flush(id, previous);
    if (!force && previous && deps.now() - previous.checkedAt < 86_400_000) return;
    const observation = await deps.probe(id).catch(
      (error: unknown): Observation => ({
        status: 'unavailable',
        reason: error instanceof Error ? error.message : String(error),
        clientVersions: previous?.clientVersions ?? {},
      })
    );
    const health: DriverHealth = {
      ...previous,
      ...observation,
      checkedAt: deps.now(),
      unverifiedVersion: Object.entries(observation.clientVersions).some(([name, version]) =>
        newer(version, previous?.verifiedVersions?.[name])
      ),
    };
    const signature = JSON.stringify([
      health.status,
      health.reason,
      health.unverifiedVersion ? health.clientVersions : null,
    ]);
    if (
      signature !== (health.pendingNotices?.at(-1)?.signature ?? health.notifiedSignature) &&
      (health.status !== 'ok' ||
        health.unverifiedVersion ||
        (previous?.status !== undefined && previous.status !== 'ok'))
    ) {
      const state =
        health.status === 'ok' && previous && previous.status !== 'ok'
          ? 'recovered'
          : health.status;
      health.pendingNotices = [
        ...(health.pendingNotices ?? []),
        {
          id: randomUUID(),
          kind: health.status === 'ok' && state !== 'recovered' ? 'version' : 'health',
          signature,
          text: `Driver health: ${id} ${state}. ${health.reason} Client versions: ${JSON.stringify(health.clientVersions)}. Checked ${new Date(health.checkedAt).toISOString()}.${health.unverifiedVersion ? UNVERIFIED_GUIDANCE : ''}`,
        },
      ];
    }
    await deps.save(id, health);
    await flush(id, health);
  };
  const run = (superpipe({})('local-driver-health') as PipelineAPI)
    .input('force')
    .pipe(async (force: boolean) => {
      const failures: unknown[] = [];
      for (const id of deps.ids) {
        try {
          await checkDriver(id, force);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw failures[0];
    }, 'force')
    .endAsync() as (force: boolean) => Promise<void>;
  return {
    async nextCheckAt(): Promise<number> {
      const results = Object.values(await deps.read());
      return results.length && !results.some((result) => result.pendingNotices?.length)
        ? Math.min(...results.map((result) => result.checkedAt + 86_400_000))
        : deps.now() + 60_000;
    },
    check(force = false): Promise<void> {
      if (checking) {
        const requested = () => this.check(true);
        return force && !checkingForced ? checking.then(requested, requested) : checking;
      }
      checkingForced = force;
      return (checking = exclusive(() => run(force)).finally(() => {
        checking = undefined;
        checkingForced = false;
      }));
    },
    verified(id: string, journey: string, versions: Record<string, string>): Promise<DriverHealth> {
      return exclusive(async () => {
        const health = (await deps.read())[id];
        if (!health || health.status !== 'ok')
          throw new Error('Only a healthy driver can record a passed verify journey.');
        const observed = await deps.probe(id);
        if (
          observed.status !== 'ok' ||
          Object.keys(versions).length !== Object.keys(observed.clientVersions).length ||
          Object.entries(observed.clientVersions).some(
            ([key, version]) => versions[key] !== version
          )
        )
          throw new Error(
            'Installed client version changed or does not match the passed verify journey.'
          );
        const verified = {
          ...health,
          ...observed,
          checkedAt: deps.now(),
          verifiedVersions: versions,
          verifiedAt: deps.now(),
          verifiedJourney: journey,
          unverifiedVersion: false,
          pendingNotices: health.pendingNotices
            ?.filter((notice) => notice.kind !== 'version')
            .map((notice) => ({ ...notice, text: notice.text.replace(UNVERIFIED_GUIDANCE, '') })),
          notifiedSignature: JSON.stringify([observed.status, observed.reason, null]),
        };
        await deps.save(id, verified);
        return verified;
      });
    },
  };
}
