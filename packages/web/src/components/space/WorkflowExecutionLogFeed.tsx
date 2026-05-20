import { ActorMessageProjectionFeed } from './actor-messages/ActorMessageProjectionFeed';

interface WorkflowExecutionLogFeedProps {
	workflowRunId: string;
	bottomInsetPx?: number;
}

export function WorkflowExecutionLogFeed({
	workflowRunId,
	bottomInsetPx,
}: WorkflowExecutionLogFeedProps) {
	return (
		<ActorMessageProjectionFeed
			scope="workflow_log"
			workflowRunId={workflowRunId}
			bottomInsetPx={bottomInsetPx}
			emptyLabel="No workflow execution events yet."
			loadingLabel="Loading workflow execution log…"
			reconnectingLabel="Reconnecting workflow execution log…"
		/>
	);
}
