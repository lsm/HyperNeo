const OS_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'USERNAME',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NUMERIC',
  'LC_TIME',
  'TERM',
  'TMPDIR',
  'TZ',
  'CI',
  'NODE_ENV',
  'JAVA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'AppData',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'USERPROFILE',
  'TEMP',
  'TMP',
  'SystemRoot',
  'SystemDrive',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'HOMEDRIVE',
  'HOMEPATH',
] as const;

const PROXY_TLS_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'GIT_SSL_CAPATH',
  'GIT_SSL_VERSION',
  'GIT_SSL_CIPHER_LIST',
] as const;

const SDK_USER_CONFIG_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CONFIG_DIR',
  'ENABLE_TOOL_SEARCH',
  'API_TIMEOUT_MS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_GIT_BASH_PATH',
  'DEBUG_CLAUDE_AGENT_SDK',
] as const;

const DIALOG_ENV_KEYS = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_TYPE',
  'DBUS_SESSION_BUS_ADDRESS',
  'XAUTHORITY',
] as const;

const GIT_COMMAND_ENV_KEYS = [
  'GNUPGHOME',
  'GPG_TTY',
  'EDITOR',
  'VISUAL',
  'GIT_SSL_CAINFO',
  'GIT_SSL_NO_VERIFY',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_EXEC_PATH',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_ATTR_NOSYSTEM',
  'GIT_TERMINAL_PROMPT',
  'GIT_EDITOR',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
] as const;

const GIT_IDENTITY_ENV_KEYS = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'EMAIL',
] as const;

const GIT_SSH_ENV_KEYS = [
  'SSH_AUTH_SOCK',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'SSH_AGENT_PID',
  'SSH_AGENT_LAUNCHER',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'SSH_ASKPASS_REQUIRE',
  'WAYLAND_DISPLAY',
  'VSCODE_GIT_ASKPASS_NODE',
  'VSCODE_GIT_ASKPASS_MAIN',
  'VSCODE_GIT_IPC_HANDLE',
  'DISPLAY',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_ALLOW_PROTOCOL',
  'GIT_PROXY_COMMAND',
  'GIT_PROXY_SSL_CAINFO',
  'GIT_PROXY_SSL_CERT',
  'GIT_PROXY_SSL_KEY',
  'GIT_PROXY_SSL_CERT_PASSWORD_PROTECTED',
  'GIT_HTTP_PROXY_AUTHMETHOD',
  'GIT_SSL_CERT',
  'GIT_SSL_CERT_TYPE',
  'GIT_SSL_CERT_PASSWORD_PROTECTED',
  'GIT_SSL_KEY',
  'GIT_SSL_KEY_TYPE',
] as const;

const RESTRICTED_ENV_PREFIXES = [
  'ANTHROPIC_',
  'CLAUDE_',
  'GLM_',
  'ZHIPU_',
  'COPILOT_',
  'OPENAI_',
  'GITHUB_',
  'GH_',
  'HYPERNEO_',
  'NEOKAI_',
  'GIT_CONFIG_KEY_',
  'GIT_CONFIG_VALUE_',
] as const;

const RESTRICTED_ENV_KEY_PATTERN = /SECRET|TOKEN|PASSWORD|CREDENTIAL|API_KEY/i;

const CONDITION_FORBIDDEN_ENV_KEYS = new Set([
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'SSH_AGENT_LAUNCHER',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'KUBECONFIG',
  'DOCKER_CONFIG',
  'NPM_CONFIG_USERCONFIG',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CONFIG_DIR',
]);

export const AMBIENT_AUTH_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

export type EnvSource = Readonly<Record<string, string | undefined>>;

export { PROXY_TLS_ENV_KEYS };

function captureBaseline(source: EnvSource): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined)
    )
  );
}

export let STARTUP_ENV_BASELINE: Readonly<Record<string, string>> = captureBaseline(process.env);

export function refreshStartupEnvBaseline(): void {
  STARTUP_ENV_BASELINE = captureBaseline(process.env);
}

export function _setStartupEnvBaselineForTesting(source: EnvSource): void {
  STARTUP_ENV_BASELINE = captureBaseline(source);
}

function sourceValue(source: EnvSource, key: string): string | undefined {
  const exact = source[key];
  if (exact !== undefined) return exact;
  if (process.platform !== 'win32') return undefined;
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(source)) {
    if (name.toLowerCase() === lower) return value;
  }
  return undefined;
}

