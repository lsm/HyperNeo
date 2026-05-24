export type AgentMessageLevel = 'space-agent' | 'task-agent' | 'node-agent' | 'session-agent';

export interface FormatAgentMessageOptions {
	fromLevel: AgentMessageLevel;
	fromAgentName: string;
	toLevel: AgentMessageLevel;
	body: string;
	/** Parent task UUID. Required for coordinator reply instructions when known. */
	taskId?: string | null;
	/** Space-scoped task number for human-readable context. */
	taskNumber?: number | null;
	/** Sender/target node agent name for reply routing. */
	nodeId?: string | null;
	/** Agent handle to use in visible reply instructions. */
	replyTargetHandle?: string | null;
	/**
	 * Session ID that should receive the reply when the target agent responds
	 * via the visible reply instructions. When set, the routing layer delivers
	 * the reply to this session instead of the default coordinator session.
	 * Null/undefined means "use default routing".
	 */
	replyToSessionId?: string | null;
}

function taskLabel(taskNumber?: number | null): string {
	return typeof taskNumber === 'number' ? ` (task #${taskNumber})` : '';
}

function replyTargetSuffix(options: FormatAgentMessageOptions): string {
	if (options.fromLevel !== 'node-agent') return '';
	const target = options.nodeId ?? options.fromAgentName;
	return ` and target node "${target}"`;
}

function replyTargetHandle(options: FormatAgentMessageOptions): string {
	if (options.replyTargetHandle) return options.replyTargetHandle;
	return `@${options.fromAgentName}`;
}

/**
 * Build the reply-routing metadata footer appended to messages that carry
 * `replyToSessionId`. The footer is a machine-readable XML block that the
 * routing layer parses when the receiving agent replies via the visible reply
 * instructions.
 */
function replyRoutingFooter(options: FormatAgentMessageOptions): string {
	if (!options.replyToSessionId) return '';
	return `\n\n<reply-routing replyToSessionId="${options.replyToSessionId}" />`;
}

/**
 * Format an inter-agent runtime message envelope.
 *
 * Agents pass only the raw body to their messaging tools; runtime delivery code
 * calls this helper immediately before injecting the message into the receiver's
 * session so the transcript records sender identity and concise reply guidance.
 *
 * When `replyToSessionId` is set, a `<reply-routing>` XML block is appended.
 * The routing layer extracts this when the agent replies via the visible reply
 * instructions to deliver the reply back to the originating session instead of
 * the default coordinator session.
 */
export function formatAgentMessage(options: FormatAgentMessageOptions): string {
	const body = options.body;
	const footer = replyRoutingFooter(options);

	if (options.toLevel === 'space-agent') {
		const task = taskLabel(options.taskNumber);
		const taskId = options.taskId ? ` with task_id="${options.taskId}"` : '';
		return (
			`─── Message from ${options.fromAgentName}${task} ───\n\n` +
			`${body}\n\n` +
			`─── Reply ───\n` +
			`To reply, use: send_message_to_task${taskId}${replyTargetSuffix(options)}${footer}`
		);
	}

	if (options.fromLevel === 'space-agent' || options.fromLevel === 'session-agent') {
		return (
			`─── Message from ${options.fromAgentName} ───\n\n` +
			`${body}${footer}\n\n` +
			`─── Reply ───\n` +
			`To reply, use: send_message with target "${replyTargetHandle(options)}"`
		);
	}

	if (options.fromLevel === 'node-agent' && options.toLevel === 'node-agent') {
		return `─── Message from ${options.fromAgentName} ───\n\n${body}${footer}`;
	}

	if (options.fromLevel === 'node-agent' && options.toLevel === 'task-agent') {
		return (
			`─── Message from ${options.fromAgentName}${taskLabel(options.taskNumber)} ───\n\n` +
			`${body}${footer}\n\n` +
			`─── Reply ───\n` +
			`To reply, use: send_message with target "${options.fromAgentName}"`
		);
	}

	if (options.fromLevel === 'task-agent' && options.toLevel === 'node-agent') {
		return (
			`─── Message from task-agent${taskLabel(options.taskNumber)} ───\n\n` +
			`${body}${footer}\n\n` +
			`─── Reply ───\n` +
			`To reply, use: send_message with target "task-agent"`
		);
	}

	return `─── Message from ${options.fromAgentName} ───\n\n${body}${footer}`;
}

/**
 * Extract `replyToSessionId` from a message envelope's `<reply-routing>` footer.
 * Returns `null` when the footer is absent (no routing metadata).
 * Used by the pending-message flush path to recover routing after daemon restart.
 *
 * Only matches the tag when it appears as a trailing footer (last non-whitespace
 * content), preventing a forged tag in the message body from controlling routing.
 */
export function extractReplyToSessionId(message: string): string | null {
	const match = message.match(/<reply-routing replyToSessionId="([^"]+)" \/>\s*$/);
	return match ? match[1] : null;
}
