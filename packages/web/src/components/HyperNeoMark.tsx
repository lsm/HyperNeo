import mark from '../../../../docs/branding/hyperneo-visual-identity/assets/logo-mark-06-jade.svg';
import '../../../../docs/branding/hyperneo-visual-identity/brand-tokens.css';

export function HyperNeoMark({ label = '' }: { label?: string }) {
  return (
    <span
      class="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
      style={{ background: 'var(--hn-color-night)' }}
    >
      <img
        src={mark}
        alt={label}
        aria-hidden={label ? undefined : true}
        height={32}
        class="h-8 w-auto"
      />
    </span>
  );
}
