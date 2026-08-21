import { getDataDir } from './data-dir';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access, cp, mkdir, writeFile } from 'node:fs/promises';
import { generateUUID, isBuiltinSkillConfig } from '@hyperneo/shared';
import type {
  AppSkill,
  AppSkillConfig,
  CreateSkillParams,
  UpdateSkillParams,
  SkillSourceType,
  SkillValidationStatus,
} from '@hyperneo/shared';
import type { SkillRepository } from '../storage/repositories/skill-repository';
import type { AppMcpServerRepository } from '../storage/repositories/app-mcp-server-repository';
import type { JobQueueRepository } from '../storage/repositories/job-queue-repository';
import { SKILL_VALIDATE } from './job-queue-constants';
import { BUILTIN_MCP_SERVERS, BUILTIN_SKILLS, type BuiltinSkill } from './builtins';
import {
  defaultBuiltinSkillPluginRoot,
  ensureBuiltinSkillPluginWrappers,
} from './agent/builtin-skill-plugin-wrapper';

export function resolveSkillRawUrl(url: string): string {
  if (url.startsWith('https://raw.githubusercontent.com/')) {
    return url;
  }

  const githubBase = 'https://github.com/';
  if (!url.startsWith(githubBase)) {
    throw new Error(`Cannot resolve raw content URL from: ${url}`);
  }

  const rest = url.slice(githubBase.length);
  const treeSep = '/tree/';
  const blobSep = '/blob/';

  const treeIdx = rest.indexOf(treeSep);
  const blobIdx = rest.indexOf(blobSep);

  if (treeIdx !== -1) {
    const ownerRepo = rest.slice(0, treeIdx);
    const branchAndPath = rest.slice(treeIdx + treeSep.length);
    const slashIdx = branchAndPath.indexOf('/');
    if (slashIdx === -1) {
      throw new Error(
        `Cannot resolve raw content URL from: ${url} (missing skill path after branch)`
      );
    }
    const branch = branchAndPath.slice(0, slashIdx);
    const path = branchAndPath.slice(slashIdx + 1);
    return `https://raw.githubusercontent.com/${ownerRepo}/${branch}/${path}/SKILL.md`;
  }

  if (blobIdx !== -1) {
    const ownerRepo = rest.slice(0, blobIdx);
    const branchAndPath = rest.slice(blobIdx + blobSep.length);
    const slashIdx = branchAndPath.indexOf('/');
    if (slashIdx === -1) {
      throw new Error(
        `Cannot resolve raw content URL from: ${url} (missing file path after branch)`
      );
    }
    const branch = branchAndPath.slice(0, slashIdx);
    const path = branchAndPath.slice(slashIdx + 1);
    return `https://raw.githubusercontent.com/${ownerRepo}/${branch}/${path}`;
  }

  throw new Error(`Cannot resolve raw content URL from: ${url}`);
}

export function resolveGitHubApiContentsUrl(url: string): string {
  const githubBase = 'https://github.com/';
  if (!url.startsWith(githubBase)) {
    throw new Error(`resolveGitHubApiContentsUrl: expected a github.com URL, got: ${url}`);
  }
  const rest = url.slice(githubBase.length);
  const treeSep = '/tree/';
  const treeIdx = rest.indexOf(treeSep);
  if (treeIdx === -1) {
    throw new Error(`resolveGitHubApiContentsUrl: URL must contain /tree/: ${url}`);
  }
  const ownerRepo = rest.slice(0, treeIdx);
  const branchAndPath = rest.slice(treeIdx + treeSep.length);
  const slashIdx = branchAndPath.indexOf('/');
  if (slashIdx === -1) {
    throw new Error(`resolveGitHubApiContentsUrl: URL must have a path after the branch: ${url}`);
  }
  const branch = branchAndPath.slice(0, slashIdx);
  const path = branchAndPath.slice(slashIdx + 1);
  return `https://api.github.com/repos/${ownerRepo}/contents/${path}?ref=${branch}`;
}

const SKILL_FETCH_MAX_BYTES = 1 * 1024 * 1024;

const SKILL_FETCH_TIMEOUT_MS = 20_000;

const SKILL_FETCH_MAX_DEPTH = 5;

const SKILL_FETCH_MAX_FILES = 100;

