import { describe, expect, test } from 'bun:test';
import {
  _setStartupEnvBaselineForTesting,
  buildCommandEnv,
  buildDialogEnv,
  buildGitCommandEnv,
  buildGitSshEnv,
  buildOsBaselineEnv,
  buildSdkRuntimeEnv,
  buildWorkflowConditionEnv,
  isRestrictedEnvName,
  refreshStartupEnvBaseline,
  STARTUP_ENV_BASELINE,
} from '../../../src/lib/spawn-env';

const SOURCE: Record<string, string> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/Users/agent',
  USER: 'agent',
  USERNAME: 'agent',
  SHELL: '/bin/zsh',
  TMPDIR: '/var/folders/ab/',
  LANG: 'en_US.UTF-8',
  LC_CTYPE: 'en_US.UTF-8',
  LC_COLLATE: 'C',
  LC_NUMERIC: 'de_DE.UTF-8',
  CI: 'true',
  JAVA_HOME: '/Library/Java/JavaVirtualMachines/jdk-21/Contents/Home',
  GNUPGHOME: '/tmp/gnupg-keyring',
  GPG_TTY: '/dev/ttys000',
  NODE_ENV: 'production',
  WINDIR: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  ProgramW6432: 'C:\\Program Files',
  DISPLAY: ':0',
  XAUTHORITY: '/tmp/.Xauthority',
  WAYLAND_DISPLAY: 'wayland-0',
  XDG_RUNTIME_DIR: '/run/user/1000',
  HTTPS_PROXY: 'https://proxy.corp.example:8443',
  https_proxy: 'http://legacy-proxy.corp.example:8080',
  SSL_CERT_FILE: '/tmp/corp-ca.pem',
  CURL_CA_BUNDLE: '/tmp/curl-ca.pem',
  REQUESTS_CA_BUNDLE: '/tmp/requests-ca.pem',
  GIT_SSL_CAINFO: '/tmp/git-ca.pem',
  GIT_SSL_CAPATH: '/tmp/git-ca-dir',
  GIT_SSL_VERSION: 'tlsv1.3',
  GIT_SSL_CIPHER_LIST: 'ECDHE-RSA-AES256-GCM-SHA384',
  GIT_SSL_NO_VERIFY: '0',
  GIT_CEILING_DIRECTORIES: '/allowed/workspace',
  GIT_DISCOVERY_ACROSS_FILESYSTEM: '1',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
  EDITOR: '/usr/bin/vim',
  VISUAL: '/usr/bin/code -w',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  EMAIL: 'agent@example.com',
  GIT_ALLOW_PROTOCOL: 'file:https',
  GIT_PROXY_COMMAND: '/tmp/git-proxy.sh',
  GIT_PROXY_SSL_CAINFO: '/tmp/proxy-ca.pem',
  GIT_PROXY_SSL_CERT: '/tmp/proxy-cert.pem',
  GIT_PROXY_SSL_KEY: '/tmp/proxy-key.pem',
  GIT_PROXY_SSL_CERT_PASSWORD_PROTECTED: '1',
  GIT_HTTP_PROXY_AUTHMETHOD: 'basic',
  GIT_EXEC_PATH: '/usr/libexec/git-core',
  ANTHROPIC_API_KEY: 'anthropic-secret',
  CLAUDE_CODE_OAUTH_TOKEN: 'claude-secret',
  GH_TOKEN: 'gh-secret',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  GIT_SSH_COMMAND: 'ssh -i /secret/id_ed25519',
  VSCODE_GIT_ASKPASS_NODE: '/usr/local/bin/node',
  VSCODE_GIT_ASKPASS_MAIN: '/vscode/extensions/git/dist/askpass-main.js',
  VSCODE_GIT_IPC_HANDLE: '/tmp/vscode-git-ipc',
  GIT_LFS_SKIP_SMUDGE: '0',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'http.extraHeader',
  GIT_CONFIG_VALUE_0: 'Authorization: Bearer extra-secret',
  GIT_CONFIG_KEY_1: 'core.hooksPath',
  GIT_CONFIG_VALUE_1: '/tmp/hooks',
  MY_TOOL_FLAG: '1',
};

describe('buildOsBaselineEnv', () => {
  test('keeps OS/runtime keys and drops credentials and routing variables', () => {
    const env = buildOsBaselineEnv(SOURCE);
    expect(env.PATH).toBe(SOURCE.PATH);
    expect(env.HOME).toBe(SOURCE.HOME);
    expect(env.TMPDIR).toBe(SOURCE.TMPDIR);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
  });
});

