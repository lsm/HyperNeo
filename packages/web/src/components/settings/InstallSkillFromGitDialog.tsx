import { useState } from 'preact/hooks';
import { skillsStore } from '../../lib/skills-store';
import { toast } from '../../lib/toast';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { cn } from '../../lib/utils';

function deriveCommandName(url: string): string {
  try {
    const u = new URL(url.trim());
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? '';
    return last
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/^-+|-+$/g, '');
  } catch {
    return '';
  }
}

interface FormState {
  repoUrl: string;
  commandName: string;
  commandNameTouched: boolean;
}

interface FormErrors {
  repoUrl?: string;
  commandName?: string;
}

const EMPTY_FORM: FormState = {
  repoUrl: '',
  commandName: '',
  commandNameTouched: false,
};

interface InstallSkillFromGitDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function InstallSkillFromGitDialog({ isOpen, onClose }: InstallSkillFromGitDialogProps) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleUrlChange = (value: string) => {
    setForm((f) => ({
      ...f,
      repoUrl: value,
      commandName: f.commandNameTouched ? f.commandName : deriveCommandName(value),
    }));
  };

  const validate = (): boolean => {
    const errs: FormErrors = {};
    const url = form.repoUrl.trim();
    if (!url) {
      errs.repoUrl = 'Repository URL is required';
    } else if (!/^https:\/\//i.test(url)) {
      errs.repoUrl = 'URL must start with https://';
    }
    const name = form.commandName.trim();
    if (!name) {
      errs.commandName = 'Skill name is required';
    } else if (!/^[a-z0-9-]+$/.test(name)) {
      errs.commandName = 'Name must contain only lowercase letters, numbers, and hyphens';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    if (!validate()) return;
    setIsSubmitting(true);
    try {
      const skill = await skillsStore.installSkillFromGit({
        repoUrl: form.repoUrl.trim(),
        commandName: form.commandName.trim(),
      });
      toast.success(`Installed "${skill.displayName || skill.name}" from Git`);
      handleClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to install skill');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setForm(EMPTY_FORM);
    setErrors({});
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Install Skill from Git" size="md">
      <form onSubmit={handleSubmit} class="space-y-4">
        <p class="text-xs text-fg-faint">
          Paste a GitHub tree URL (e.g.{' '}
          <code class="font-mono text-fg-muted">
            https://github.com/openai/skills/tree/main/skills/.curated/playwright
          </code>
          ) or a raw file URL. HyperNeo will download the skill directory and register it.
        </p>

        <div>
          <label class="block text-sm font-medium text-fg-soft mb-1">
            URL <span class="text-danger">*</span>
          </label>
          <input
            type="text"
            value={form.repoUrl}
            onInput={(e) => handleUrlChange((e.target as HTMLInputElement).value)}
            class={cn(
              'w-full bg-surface-raised border rounded-lg px-3 py-2 text-sm text-fg-soft font-mono',
              'focus:outline-none focus:ring-1 focus:ring-accent',
              errors.repoUrl ? 'border-danger' : 'border-line'
            )}
            placeholder="https://github.com/owner/repo/tree/main/skills/my-skill"
            autoFocus
          />
          {errors.repoUrl && <p class="text-xs text-danger mt-1">{errors.repoUrl}</p>}
        </div>

        <div>
          <label class="block text-sm font-medium text-fg-soft mb-1">
            Skill name <span class="text-danger">*</span>
          </label>
          <input
            type="text"
            value={form.commandName}
            onInput={(e) =>
              setForm((f) => ({
                ...f,
                commandName: (e.target as HTMLInputElement).value,
                commandNameTouched: true,
              }))
            }
            class={cn(
              'w-full bg-surface-raised border rounded-lg px-3 py-2 text-sm text-fg-soft font-mono',
              'focus:outline-none focus:ring-1 focus:ring-accent',
              errors.commandName ? 'border-danger' : 'border-line'
            )}
            placeholder="e.g., playwright"
          />
          {errors.commandName && <p class="text-xs text-danger mt-1">{errors.commandName}</p>}
          <p class="text-xs text-fg-faint mt-1">
            Auto-derived from the URL. Used as the slash-command name (
            <code class="font-mono">/playwright</code>) and install directory (
            <code class="font-mono">~/.hyperneo/skills/playwright/</code>).
          </p>
        </div>

        <div class="flex items-center justify-end gap-3 pt-2">
          <Button type="button" variant="secondary" size="sm" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={isSubmitting}>
            Install
          </Button>
        </div>
      </form>
    </Modal>
  );
}