const BUILTIN_SKILL_ASSET_DIRS: Record<string, string> = {
  'space-coordination': join(
    dirname(fileURLToPath(import.meta.url)),
    'space',
    'skills',
    'space-coordination'
  ),
};

export function validateCommandName(commandName: string): void {
  if (!commandName || commandName.trim() === '') {
    throw new Error('commandName must not be empty');
  }
  if (commandName.includes('\0')) {
    throw new Error('commandName must not contain null bytes');
  }
  if (commandName.includes('/') || commandName.includes('\\')) {
    throw new Error('commandName must not contain path separators (/ or \\)');
  }
  if (commandName === '.' || commandName === '..') {
    throw new Error('commandName must not be "." or ".."');
  }
  if (commandName.startsWith('.')) {
    throw new Error('commandName must not start with a dot');
  }
}

export class SkillsManager {
  private jobQueue: JobQueueRepository | null = null;

  constructor(
    private repo: SkillRepository,
    private appMcpServerRepo: AppMcpServerRepository,
    jobQueue?: JobQueueRepository
  ) {
    if (jobQueue) this.jobQueue = jobQueue;
  }

  listSkills(): AppSkill[] {
    return this.repo.findAll();
  }

  getSkill(id: string): AppSkill | null {
    return this.repo.get(id);
  }

  addSkill(params: CreateSkillParams): AppSkill {
    this.validateSkillConfig(params.sourceType, params.config);

    const existing = this.repo.getByName(params.name);
    if (existing) {
      throw new Error(`A skill named "${params.name}" already exists`);
    }

    const skill: AppSkill = {
      id: generateUUID(),
      name: params.name,
      displayName: params.displayName,
      description: params.description,
      sourceType: params.sourceType,
      config: params.config,
      enabled: params.enabled,
      builtIn: false,
      validationStatus: params.validationStatus ?? 'pending',
      createdAt: Date.now(),
    };

    this.repo.insert(skill);
    this.enqueueValidation(skill.id);
    const inserted = this.repo.get(skill.id);
    if (!inserted) {
      throw new Error(`Failed to insert skill "${params.name}"`);
    }
    return inserted;
  }

  updateSkill(id: string, params: UpdateSkillParams): AppSkill {
    const existing = this.repo.get(id);
    if (!existing) {
      throw new Error(`Skill not found: ${id}`);
    }

    if (params.config !== undefined) {
      this.validateSkillConfig(existing.sourceType, params.config);
    }

    this.repo.update(id, params);
    if (params.config !== undefined) {
      this.repo.setValidationStatus(id, 'pending');
      this.enqueueValidation(id);
    }
    return this.repo.get(id)!;
  }

  setSkillEnabled(id: string, enabled: boolean): AppSkill {
    const existing = this.repo.get(id);
    if (!existing) {
      throw new Error(`Skill not found: ${id}`);
    }
    this.repo.setEnabled(id, enabled);
    return this.repo.get(id)!;
  }

  setSkillValidationStatus(id: string, status: SkillValidationStatus): AppSkill {
    const existing = this.repo.get(id);
    if (!existing) {
      throw new Error(`Skill not found: ${id}`);
    }
    this.repo.setValidationStatus(id, status);
    return this.repo.get(id)!;
  }

  removeSkill(id: string): boolean {
    const existing = this.repo.get(id);
    if (!existing) return false;
    if (existing.builtIn) return false;
    return this.repo.delete(id);
  }

  getEnabledSkills(): AppSkill[] {
    return this.repo.findEnabled();
  }