function pickKeys(keys: readonly string[], source: EnvSource): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = sourceValue(source, key);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function isRestrictedEnvName(key: string): boolean {
  const normalized = key.toUpperCase();
  return (
    RESTRICTED_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    RESTRICTED_ENV_KEY_PATTERN.test(normalized)
  );
}

export function envValue(source: EnvSource, key: string): string | undefined {
  return sourceValue(source, key);
}

export function startupEnvValue(key: string): string | undefined {
  return sourceValue(STARTUP_ENV_BASELINE, key);
}

export function buildOsBaselineEnv(
  source: EnvSource = STARTUP_ENV_BASELINE
): Record<string, string> {
  return pickKeys(OS_ENV_KEYS, source);
}

export function buildCommandEnv(source: EnvSource = STARTUP_ENV_BASELINE): Record<string, string> {
  return {
    ...buildOsBaselineEnv(source),
    ...pickKeys(PROXY_TLS_ENV_KEYS, source),
  };
}

export function buildDialogEnv(source: EnvSource = STARTUP_ENV_BASELINE): Record<string, string> {
  return {
    ...buildOsBaselineEnv(source),
    ...pickKeys(DIALOG_ENV_KEYS, source),
  };
}

export function buildGitCommandEnv(
  source: EnvSource = STARTUP_ENV_BASELINE
): Record<string, string> {
  return {
    ...buildOsBaselineEnv(source),
    ...pickKeys(GIT_COMMAND_ENV_KEYS, source),
    ...collectGitConfig(source, SAFE_DIRECTORY_CONFIG_PATTERN),
  };
}

export function buildGitSshEnv(source: EnvSource = STARTUP_ENV_BASELINE): Record<string, string> {
  return {
    ...buildOsBaselineEnv(source),
    ...pickKeys(GIT_COMMAND_ENV_KEYS, source),
    ...pickKeys([...GIT_SSH_ENV_KEYS, ...PROXY_TLS_ENV_KEYS], source),
    ...collectGitConfig(source, NETWORK_GIT_CONFIG_PATTERN),
  };
}

export function buildSdkRuntimeEnv(
  source: EnvSource = STARTUP_ENV_BASELINE
): Record<string, string> {
  return {
    ...buildOsBaselineEnv(source),
    ...pickKeys(
      [
        ...PROXY_TLS_ENV_KEYS,
        ...SDK_USER_CONFIG_ENV_KEYS,
        ...GIT_COMMAND_ENV_KEYS,
        ...GIT_SSH_ENV_KEYS,
        ...GIT_IDENTITY_ENV_KEYS,
      ],
      source
    ),
    ...collectPermittedGitConfig(source),
  };
}

export function buildWorkflowConditionEnv(
  allowedEnv: readonly string[] | undefined,
  source: EnvSource = STARTUP_ENV_BASELINE
): Record<string, string> {
  const env = buildOsBaselineEnv(source);
  if (!allowedEnv) return env;
  for (const key of allowedEnv) {
    if (isRestrictedEnvName(key) || CONDITION_FORBIDDEN_ENV_KEYS.has(key.toUpperCase())) continue;
    const value = sourceValue(source, key);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

const SAFE_DIRECTORY_CONFIG_PATTERN = /^safe\.directory$/i;
const NETWORK_GIT_CONFIG_PATTERN = /^(?:http(?:\..+)?\.extraHeader|safe\.directory)$/i;

function collectGitConfig(source: EnvSource, permitted: RegExp): Record<string, string> {
  const count = Number(sourceValue(source, 'GIT_CONFIG_COUNT'));
  if (!Number.isInteger(count) || count <= 0) return {};
  const keys: string[] = [];
  const values: string[] = [];
  for (let index = 0; index < count; index++) {
    const key = sourceValue(source, `GIT_CONFIG_KEY_${index}`);
    const value = sourceValue(source, `GIT_CONFIG_VALUE_${index}`);
    if (key === undefined || value === undefined) continue;
    if (!permitted.test(key)) continue;
    keys.push(key);
    values.push(value);
  }
  const env: Record<string, string> = {};
  keys.forEach((key, index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = values[index];
  });
  if (keys.length > 0) env.GIT_CONFIG_COUNT = String(keys.length);
  return env;
}

function collectPermittedGitConfig(source: EnvSource): Record<string, string> {
  return collectGitConfig(source, NETWORK_GIT_CONFIG_PATTERN);
}
