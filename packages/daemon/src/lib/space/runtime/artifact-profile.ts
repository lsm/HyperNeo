export interface WorkflowArtifactProfile {
  resolvePrimaryLinkUrl(runId: string): string;

  resolveInitialPrimaryLinkUrl?(runId: string): string;

  summarizeRunOutcome(runId: string): string | null;
}