  async installSkillFromGit(
    repoUrl: string,
    commandName: string,
    _workspaceRoot?: string
  ): Promise<AppSkill> {
    validateCommandName(commandName);

    const existing = this.repo.getByName(commandName);
    if (existing) {
      return existing;
    }

    const destDir = join(getDataDir(), 'skills', commandName);

    if (repoUrl.includes('github.com') && repoUrl.includes('/tree/')) {
      const apiUrl = resolveGitHubApiContentsUrl(repoUrl);
      await this.fetchGitHubDirectory(apiUrl, destDir);
    } else {
      const rawUrl = resolveSkillRawUrl(repoUrl);
      await mkdir(destDir, { recursive: true });
      const content = await this.fetchTextWithLimits(rawUrl);
      const skillFile = join(destDir, 'SKILL.md');
      const exists = await access(skillFile)
        .then(() => true)
        .catch(() => false);
      if (!exists) {
        await writeFile(skillFile, content, 'utf-8');
      }
    }

    const skill: AppSkill = {
      id: generateUUID(),
      name: commandName,
      displayName: commandName,
      description: `Skill installed from ${repoUrl}`,
      sourceType: 'builtin',
      config: { type: 'builtin', commandName },
      enabled: true,
      builtIn: false,
      validationStatus: 'valid',
      createdAt: Date.now(),
    };
    this.repo.insert(skill);

    await this.ensureBuiltinPluginWrappers().catch(() => {});

    return this.repo.get(skill.id)!;
  }

