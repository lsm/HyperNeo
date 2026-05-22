import { ActorMessageProjectionFeed } from './actor-messages/ActorMessageProjectionFeed';

interface WorkflowExecutionLogFeedProps {
	workflowRunId: string;
	topInsetClass?: string;
	bottomInsetPx?: number;
}

export function WorkflowExecutionLogFeed({
	workflowRunId,
	topInsetClass,
	bottomInsetPx,
}: WorkflowExecutionLogFeedProps) {
	return (
		<ActorMessageProjectionFeed
			scope="workflow_log"
			workflowRunId={workflowRunId}
			topInsetClass={topInsetClass}
			bottomInsetPx={bottomInsetPx}
			emptyLabel="No workflow execution events yet."
			loadingLabel="Loading workflow execution log…"
			reconnectingLabel="Reconnecting workflow execution log…"
		/>
	);
}
