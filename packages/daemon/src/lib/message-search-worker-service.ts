import { generateUUID } from '@neokai/shared';
import type { MessageSearchParams, MessageSearchResponse } from '../storage/message-search';

const DEFAULT_MESSAGE_SEARCH_TIMEOUT_MS = 2_000;

type ActiveSearch = {
	worker: Worker;
	timer: ReturnType<typeof setTimeout>;
	resolve: (response: MessageSearchResponse) => void;
};

type WorkerMessage = { id: string; result: MessageSearchResponse } | { id: string; error: string };

function emptySearchResponse(params: MessageSearchParams): MessageSearchResponse {
	return {
		results: [],
		limit: Math.min(Math.max(params.limit ?? 25, 1), 50),
		offset: Math.max(params.offset ?? 0, 0),
	};
}

export class MessageSearchWorkerService {
	private activeByKey = new Map<string, ActiveSearch>();

	constructor(
		private dbPath: string,
		private timeoutMs = DEFAULT_MESSAGE_SEARCH_TIMEOUT_MS
	) {}

	search(params: MessageSearchParams, coalesceKey: string): Promise<MessageSearchResponse> {
		this.cancel(coalesceKey, params);

		const requestId = generateUUID();
		const worker = new Worker(new URL('./message-search-worker.ts', import.meta.url).href, {
			type: 'module',
		});

		return new Promise<MessageSearchResponse>((resolve) => {
			const cleanup = () => {
				const active = this.activeByKey.get(coalesceKey);
				if (active?.worker === worker) {
					this.activeByKey.delete(coalesceKey);
				}
				clearTimeout(timer);
				worker.terminate();
			};

			const timer = setTimeout(() => {
				cleanup();
				resolve(emptySearchResponse(params));
			}, this.timeoutMs);

			this.activeByKey.set(coalesceKey, { worker, timer, resolve });

			worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
				const message = event.data;
				if (message.id !== requestId) return;
				cleanup();
				resolve('result' in message ? message.result : emptySearchResponse(params));
			};

			worker.onerror = () => {
				cleanup();
				resolve(emptySearchResponse(params));
			};

			worker.postMessage({ id: requestId, dbPath: this.dbPath, params });
		});
	}

	private cancel(coalesceKey: string, params: MessageSearchParams): void {
		const active = this.activeByKey.get(coalesceKey);
		if (!active) return;
		clearTimeout(active.timer);
		active.worker.terminate();
		this.activeByKey.delete(coalesceKey);
		active.resolve(emptySearchResponse(params));
	}
}
