import { useSignal } from '@preact/signals';
import { useEffect, useRef } from 'preact/hooks';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { AppSkill, Session, SessionMcpServerEntry } from '@hyperneo/shared';
import type { SessionToolInventory } from '@hyperneo/shared/types/observed-tool-inventory';
import type {
  SessionToolApplication,
  SessionToolChoiceKey,
  SessionToolSelection,
} from '@hyperneo/shared/types/session-tool-choice';
import { connectionManager } from '../lib/connection-manager.ts';
import { computeObservedRuntimeState } from './ToolsModal.utils.ts';

type Input = { sessionId: string; key: SessionToolChoiceKey; selected: boolean };
type Result = ({ ok: true } & SessionToolApplication) | { ok: false; reason: string };
const activate = (superpipe({})('use-session-tool') as PipelineAPI)
  .input(['input'])
  .pipe(() => connectionManager.getHub(), 'input', 'hub')
  .pipe(
    (hub: Awaited<ReturnType<typeof connectionManager.getHub>>, input: Input) =>
      hub.request<Result>('operation.invoke', { name: 'session.tools.setChoice', input }),
    ['hub', 'input'],
    'reply'
  )
  .endAsync('reply') as (input: Input) => Promise<Result>;
const applicationLabels = {
  live: 'Saved · applied to the running session',
  next_query: 'Saved · applies to the next query',
  restart_required: 'Saved · restart required; your session was not interrupted',
  unverified: 'Saved · attachment could not be verified',
};

interface Props {
  session: Session;
  skills: readonly AppSkill[];
  servers: readonly SessionMcpServerEntry[];
  inventory: SessionToolInventory | null;
  onApplied: () => void;
}
export function SessionToolChoices({ session, skills, servers, inventory, onApplied }: Props) {
  const choices = useSignal<SessionToolSelection['choices']>({});
  const pending = useSignal<SessionToolChoiceKey | null>(null);
  const search = useSignal('');
  const notices = useSignal<Partial<Record<SessionToolChoiceKey, string>>>({});
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    choices.value = session.config.toolSelection?.choices ?? {};
  }, [session.config.toolSelection]);
  const choose = async (key: SessionToolChoiceKey, selected: boolean) => {
    pending.value = key;
    try {
      const result = await activate({ sessionId: session.id, key, selected });
      if (!active.current) return;
      if (result.ok) {
        choices.value = { ...choices.value, [key]: { ...choices.value[key], selected } };
        notices.value = {
          ...notices.value,
          [key]: applicationLabels[result.application],
        };
        onApplied();
      } else {
        notices.value = {
          ...notices.value,
          [key]: `Choice was not saved: ${result.reason.replaceAll(/[-_]/g, ' ')}`,
        };
      }
    } catch {
      if (active.current)
        notices.value = { ...notices.value, [key]: 'Could not save the choice. Try again.' };
    } finally {
      if (active.current) pending.value = null;
    }
  };
  const rows = [
    ...servers.map(({ server }) => {
      const wrapper = skills.find(
        (skill) => skill.config.type === 'mcp_server' && skill.config.appMcpServerId === server.id
      );
      const key = `mcp:${server.id}` as const;
      const aliases = choices.value[key]?.aliases;
      return {
        key,
        title: wrapper?.displayName ?? server.name,
        observed: (aliases?.length ? aliases : [wrapper?.name ?? server.name])
          .map((name) => computeObservedRuntimeState(inventory, name).label)
          .join(' · '),
      };
    }),
    ...skills
      .filter((skill) => skill.config.type !== 'mcp_server')
      .map((skill) => {
        const name = skill.config.type === 'builtin' ? skill.config.commandName : skill.name;
        return {
          key: `skill:${skill.id}` as const,
          title: skill.displayName,
          observed:
            inventory?.skills.includes(name) || inventory?.plugins.includes(skill.name)
              ? 'Instructions loaded · prerequisites unverified'
              : computeObservedRuntimeState(inventory, name).label,
        };
      }),
  ];
  return (
    <section aria-label="Use tools in this session" class="space-y-2">
      <p class="text-xs text-fg-muted">
        Use here saves one choice for this session. Running attachment is shown separately.
      </p>
      <input
        type="search"
        aria-label="Filter tools"
        placeholder="Filter tools…"
        value={search.value}
        onInput={(event) => {
          search.value = event.currentTarget.value;
        }}
        class="w-full rounded border border-line bg-surface px-2 py-1 text-sm text-fg-soft"
      />
      {rows
        .filter((row) => row.title.toLowerCase().includes(search.value.trim().toLowerCase()))
        .map((row) => {
          const selected = choices.value[row.key]?.selected ?? false;
          return (
            <div key={row.key} class="rounded-lg bg-surface-raised p-2 space-y-1">
              <div class="flex items-center justify-between gap-2">
                <span class="text-sm text-fg-soft">{row.title}</span>
                <button
                  type="button"
                  class="text-xs text-accent shrink-0"
                  aria-label={`${selected ? 'Stop using here' : 'Use here'}: ${row.title}`}
                  disabled={pending.value !== null || !session.config.toolSelection}
                  onClick={() => void choose(row.key, !selected)}
                >
                  {pending.value === row.key
                    ? 'Saving…'
                    : selected
                      ? 'Stop using here'
                      : 'Use here'}
                </button>
              </div>
              <div class="text-xs text-fg-muted">Saved choice: {selected ? 'on' : 'off'}</div>
              <div class="text-xs text-fg-muted break-words">{row.observed}</div>
              {notices.value[row.key] && (
                <div role="status" class="text-xs text-fg-soft break-words">
                  {notices.value[row.key]}
                </div>
              )}
            </div>
          );
        })}
    </section>
  );
}
