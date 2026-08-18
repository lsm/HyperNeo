export const TASK_STATUS_COLORS: Record<string, string> = {
  draft: 'text-slate-400',
  open: 'text-gray-400',
  in_progress: 'text-yellow-400',
  approved: 'text-emerald-400',
  done: 'text-green-400',
  blocked: 'text-red-400',
  cancelled: 'text-gray-500',
  archived: 'text-gray-600',
  pending: 'text-gray-400',
  completed: 'text-green-400',
  needs_attention: 'text-red-400',
  review: 'text-purple-400',
  rate_limited: 'text-orange-500',
  usage_limited: 'text-orange-600',
};

export const ROLE_COLORS: Record<string, { border: string; label: string; labelColor: string }> = {
  planner: { border: 'border-l-teal-500', label: 'Planner', labelColor: 'text-teal-400' },
  coder: { border: 'border-l-blue-500', label: 'Coder', labelColor: 'text-blue-400' },
  general: { border: 'border-l-slate-400', label: 'General', labelColor: 'text-slate-400' },
  leader: { border: 'border-l-purple-500', label: 'Leader', labelColor: 'text-purple-400' },
  human: { border: 'border-l-green-500', label: 'Human', labelColor: 'text-green-400' },
  system: { border: 'border-l-transparent', label: '', labelColor: 'text-gray-500' },
  craft: { border: 'border-l-blue-500', label: 'Craft', labelColor: 'text-blue-400' },
  lead: { border: 'border-l-purple-500', label: 'Lead', labelColor: 'text-purple-400' },
};
