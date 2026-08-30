export const TASK_STATUS_COLORS: Record<string, string> = {
  draft: 'text-fg-muted',
  open: 'text-fg-muted',
  in_progress: 'text-warning',
  approved: 'text-success',
  done: 'text-success',
  blocked: 'text-danger',
  cancelled: 'text-fg-faint',
  archived: 'text-fg-faint',
  pending: 'text-fg-muted',
  completed: 'text-success',
  needs_attention: 'text-danger',
  review: 'text-cat-purple',
  rate_limited: 'text-warning',
  usage_limited: 'text-orange-600',
};

export const ROLE_COLORS: Record<string, { border: string; label: string; labelColor: string }> = {
  planner: { border: 'border-l-teal-500', label: 'Planner', labelColor: 'text-teal-400' },
  coder: { border: 'border-l-blue-500', label: 'Coder', labelColor: 'text-accent' },
  general: { border: 'border-l-slate-400', label: 'General', labelColor: 'text-fg-muted' },
  leader: { border: 'border-l-purple-500', label: 'Leader', labelColor: 'text-cat-purple' },
  human: { border: 'border-l-green-500', label: 'Human', labelColor: 'text-success' },
  system: { border: 'border-l-transparent', label: '', labelColor: 'text-fg-faint' },
  craft: { border: 'border-l-blue-500', label: 'Craft', labelColor: 'text-accent' },
  lead: { border: 'border-l-purple-500', label: 'Lead', labelColor: 'text-cat-purple' },
};
