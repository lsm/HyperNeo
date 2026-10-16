import type {
  SpaceExternalEventDeliveryLogRecord,
  ExternalEventDeliveryStatus,
} from '../../lib/space-store.ts';
import { Button } from '../ui/Button.tsx';
import { FORM_CONTROL_CLASS } from '../ui/FormField';
import { DELIVERY_STATUSES, formatTimestamp, formatJson } from './space-external-event-values.ts';
import { Spinner } from '../ui/Spinner.tsx';
import { cn } from '../../lib/utils.ts';

interface DeliveryLogSectionProps {
  deliveries: SpaceExternalEventDeliveryLogRecord[];
  loading: boolean;
  status: ExternalEventDeliveryStatus | '';
  agentFilter: string;
  selectedDelivery: SpaceExternalEventDeliveryLogRecord | null;
  onStatusChange: (status: ExternalEventDeliveryStatus | '') => void;
  onAgentFilterChange: (value: string) => void;
  onApplyAgentFilter: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onSelect: (delivery: SpaceExternalEventDeliveryLogRecord | null) => void;
}

export function DeliveryLogSection({
  deliveries,
  loading,
  status,
  agentFilter,
  selectedDelivery,
  onStatusChange,
  onAgentFilterChange,
  onApplyAgentFilter,
  onRefresh,
  onSelect,
}: DeliveryLogSectionProps) {
  return (
    <div>
      <div class="st-sec-head">
        <div class="min-w-0">
          <h3 class="st-sec-title">Event delivery log</h3>
          <p class="st-sec-desc">
            Inspect external events, matched agents, delivery state, and payloads.
          </p>
        </div>
        <div class="st-sec-actions">
          <Button type="button" size="sm" variant="ghost" loading={loading} onClick={onRefresh}>
            Refresh
          </Button>
        </div>
      </div>
      <div class="st-group">
        <div class="st-addrow flex flex-wrap gap-2">
          <select
            value={status}
            onChange={(event) =>
              onStatusChange((event.target as HTMLSelectElement).value as typeof status)
            }
            class={FORM_CONTROL_CLASS}
            aria-label="Delivery status"
          >
            {DELIVERY_STATUSES.map((deliveryStatus) => (
              <option key={deliveryStatus || 'all'} value={deliveryStatus}>
                {deliveryStatus || 'all statuses'}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={agentFilter}
            onInput={(event) => onAgentFilterChange((event.target as HTMLInputElement).value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void onApplyAgentFilter();
            }}
            placeholder="filter agent"
            class={FORM_CONTROL_CLASS}
          />
          <Button type="button" size="sm" onClick={onApplyAgentFilter}>
            Apply
          </Button>
        </div>

        <div class="overflow-x-auto">
          <table class="min-w-full divide-y divide-line text-left text-xs">
            <thead class="text-fg-faint">
              <tr class="border-b border-line">
                <th class="px-3 py-2 font-medium">Event</th>
                <th class="px-3 py-2 font-medium">Target</th>
                <th class="px-3 py-2 font-medium">Status</th>
                <th class="px-3 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-line">
              {loading ? (
                <tr>
                  <td colSpan={4} class="px-3 py-4 text-fg-muted">
                    <span class="inline-flex items-center gap-2">
                      <Spinner size="sm" /> Loading deliveries…
                    </span>
                  </td>
                </tr>
              ) : deliveries.length === 0 ? (
                <tr>
                  <td colSpan={4} class="px-3 py-4 text-fg-muted">
                    No event deliveries recorded yet.
                  </td>
                </tr>
              ) : (
                deliveries.map((delivery) => (
                  <DeliveryRow
                    key={delivery.deliveryKey}
                    delivery={delivery}
                    selected={selectedDelivery?.deliveryKey === delivery.deliveryKey}
                    onSelect={() => onSelect(delivery)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        {selectedDelivery && (
          <DeliveryDetail delivery={selectedDelivery} onClose={() => onSelect(null)} />
        )}
      </div>
    </div>
  );
}

function DeliveryRow({
  delivery,
  selected,
  onSelect,
}: {
  delivery: SpaceExternalEventDeliveryLogRecord;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <tr
      class={cn('cursor-pointer hover:bg-fill-soft', selected && 'bg-accent/10')}
      onClick={onSelect}
    >
      <td class="max-w-[24rem] px-3 py-2">
        <div class="truncate font-mono text-fg-soft">{delivery.event.topic}</div>
        <div class="mt-0.5 truncate text-fg-muted">{delivery.event.summary || 'No summary'}</div>
      </td>
      <td class="px-3 py-2 text-fg-soft">
        <div>{delivery.agentName}</div>
        <div class="mt-0.5 font-mono text-[11px] text-fg-faint">{delivery.workflowRunId}</div>
      </td>
      <td class="px-3 py-2">
        <span
          class={cn(
            'rounded-full px-2 py-0.5 text-[11px]',
            delivery.state === 'delivered' && 'bg-success/10 text-success-soft',
            delivery.state === 'pending' && 'bg-warning/10 text-warning-soft',
            delivery.state === 'failed' && 'bg-danger/10 text-danger-soft'
          )}
        >
          {delivery.state}
        </span>
        {delivery.failureReason && (
          <div class="mt-1 max-w-[16rem] truncate text-[11px] text-danger-soft">
            {delivery.failureReason}
          </div>
        )}
      </td>
      <td class="px-3 py-2 text-fg-muted">{formatTimestamp(delivery.updatedAt)}</td>
    </tr>
  );
}

function DeliveryDetail({
  delivery,
  onClose,
}: {
  delivery: SpaceExternalEventDeliveryLogRecord;
  onClose: () => void;
}) {
  return (
    <div class="st-row-stacked st-row">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-sm font-medium text-fg-soft">Event detail</div>
          <div class="mt-1 font-mono text-xs text-fg-muted">{delivery.event.id}</div>
        </div>
        <button type="button" onClick={onClose} class="st-act">
          Close
        </button>
      </div>
      <dl class="mt-3 grid gap-2 text-xs md:grid-cols-2">
        <DetailItem label="Topic" value={delivery.event.topic} />
        <DetailItem label="Source" value={delivery.event.source} />
        <DetailItem label="Event state" value={delivery.eventState} />
        <DetailItem label="Delivery key" value={delivery.deliveryKey} />
        <DetailItem label="Target agent" value={delivery.agentName} />
        <DetailItem label="Workflow run" value={delivery.workflowRunId} />
        <DetailItem label="Task" value={delivery.taskId} />
        <DetailItem label="Node" value={delivery.nodeId} />
        <DetailItem label="Occurred" value={formatTimestamp(delivery.event.occurredAt)} />
        <DetailItem label="Ingested" value={formatTimestamp(delivery.event.ingestedAt)} />
        <DetailItem label="Delivered" value={formatTimestamp(delivery.deliveredAt)} />
        <DetailItem label="Updated" value={formatTimestamp(delivery.updatedAt)} />
      </dl>
      {delivery.failureReason && (
        <div class="mt-3 rounded border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger-soft">
          {delivery.failureReason}
        </div>
      )}
      <div class="mt-3">
        <div class="mb-1 text-[11px] uppercase tracking-wider text-fg-muted">Payload</div>
        <pre class="max-h-72 overflow-auto rounded-lg border border-line bg-scrim p-3 text-xs text-fg-soft">
          {formatJson(delivery.event.payload)}
        </pre>
      </div>
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt class="text-[11px] uppercase tracking-wider text-fg-faint">{label}</dt>
      <dd class="mt-0.5 break-all text-fg-soft">{value}</dd>
    </div>
  );
}
