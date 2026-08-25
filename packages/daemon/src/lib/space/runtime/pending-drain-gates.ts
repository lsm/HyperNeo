import type {
  PendingAgentMessageRecord,
  PendingMessageTargetKind,
} from '../../../storage/repositories/pending-agent-message-repository.ts';

export interface PendingQueueListing {
  targetName: string;
  rows: readonly PendingAgentMessageRecord[];
}

export interface PendingDrainAdmission {
  executionPresent: boolean;
  targetKind: PendingMessageTargetKind;
}

export function derivePendingQueueTargetNames(
  targetAgentName: string,
  workflowNodeName: string | null
): string[] {
  return [targetAgentName, ...(workflowNodeName ? [`${workflowNodeName}/${targetAgentName}`] : [])];
}

export function selectDrainablePendingRows(
  listings: readonly PendingQueueListing[],
  admission: PendingDrainAdmission
): PendingAgentMessageRecord[] {
  const seenIds = new Set<string>();
  return listings
    .flatMap((listing) => listing.rows)
    .filter((row) => row.targetKind === admission.targetKind)
    .filter((row) => (admission.executionPresent ? true : row.workflowNodeId == null))
    .filter((row) => {
      if (seenIds.has(row.id)) return false;
      seenIds.add(row.id);
      return true;
    })
    .sort((a, b) => a.createdAt - b.createdAt);
}
