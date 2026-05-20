import { ActorMessageProjectionFeed } from './actor-messages/ActorMessageProjectionFeed';

interface TaskTimelineFeedProps {
	taskId: string;
	bottomInsetPx?: number;
}

export function TaskTimelineFeed({ taskId, bottomInsetPx }: TaskTimelineFeedProps) {
	return (
		<ActorMessageProjectionFeed
			scope="task_timeline"
			taskId={taskId}
			bottomInsetPx={bottomInsetPx}
			emptyLabel="No task timeline events yet."
			loadingLabel="Loading task timeline…"
			reconnectingLabel="Reconnecting task timeline…"
		/>
	);
}
