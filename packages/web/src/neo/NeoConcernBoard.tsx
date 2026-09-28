import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import type { DaemonInventoryLink, DaemonSnapshot } from '@hyperneo/shared/types/daemon-snapshot';
import { connectionManager } from '../lib/connection-manager.ts';
import { connectionState } from '../lib/state.ts';
import { readDaemonInventory } from '../lib/daemon-inventory.ts';
import { NeoIcon } from './NeoIcon.tsx';
import { projectNeoConcernBoard, type NeoConcernBoard } from './neo-concern-board.ts';
import { projectNeoRequestSnapshot, type NeoRequestOrigin } from './request-board.ts';
import { neoBoardReceiptLabel } from './board-receipt-label.ts';

const statusLabels = {
  proposed: 'Your call',
  queued: 'Handed to HyperNeo',
  pending: 'Checking context',
  reported: 'Response ready',
  failed: 'Needs attention',
  cancelled: 'Stopped',
};
const refKey = (ref: DaemonInventoryLink) => JSON.stringify([ref.kind, ref.id]);

export function NeoConcernBoardView({
  board,
  requestScoped = false,
}: {
  board: NeoConcernBoard;
  requestScoped?: boolean;
}) {
  const name = (ref: DaemonInventoryLink) =>
    board.participants.find((item) => refKey(item.ref) === refKey(ref))?.metadata?.name || ref.id;
  return (
    <>
      <p class="mb-4 text-xs leading-relaxed text-fg-muted">
        {requestScoped
          ? 'For this request.'
          : board.concern
            ? `For ${board.concern.title}.`
            : 'Across your concerns.'}{' '}
        These are recorded requests and links, not a second conversation. A response is not verified
        completion.
      </p>
      <h3 class="mb-3 text-sm font-medium">What’s being handled</h3>
      <p class="mb-3 text-xs text-fg-faint">
        Recent handoffs in this view; older receipts may be omitted.
      </p>
      {!board.receipts.length && <p class="text-sm text-fg-muted">No recorded handoffs yet.</p>}
      <ul class="grid gap-3 sm:grid-cols-2" aria-label="Recorded handoffs">
        {board.receipts.map((item) => (
          <li
            key={refKey(item)}
            class="min-w-0 rounded-xl border border-line bg-surface p-4 sm:only:col-span-2"
          >
            <p class="mb-2 flex items-center gap-2 text-xs text-accent">
              <NeoIcon name={item.kind === 'work' ? 'work' : 'context'} />
              {item.kind === 'consultation' && item.status === 'queued'
                ? 'Waiting for context'
                : statusLabels[item.status]}
            </p>
            <p class="break-words text-sm font-medium">
              {neoBoardReceiptLabel(item, board.receipts)}
            </p>
            <details class="mt-3 text-xs text-fg-muted">
              <summary class="cursor-pointer">Request details</summary>
              {item.kind === 'consultation' && (
                <p class="mt-2 whitespace-pre-wrap break-words">{item.question}</p>
              )}
              {item.kind === 'work' && (
                <p class="mt-2 whitespace-pre-wrap break-words">{item.instruction}</p>
              )}
              {(item.kind === 'work' ? item.report : item.answer) && (
                <p class="mt-2 whitespace-pre-wrap break-words">
                  {item.kind === 'work' ? item.report : item.answer}
                </p>
              )}
              <p class="mt-2 break-all">Receipt: {item.id}</p>
              <p class="mt-1 break-all">
                Input: {item.originSessionId} / {item.originMessageId ?? 'not recorded'}
              </p>
            </details>
          </li>
        ))}
      </ul>
      <h3 class="mb-3 mt-6 text-sm font-medium">Who and what is connected</h3>
      <p class="mb-3 text-xs text-fg-muted">
        Session state describes its lifecycle, not whether it is working right now.
      </p>
      <ul class="grid gap-3 sm:grid-cols-2" aria-label="Linked participants">
        {board.participants.map(({ ref, metadata }) => (
          <li
            key={refKey(ref)}
            class="min-w-0 rounded-xl border border-line bg-surface p-4 sm:only:col-span-2"
          >
            <p class="text-xs uppercase tracking-wide text-cat-teal">
              {ref.kind.replace(/[-_]/g, ' ')}
            </p>
            <p class="mt-2 break-words text-sm font-medium">{metadata?.name || ref.id}</p>
            <p class="mt-2 text-xs text-fg-muted">
              {metadata
                ? `Recorded state: ${metadata.status ?? 'not provided'}`
                : 'Details unavailable in this snapshot.'}
            </p>
            <details class="mt-3 text-xs text-fg-muted">
              <summary class="cursor-pointer">Resource details</summary>
              <p class="mt-2 break-all">
                Reference: {ref.kind} / {ref.id}
              </p>
              {metadata && (
                <p class="mt-2">Updated: {new Date(metadata.updatedAt).toLocaleString()}</p>
              )}
              {metadata?.workspacePath && (
                <p class="mt-2 break-all">Workspace: {metadata.workspacePath}</p>
              )}
              <ul class="mt-2 space-y-1" aria-label={`Links from ${name(ref)}`}>
                {board.relations
                  .filter((edge) => refKey(edge.from) === refKey(ref))
                  .map((edge) => (
                    <li key={refKey(edge.to)} class="break-words">
                      → {name(edge.to)} · {edge.to.kind}
                    </li>
                  ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
      <p class="mt-4 text-xs text-fg-faint">
        {board.inventoryCapturedAt === null
          ? 'Resource details have not been captured.'
          : `Resource details captured ${new Date(board.inventoryCapturedAt).toLocaleString()}.`}{' '}
        Missing details do not mean a resource was deleted.
      </p>
      {!!board.truncatedKinds.length && (
        <p class="mt-2 text-xs text-warning">
          Partial inventory: {board.truncatedKinds.join(', ')}. Older resources may be omitted.
        </p>
      )}
    </>
  );
}

export function NeoConcernBoardPanel({
  snapshot,
  concernId,
  requestOrigin,
}: {
  snapshot: NeoSnapshot | null;
  concernId: string | null;
  requestOrigin?: NeoRequestOrigin;
}) {
  const [open, setOpen] = useState(false);
  const [inventory, setInventory] = useState<DaemonSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  const connected = connectionState.value === 'connected';
  const scopedSnapshot = useMemo(
    () =>
      requestOrigin === undefined ? snapshot : projectNeoRequestSnapshot(snapshot, requestOrigin),
    [snapshot, requestOrigin?.sessionId, requestOrigin?.messageId, requestOrigin === undefined]
  );
  const board = projectNeoConcernBoard(scopedSnapshot, concernId, inventory);

  useLayoutEffect(() => {
    const ticket = ++generation.current;
    let alive = true;
    const current = () => alive && generation.current === ticket;
    setInventory(null);
    setError('');
    setLoading(open && connected && !!board);
    if (open && connected && board)
      void readDaemonInventory(() => connectionManager.getHub(), current)
        .then((result) => {
          if (!current()) return;
          if (result.state === 'ready') setInventory(result.snapshot);
          if (result.state === 'unavailable') setError('Linked resource details are unavailable.');
        })
        .catch(() => {
          if (current()) setError('Couldn’t refresh the linked resources. Try again.');
        })
        .finally(() => {
          if (current()) setLoading(false);
        });
    return () => {
      alive = false;
      ++generation.current;
    };
  }, [open, connected, scopedSnapshot, concernId, refresh]);

  if (!board) return null;
  return (
    <details
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open === open) return;
        ++generation.current;
        setOpen(event.currentTarget.open);
      }}
      class={
        requestOrigin ? 'mt-2' : 'my-5 rounded-2xl border border-line bg-surface/40 p-4 sm:p-5'
      }
    >
      <summary
        class={`cursor-pointer text-fg-muted hover:text-accent ${requestOrigin ? 'text-xs' : 'text-sm'}`}
      >
        {requestOrigin || concernId !== null
          ? 'How this is being handled'
          : 'How Neo is handling things'}
      </summary>
      {open && (
        <section
          aria-label="Concern board"
          class={requestOrigin ? 'mt-3 rounded-xl border border-line bg-surface p-4' : 'mt-5'}
        >
          <NeoConcernBoardView board={board} requestScoped={!!requestOrigin} />
          {!connected && (
            <p role="status" class="mt-3 text-xs text-warning">
              Reconnect to refresh resource details.
            </p>
          )}
          {loading && (
            <p role="status" class="mt-3 text-xs text-fg-muted">
              Checking linked resources…
            </p>
          )}
          {error && (
            <p role="alert" class="mt-3 text-xs text-danger">
              {error}
            </p>
          )}
          <div class="mt-4 flex justify-between gap-3 text-xs">
            <button
              type="button"
              disabled={!connected || loading}
              class="text-accent disabled:opacity-50"
              onClick={() => {
                ++generation.current;
                setRefresh((value) => value + 1);
              }}
            >
              Refresh details
            </button>
            <button
              type="button"
              class="text-fg-muted hover:text-fg"
              onClick={(event) => {
                event.currentTarget.closest('details')?.querySelector('summary')?.focus();
                ++generation.current;
                setOpen(false);
              }}
            >
              Close board
            </button>
          </div>
        </section>
      )}
    </details>
  );
}
