import { useState } from 'preact/hooks';
import { Button } from './ui/Button';

interface WorktreeChoiceInlineProps {
  sessionId: string;
  workspacePath: string;
  onModeChange: (mode: 'worktree' | 'direct') => void;
}

export function WorktreeChoiceInline({
  sessionId: _sessionId,
  workspacePath: _workspacePath,
  onModeChange,
}: WorktreeChoiceInlineProps) {
  const [selectedMode, setSelectedMode] = useState<'worktree' | 'direct'>('worktree');

  const handleModeChange = (mode: 'worktree' | 'direct') => {
    setSelectedMode(mode);
    onModeChange(mode);
  };

  return (
    <div class="max-w-4xl mx-auto px-4 py-3">
      <div class="rounded-2xl border border-line bg-surface-raised/80 backdrop-blur-sm p-4">
        <div class="flex items-center justify-between gap-4">
          <div class="flex items-center gap-3">
            <span class="text-lg">🌿</span>
            <div>
              <div class="text-sm font-medium text-fg">Workspace Mode</div>
              <div class="text-xs text-fg-muted">
                {selectedMode === 'worktree'
                  ? 'Isolated worktree mode (safe)'
                  : 'Direct workspace mode (fast)'}
              </div>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <Button
              variant={selectedMode === 'worktree' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => handleModeChange('worktree')}
            >
              🌿 Worktree
            </Button>
            <Button
              variant={selectedMode === 'direct' ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => handleModeChange('direct')}
            >
              ⚡ Direct
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
