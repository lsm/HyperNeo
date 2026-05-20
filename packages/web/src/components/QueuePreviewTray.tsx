export interface QueuePreviewMessage {
	dbId: string;
	uuid: string;
	timestamp: number;
	status: 'enqueued' | 'deferred' | 'consumed';
	text: string;
}

interface QueuePreviewRowProps {
	label: 'Steer' | 'Next';
	messages: QueuePreviewMessage[];
	tone: 'current' | 'next';
	testId: string;
	onDeferMessage?: (message: QueuePreviewMessage) => void;
	onPromoteMessage?: (message: QueuePreviewMessage) => void;
	onRemoveMessage?: (message: QueuePreviewMessage) => void;
}

interface QueuePreviewTrayProps {
	currentTurnMessages: QueuePreviewMessage[];
	nextTurnMessages: QueuePreviewMessage[];
	className?: string;
	onDeferMessage?: (message: QueuePreviewMessage) => void;
	onPromoteMessage?: (message: QueuePreviewMessage) => void;
	onRemoveMessage?: (message: QueuePreviewMessage) => void;
}

function TrashIcon() {
	return (
		<svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width={2}>
			<path stroke-linecap="round" stroke-linejoin="round" d="M3 6h18" />
			<path stroke-linecap="round" stroke-linejoin="round" d="M8 6V4h8v2" />
			<path stroke-linecap="round" stroke-linejoin="round" d="M6.5 6l1 16h9l1-16" />
			<path stroke-linecap="round" stroke-linejoin="round" d="M10 11v6M14 11v6" />
		</svg>
	);
}

function MoveToSteerIcon() {
	return (
		<svg
			class="h-3.5 w-3.5"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width={2.3}
		>
			<path stroke-linecap="round" stroke-linejoin="round" d="M12 19V5" />
			<path stroke-linecap="round" stroke-linejoin="round" d="M5 12l7-7 7 7" />
		</svg>
	);
}

function MoveToNextIcon() {
	return (
		<svg
			class="h-3.5 w-3.5"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width={2.3}
		>
			<path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14" />
			<path stroke-linecap="round" stroke-linejoin="round" d="M19 12l-7 7-7-7" />
		</svg>
	);
}

function QueuePreviewRow({
	label,
	messages,
	tone,
	testId,
	onDeferMessage,
	onPromoteMessage,
	onRemoveMessage,
}: QueuePreviewRowProps) {
	if (messages.length === 0) return null;

	const toneClasses =
		tone === 'current'
			? {
					pill: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
					dot: 'bg-amber-300',
					pillAction:
						'hover:border-amber-400/50 hover:bg-amber-500/15 hover:text-amber-100 focus-visible:ring-amber-400/60',
				}
			: {
					pill: 'border-blue-500/30 bg-blue-500/10 text-blue-200',
					dot: 'bg-blue-300',
					pillAction:
						'hover:border-blue-400/50 hover:bg-blue-500/15 hover:text-blue-100 focus-visible:ring-blue-400/60',
				};

	return (
		<div
			class="space-y-1 px-2 py-2"
			data-testid={testId}
			aria-label={`${label}: ${messages.length} queued ${messages.length === 1 ? 'message' : 'messages'}`}
		>
			{messages.map((queued) => (
				<div
					key={queued.dbId}
					class="flex min-h-8 min-w-0 items-center gap-2 rounded-lg px-1.5 py-1 transition-colors hover:bg-white/[0.035]"
				>
					{tone === 'current' && onDeferMessage ? (
						<button
							type="button"
							class={`inline-flex h-8 min-w-[5.1rem] shrink-0 items-center justify-center gap-1.5 rounded-full border px-2 text-[10px] font-medium uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 ${toneClasses.pill} ${toneClasses.pillAction}`}
							title="Move to Next"
							aria-label={`Move queued message to Next: ${queued.text}`}
							data-testid="defer-queued-message"
							onClick={() => onDeferMessage(queued)}
						>
							<span class={`h-1.5 w-1.5 rounded-full ${toneClasses.dot}`} />
							<span>{label}</span>
							<MoveToNextIcon />
						</button>
					) : tone === 'next' && onPromoteMessage ? (
						<button
							type="button"
							class={`inline-flex h-8 min-w-[5.1rem] shrink-0 items-center justify-center gap-1.5 rounded-full border px-2 text-[10px] font-medium uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 ${toneClasses.pill} ${toneClasses.pillAction}`}
							title="Move to Steer"
							aria-label={`Move queued message to Steer: ${queued.text}`}
							data-testid="promote-queued-message"
							onClick={() => onPromoteMessage(queued)}
						>
							<span class={`h-1.5 w-1.5 rounded-full ${toneClasses.dot}`} />
							<span>{label}</span>
							<MoveToSteerIcon />
						</button>
					) : (
						<div
							class={`inline-flex h-8 min-w-[5.1rem] shrink-0 items-center justify-center gap-1.5 rounded-full border px-2 text-[10px] font-medium uppercase tracking-wide ${toneClasses.pill}`}
						>
							<span class={`h-1.5 w-1.5 rounded-full ${toneClasses.dot}`} />
							<span>{label}</span>
						</div>
					)}
					<p class="min-w-0 flex-1 truncate text-xs leading-5 text-gray-200" title={queued.text}>
						{queued.text}
					</p>
					<div class="flex shrink-0 items-center gap-1">
						{onRemoveMessage && (
							<button
								type="button"
								class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-red-500/15 hover:text-red-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
								title="Delete"
								aria-label={`Delete queued message: ${queued.text}`}
								data-testid="remove-queued-message"
								onClick={() => onRemoveMessage(queued)}
							>
								<TrashIcon />
							</button>
						)}
					</div>
				</div>
			))}
		</div>
	);
}

export function QueuePreviewTray({
	currentTurnMessages,
	nextTurnMessages,
	className = '',
	onDeferMessage,
	onPromoteMessage,
	onRemoveMessage,
}: QueuePreviewTrayProps) {
	if (currentTurnMessages.length === 0 && nextTurnMessages.length === 0) return null;

	return (
		<div class={className} data-testid="queue-overlay" aria-live="polite">
			<div class="overflow-hidden rounded-xl border border-dark-700/80 bg-dark-900/90 shadow-lg shadow-black/20 backdrop-blur-md">
				<div class="divide-y divide-dark-800/90">
					<QueuePreviewRow
						label="Steer"
						messages={currentTurnMessages}
						tone="current"
						testId="queued-current-turn-bubble"
						onDeferMessage={onDeferMessage}
						onPromoteMessage={onPromoteMessage}
						onRemoveMessage={onRemoveMessage}
					/>
					<QueuePreviewRow
						label="Next"
						messages={nextTurnMessages}
						tone="next"
						testId="queued-next-turn-bubble"
						onDeferMessage={onDeferMessage}
						onPromoteMessage={onPromoteMessage}
						onRemoveMessage={onRemoveMessage}
					/>
				</div>
			</div>
		</div>
	);
}
