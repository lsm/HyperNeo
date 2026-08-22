import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';

type PromptSuggestionMessage = Extract<SDKMessage, { type: 'prompt_suggestion' }>;

interface Props {
  message: PromptSuggestionMessage;
}

export function SDKPromptSuggestionMessage({ message }: Props) {
  const suggestion = message.suggestion?.trim();
  if (!suggestion) return null;

  return (
    <div
      class="flex items-center gap-2 py-1 px-2 text-xs text-gray-500 dark:text-gray-400"
      data-testid="prompt-suggestion"
    >
      <svg
        class="h-3 w-3 flex-shrink-0"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.121 2.121l4.243 4.243m0-4.243l-4.243 4.243"
        />
      </svg>
      <span class="flex-shrink-0 font-medium">Suggested follow-up</span>
      <span class="truncate italic" title={suggestion}>
        {suggestion}
      </span>
    </div>
  );
}
