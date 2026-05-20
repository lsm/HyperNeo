import { Database as BunDatabase } from 'bun:sqlite';
import type { MessageSearchParams, MessageSearchResponse } from '../storage/message-search';
import { SDKMessageRepository } from '../storage/repositories/sdk-message-repository';

type SearchWorkerRequest = {
	id: string;
	dbPath: string;
	params: MessageSearchParams;
};

type SearchWorkerResponse =
	| { id: string; result: MessageSearchResponse }
	| { id: string; error: string };

type WorkerGlobal = {
	onmessage: ((event: { data: SearchWorkerRequest }) => void | Promise<void>) | null;
	postMessage(message: SearchWorkerResponse): void;
};

const worker = globalThis as unknown as WorkerGlobal;

worker.onmessage = (event) => {
	const { id, dbPath, params } = event.data;
	let db: BunDatabase | null = null;
	try {
		db = new BunDatabase(dbPath, { readonly: true });
		db.exec(`PRAGMA query_only = ON`);
		db.exec(`PRAGMA busy_timeout = 1000`);
		const repository = new SDKMessageRepository(db);
		worker.postMessage({ id, result: repository.searchMessages(params) });
	} catch (error) {
		worker.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
	} finally {
		db?.close();
	}
};
