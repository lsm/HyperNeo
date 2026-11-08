import { FORM_CONTROL_CLASS } from '../ui/FormField.tsx';

type Pending = { twoWay?: boolean; phoneConfirmed?: boolean };

export const pairApprovalReady = (pending: Pending, code: string) =>
  !pending.twoWay || (!!pending.phoneConfirmed && code.replace(/[\s-]/g, '').length === 8);

export function PairConfirmInput({
  pending,
  name,
  value,
  onInput,
}: {
  pending: Pending;
  name: string;
  value: string;
  onInput(value: string): void;
}) {
  if (!pending.twoWay) return null;
  return pending.phoneConfirmed ? (
    <label class="min-w-0 text-xs text-fg-muted">
      Code shown on {name}
      <input
        class={`${FORM_CONTROL_CLASS} mt-1 max-w-44 font-mono uppercase tracking-wider`}
        aria-label={`Code shown on ${name}`}
        placeholder="XXXX-XXXX"
        autoComplete="off"
        autoCapitalize="characters"
        spellcheck={false}
        value={value}
        onInput={(event) => onInput(event.currentTarget.value)}
      />
      <span class="mt-1 block">One attempt. A wrong code denies this request.</span>
    </label>
  ) : (
    <p role="status" class="text-xs text-fg-muted">
      Waiting for the phone to confirm.
    </p>
  );
}