  private async fetchGitHubDirectory(
    apiUrl: string,
    destDir: string,
    depth = 0,
    fileCount = { value: 0 }
  ): Promise<void> {
    if (depth > SKILL_FETCH_MAX_DEPTH) {
      throw new Error(`Skill directory exceeds maximum nesting depth of ${SKILL_FETCH_MAX_DEPTH}`);
    }

    type GitHubEntry = {
      name: string;
      type: string;
      download_url: string | null;
      url: string;
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SKILL_FETCH_TIMEOUT_MS);
    let entries: GitHubEntry[];
    try {
      const response = await fetch(apiUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'hyperneo' },
      });
      if (!response.ok) {
        throw new Error(
          `GitHub API error for ${apiUrl}: ${response.status} ${response.statusText}`
        );
      }
      entries = (await response.json()) as GitHubEntry[];
    } finally {
      clearTimeout(timeoutId);
    }

    await mkdir(destDir, { recursive: true });

    for (const entry of entries) {
      try {
        validateCommandName(entry.name);
      } catch {
        throw new Error(
          `Unsafe entry name "${entry.name}" returned by GitHub API — aborting install`
        );
      }

      if (entry.type === 'file' && entry.download_url) {
        if (fileCount.value >= SKILL_FETCH_MAX_FILES) {
          throw new Error(`Skill directory exceeds maximum file count of ${SKILL_FETCH_MAX_FILES}`);
        }
        fileCount.value += 1;
        const destFile = join(destDir, entry.name);
        const alreadyExists = await access(destFile)
          .then(() => true)
          .catch(() => false);
        if (!alreadyExists) {
          const content = await this.fetchTextWithLimits(entry.download_url);
          await writeFile(destFile, content, 'utf-8');
        }
      } else if (entry.type === 'dir') {
        await this.fetchGitHubDirectory(entry.url, join(destDir, entry.name), depth + 1, fileCount);
      }
    }
  }

  private async fetchTextWithLimits(url: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SKILL_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
      }
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > SKILL_FETCH_MAX_BYTES) {
        throw new Error(`File at ${url} exceeds size limit`);
      }
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > SKILL_FETCH_MAX_BYTES) {
        throw new Error(`File at ${url} exceeds size limit`);
      }
      return new TextDecoder().decode(buffer);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  initializeBuiltins(): void {
    for (const def of BUILTIN_SKILLS) {
      this.upsertBuiltinSkill(def);
    }
  }

  private upsertBuiltinSkill(def: BuiltinSkill): void {
    if (def.kind === 'mcp_server') {
      this.upsertMcpServerSkill(def);
      return;
    }
    this.upsertBuiltinCommandSkill(def);
  }

  private upsertMcpServerSkill(def: Extract<BuiltinSkill, { kind: 'mcp_server' }>): void {
    const appMcpEntry =
      this.appMcpServerRepo.getByName(def.appMcpServerName) ??
      this.createMissingMcpServer(def.appMcpServerName);

    const existing = this.repo.getByName(def.name);
    if (existing) return;

    const skill: AppSkill = {
      id: generateUUID(),
      name: def.name,
      displayName: def.displayName,
      description: def.description,
      sourceType: 'mcp_server',
      config: { type: 'mcp_server', appMcpServerId: appMcpEntry.id },
      enabled: def.enabled,
      builtIn: true,
      validationStatus: 'valid',
      createdAt: Date.now(),
    };
    this.repo.insert(skill);
  }

  private upsertBuiltinCommandSkill(def: Extract<BuiltinSkill, { kind: 'builtin-command' }>): void {
    const existing = this.repo.getByName(def.name);
    if (existing) return;

    const skill: AppSkill = {
      id: generateUUID(),
      name: def.name,
      displayName: def.displayName,
      description: def.description,
      sourceType: 'builtin',
      config: {
        type: 'builtin',
        commandName: def.commandName,
        ...(def.spaceOnly ? { spaceOnly: true } : {}),
      },
      enabled: def.enabled,
      builtIn: true,
      validationStatus: 'valid',
      createdAt: Date.now(),
    };
    this.repo.insert(skill);
  }

  private createMissingMcpServer(name: string) {
    const serverDef = BUILTIN_MCP_SERVERS.find((s) => s.name === name);
    if (!serverDef) {
      throw new Error(
        `Built-in mcp_server skill references unknown app_mcp_server "${name}". ` +
          `Add the server to BUILTIN_MCP_SERVERS in src/lib/builtins.ts.`
      );
    }
    return this.appMcpServerRepo.create({
      name: serverDef.name,
      description: serverDef.description,
      sourceType: serverDef.sourceType,
      command: serverDef.command,
      args: serverDef.args,
      env: serverDef.env,
      enabled: serverDef.enabled,
      source: 'builtin',
    });
  }

  async ensureBuiltinPluginWrappers(
    wrappersRoot: string = defaultBuiltinSkillPluginRoot(),
    skillsRoot: string = join(getDataDir(), 'skills')
  ): Promise<Map<string, string>> {
    const entries: Array<{ commandName: string; description: string }> = [];
    for (const skill of this.repo.findAll()) {
      if (skill.sourceType !== 'builtin') continue;
      if (!isBuiltinSkillConfig(skill.config)) continue;
      await this.ensureBundledBuiltinSkillAssets(skill.config.commandName, skillsRoot);
      entries.push({
        commandName: skill.config.commandName,
        description: skill.description,
      });
    }
    return ensureBuiltinSkillPluginWrappers(wrappersRoot, skillsRoot, entries);
  }

  private async ensureBundledBuiltinSkillAssets(
    commandName: string,
    skillsRoot: string
  ): Promise<void> {
    const sourceDir = BUILTIN_SKILL_ASSET_DIRS[commandName];
    if (!sourceDir) return;

    const destDir = join(skillsRoot, commandName);
    try {
      await mkdir(destDir, { recursive: true });
      await cp(sourceDir, destDir, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    } catch {}
  }

  private enqueueValidation(skillId: string): void {
    if (!this.jobQueue) return;
    this.jobQueue.enqueue({ queue: SKILL_VALIDATE, payload: { skillId } });
  }

  private validateSkillConfig(sourceType: SkillSourceType, config: AppSkillConfig): void {
    if (sourceType !== config.type) {
      throw new Error(`sourceType "${sourceType}" must match config.type "${config.type}"`);
    }

    if (config.type === 'plugin') {
      const { pluginPath } = config;
      if (!pluginPath || pluginPath.trim() === '') {
        throw new Error('plugin skill: pluginPath must not be empty');
      }
      if (!pluginPath.startsWith('/')) {
        throw new Error('plugin skill: pluginPath must be an absolute path (starts with /)');
      }
      if (pluginPath.split('/').some((seg) => seg === '..')) {
        throw new Error('plugin skill: pluginPath must not contain path traversal sequences (../)');
      }
    } else if (config.type === 'mcp_server') {
      const { appMcpServerId } = config;
      if (!appMcpServerId || appMcpServerId.trim() === '') {
        throw new Error('mcp_server skill: appMcpServerId must not be empty');
      }
      const server = this.appMcpServerRepo.get(appMcpServerId);
      if (!server) {
        throw new Error(
          `mcp_server skill: app_mcp_servers entry not found for id "${appMcpServerId}"`
        );
      }
    } else if (config.type === 'builtin') {
      const { commandName } = config;
      if (!commandName || commandName.trim() === '') {
        throw new Error('builtin skill: commandName must not be empty');
      }
    } else {
      const _exhaustive: never = config;
      throw new Error(`Unknown skill config type: ${(_exhaustive as AppSkillConfig).type}`);
    }
  }
}
