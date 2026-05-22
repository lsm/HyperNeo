import { ActorMessageProjectionFeed } from './actor-messages/ActorMessageProjectionFeed';

interface TaskTimelineFeedProps {
	taskId: string;
	topInsetClass?: string;
	bottomInsetPx?: number;
}

export function TaskTimelineFeed({
	taskId,
	topInsetClass,
	bottomInsetPx,
}: TaskTimelineFeedProps) {
	return (
		<ActorMessageProjectionFeed
			scope="task_timeline"
			taskId={taskId}
			topInsetClass={topInsetClass}
			bottomInsetPx={bottomInsetPx}
			emptyLabel="No task timeline events yet."
			loadingLabel="Loading task timeline…"
			reconnectingLabel="Reconnecting task timeline…"
		/>
	);
}
