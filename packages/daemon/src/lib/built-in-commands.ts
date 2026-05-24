/**
 * Built-in NeoKai commands
 *
 * These commands are available in all NeoKai sessions and are expanded
 * to full prompts before being sent to the Claude Agent SDK.
 *
 * Similar to how Claude Code handles .claude/commands/*.md files, but
 * these are built into NeoKai itself.
 */

export interface BuiltInCommand {
  name: string;
  description: string;
  prompt: string;
}

/**
 * Built-in command definitions
 * Internal-only: use getBuiltInCommandNames() or expandBuiltInCommand() instead
 */
const BUILT_IN_COMMANDS: BuiltInCommand[] = [
  {
    name: 'merge-session',
    description:
      'Complete the current worktree session by committing, merging to target branch, and pushing',
    prompt: `Complete the current worktree session workflow:

1. Create logical commits for all changes in this worktree
2. Detect the current branch in the root repository (could be main, dev, feature branch, etc.)
3. Pull rebase on that target branch in the root repository
4. Fast-forward merge this session branch to the target branch in the root repository
5. Push to remote

Follow git best practices:
- Create atomic, logical commits with clear messages
- Verify no conflicts during rebase
- Ensure the merge is fast-forward only
- Detect and use whatever branch is currently checked out in the root repo`,
  },
];

/**
 * Get list of built-in command names
 */
export function getBuiltInCommandNames(): string[] {
  return BUILT_IN_COMMANDS.map((cmd) => cmd.name);
}

/**
 * Expand a built-in command to its full prompt
 * Returns null if the command is not a built-in command
 */
export function expandBuiltInCommand(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const commandName = trimmed.slice(1).split(/\s+/)[0];
  const command = BUILT_IN_COMMANDS.find((cmd) => cmd.name === commandName);

  if (!command) {
    return null;
  }

  return command.prompt;
}