describe('buildCommandEnv', () => {
  test('adds proxy and TLS inputs on top of the OS baseline', () => {
    const env = buildCommandEnv(SOURCE);
    expect(env.HTTPS_PROXY).toBe(SOURCE.HTTPS_PROXY);
    expect(env.https_proxy).toBe(SOURCE.https_proxy);
    expect(env.SSL_CERT_FILE).toBe(SOURCE.SSL_CERT_FILE);
    expect(env.CURL_CA_BUNDLE).toBe(SOURCE.CURL_CA_BUNDLE);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('buildDialogEnv', () => {
  test('includes GUI-session variables while excluding credentials', () => {
    const env = buildDialogEnv(SOURCE);
    expect(env.DISPLAY).toBe(SOURCE.DISPLAY);
    expect(env.WAYLAND_DISPLAY).toBe(SOURCE.WAYLAND_DISPLAY);
    expect(env.XDG_RUNTIME_DIR).toBe(SOURCE.XDG_RUNTIME_DIR);
    expect(env.GH_TOKEN).toBeUndefined();
  });
});

describe('buildGitCommandEnv', () => {
  test('keeps safe git variables and excludes secret carriers, SSH/askpass, config selectors, and proxy inputs', () => {
    const env = buildGitCommandEnv({
      ...SOURCE,
      GIT_CONFIG_GLOBAL: '/tmp/gitconfig-global',
    });
    expect(env.GIT_SSL_CAINFO).toBe(SOURCE.GIT_SSL_CAINFO);
    expect(env.GIT_EXEC_PATH).toBe(SOURCE.GIT_EXEC_PATH);
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_LFS_SKIP_SMUDGE).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  test('carries safe.directory entries but never extraHeader secrets into hook-capable commands', () => {
    const env = buildGitCommandEnv({
      ...SOURCE,
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '/mnt/trusted-repo',
      GIT_CONFIG_KEY_1: 'http.extraheader',
      GIT_CONFIG_VALUE_1: 'Authorization: Bearer repo-secret',
      GIT_CONFIG_KEY_2: 'core.hooksPath',
      GIT_CONFIG_VALUE_2: '/tmp/hooks',
    });
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('safe.directory');
    expect(env.GIT_CONFIG_VALUE_0).toBe('/mnt/trusted-repo');
    expect(env.GIT_CONFIG_KEY_1).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('repo-secret');
  });
});

describe('buildGitSshEnv', () => {
  test('adds SSH, askpass, and TLS client inputs plus reindexed http.extraHeader config only', () => {
    const env = buildGitSshEnv(SOURCE);
    expect(env.SSH_AUTH_SOCK).toBe(SOURCE.SSH_AUTH_SOCK);
    expect(env.GIT_SSH_COMMAND).toBe(SOURCE.GIT_SSH_COMMAND);
    expect(env.GIT_SSL_CERT).toBe(SOURCE.GIT_SSL_CERT);
    expect(env.GIT_SSL_KEY).toBe(SOURCE.GIT_SSL_KEY);
    expect(env.GIT_ASKPASS).toBe(SOURCE.GIT_ASKPASS);
    expect(env.SSH_ASKPASS).toBe(SOURCE.SSH_ASKPASS);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
    expect(env.GIT_CONFIG_VALUE_0).toBe(SOURCE.GIT_CONFIG_VALUE_0);
    expect(env.GIT_CONFIG_KEY_1).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_1).toBeUndefined();
  });

  test('reindexes safe.directory alongside http.extraHeader entries in the network env', () => {
    const env = buildGitSshEnv({
      ...SOURCE,
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: '/mnt/trusted-repo',
      GIT_CONFIG_KEY_1: 'http.extraheader',
      GIT_CONFIG_VALUE_1: 'Authorization: Bearer repo-secret',
      GIT_CONFIG_KEY_2: 'core.hooksPath',
      GIT_CONFIG_VALUE_2: '/tmp/hooks',
    });
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    expect(env.GIT_CONFIG_KEY_0).toBe('safe.directory');
    expect(env.GIT_CONFIG_KEY_1).toBe('http.extraheader');
    expect(env.GIT_CONFIG_KEY_2).toBeUndefined();
  });

  test('accepts URL-scoped http.<url>.extraHeader configuration keys', () => {
    const urlScoped = 'http.https://github.com/.extraHeader';
    const env = buildGitSshEnv({
      ...SOURCE,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: urlScoped,
      GIT_CONFIG_VALUE_0: 'Authorization: Bearer url-scoped-secret',
    });
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe(urlScoped);
    expect(env.GIT_CONFIG_VALUE_0).toBe('Authorization: Bearer url-scoped-secret');
  });

  test('drops the config block entirely when no http.extraHeader entry exists', () => {
    const env = buildGitSshEnv({
      ...SOURCE,
      GIT_CONFIG_KEY_0: 'core.hooksPath',
    });
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
  });
});

describe('buildSdkRuntimeEnv', () => {
  test('carries user configuration and proxy/TLS inputs but never credentials', () => {
    const env = buildSdkRuntimeEnv({
      ...SOURCE,
      ANTHROPIC_BASE_URL: 'https://router.corp.example',
      API_TIMEOUT_MS: '300000',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Program Files\\Git\\bin\\bash.exe',
      CLAUDE_CONFIG_DIR: '/custom/claude-config',
      DEBUG_CLAUDE_AGENT_SDK: '1',
    });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://router.corp.example');
    expect(env.API_TIMEOUT_MS).toBe('300000');
    expect(env.CLAUDE_CODE_GIT_BASH_PATH).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
  });

  test('carries git identity, SSH auth, and git command inputs but no other GIT_ inputs', () => {
    const env = buildSdkRuntimeEnv({
      ...SOURCE,
      GIT_AUTHOR_NAME: 'Agent Bot',
      GIT_AUTHOR_EMAIL: 'agent@example.com',
      GIT_COMMITTER_NAME: 'Agent Bot',
      GIT_COMMITTER_EMAIL: 'agent@example.com',
    });
    expect(env.GIT_AUTHOR_NAME).toBe('Agent Bot');
    expect(env.GIT_AUTHOR_EMAIL).toBe('agent@example.com');
    expect(env.GIT_COMMITTER_NAME).toBe('Agent Bot');
    expect(env.GIT_COMMITTER_EMAIL).toBe('agent@example.com');
    expect(env.EMAIL).toBe('agent@example.com');
    expect(env.SSH_AUTH_SOCK).toBe(SOURCE.SSH_AUTH_SOCK);
    expect(env.SSH_AGENT_PID).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBe(SOURCE.GIT_SSH_COMMAND);
    expect(env.GIT_SSL_NO_VERIFY).toBe(SOURCE.GIT_SSL_NO_VERIFY);
    expect(env.GIT_EXEC_PATH).toBe(SOURCE.GIT_EXEC_PATH);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
    expect(env.GIT_CONFIG_VALUE_0).toBe(SOURCE.GIT_CONFIG_VALUE_0);
    expect(env.GIT_CONFIG_KEY_1).toBeUndefined();
  });
});

describe('buildWorkflowConditionEnv', () => {
  test('starts from the credential-free OS baseline without proxy inputs', () => {
    const env = buildWorkflowConditionEnv(undefined, SOURCE);
    expect(env.PATH).toBe(SOURCE.PATH);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.MY_TOOL_FLAG).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  test('injects only non-restricted allowedEnv names from the immutable source', () => {
    const env = buildWorkflowConditionEnv(
      ['MY_TOOL_FLAG', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'SSH_AUTH_SOCK', 'KUBECONFIG'],
      SOURCE
    );
    expect(env.MY_TOOL_FLAG).toBe('1');
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.KUBECONFIG).toBeUndefined();
  });

  test('rejects case-variant restricted and forbidden names', () => {
    const env = buildWorkflowConditionEnv(
      ['ssh_auth_sock', 'anthropic_api_key', 'kubeconfig'],
      SOURCE
    );
    expect(env.ssh_auth_sock).toBeUndefined();
    expect(env.anthropic_api_key).toBeUndefined();
    expect(env.kubeconfig).toBeUndefined();
    expect(isRestrictedEnvName('gh_token')).toBe(true);
    expect(isRestrictedEnvName('MY_TOOL_FLAG')).toBe(false);
  });
});

describe('isRestrictedEnvName', () => {
  test('matches credential, routing, and provider prefixes', () => {
    expect(isRestrictedEnvName('ANTHROPIC_API_KEY')).toBe(true);
    expect(isRestrictedEnvName('CLAUDE_CODE_OAUTH_TOKEN')).toBe(true);
    expect(isRestrictedEnvName('GH_HOST')).toBe(true);
    expect(isRestrictedEnvName('MY_SECRET_VALUE')).toBe(true);
    expect(isRestrictedEnvName('PATH')).toBe(false);
    expect(isRestrictedEnvName('MY_TOOL_FLAG')).toBe(false);
  });
});

describe('startup baseline immutability', () => {
  test('builders read the captured startup baseline, not live process.env mutations', () => {
    const previous = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://live-proxy.example:8080';
    try {
      expect(buildCommandEnv().HTTPS_PROXY).not.toBe('http://live-proxy.example:8080');
      expect(buildCommandEnv(process.env).HTTPS_PROXY).toBe('http://live-proxy.example:8080');
    } finally {
      if (previous === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = previous;
    }
  });

  test.skipIf(process.platform !== 'win32')(
    'resolves allowlisted keys case-insensitively on Windows',
    () => {
      const env = buildOsBaselineEnv({ APPDATA: 'C:\\Users\\agent\\AppData\\Roaming' });
      expect(env.AppData).toBe('C:\\Users\\agent\\AppData\\Roaming');
    }
  );

  test('startup credential discovery refresh picks up post-import login credentials', () => {
    const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'keychain-discovered-token';
    try {
      expect(STARTUP_ENV_BASELINE.CLAUDE_CODE_OAUTH_TOKEN).not.toBe('keychain-discovered-token');
      refreshStartupEnvBaseline();
      expect(STARTUP_ENV_BASELINE.CLAUDE_CODE_OAUTH_TOKEN).toBe('keychain-discovered-token');
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous;
      _setStartupEnvBaselineForTesting(process.env);
    }
  });
});
