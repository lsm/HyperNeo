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
  lookupEnvValue,
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
  windir: 'C:\\Windows',
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
  VIRTUAL_ENV: '/Users/agent/.venv',
  CONDA_PREFIX: '/Users/agent/miniconda3/envs/prod',
  CONDA_DEFAULT_ENV: 'prod',
  CLOUDSDK_CONFIG: '/Users/agent/.config/gcloud',
  CC: 'clang',
  CXX: 'clang++',
};

describe('buildOsBaselineEnv', () => {
  test('keeps OS/runtime keys and drops credentials and routing variables', () => {
    const env = buildOsBaselineEnv(SOURCE);
    expect(env.PATH).toBe(SOURCE.PATH);
    expect(env.HOME).toBe(SOURCE.HOME);
    expect(env.USERNAME).toBe(SOURCE.USERNAME);
    expect(env.CI).toBe(SOURCE.CI);
    expect(env.JAVA_HOME).toBe(SOURCE.JAVA_HOME);
    expect(env.NODE_ENV).toBe(SOURCE.NODE_ENV);
    expect(env.CC).toBe(SOURCE.CC);
    expect(env.CXX).toBe(SOURCE.CXX);
    expect(env.windir).toBe(SOURCE.windir);
    expect(env.ProgramFiles).toBe(SOURCE.ProgramFiles);
    expect(env['ProgramFiles(x86)']).toBe(SOURCE['ProgramFiles(x86)']);
    expect(env.ProgramW6432).toBe(SOURCE.ProgramW6432);
    expect(env.LC_CTYPE).toBe(SOURCE.LC_CTYPE);
    expect(env.LC_COLLATE).toBe(SOURCE.LC_COLLATE);
    expect(env.LC_NUMERIC).toBe(SOURCE.LC_NUMERIC);
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
    expect(env.REQUESTS_CA_BUNDLE).toBe(SOURCE.REQUESTS_CA_BUNDLE);
    expect(env.GIT_SSL_CAPATH).toBe(SOURCE.GIT_SSL_CAPATH);
    expect(env.GIT_SSL_VERSION).toBe(SOURCE.GIT_SSL_VERSION);
    expect(env.GIT_SSL_CIPHER_LIST).toBe(SOURCE.GIT_SSL_CIPHER_LIST);
    expect(env.GIT_HTTP_PROXY_AUTHMETHOD).toBe(SOURCE.GIT_HTTP_PROXY_AUTHMETHOD);
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
  test('keeps safe git variables and excludes secret carriers, SSH/askpass, auth config, and proxy inputs', () => {
    const env = buildGitCommandEnv({
      ...SOURCE,
      GIT_CONFIG_GLOBAL: '/tmp/gitconfig-global',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_2: 'safe.directory',
      GIT_CONFIG_VALUE_2: '/workspace',
    });
    expect(env.GIT_SSL_CAINFO).toBe(SOURCE.GIT_SSL_CAINFO);
    expect(env.GIT_SSL_CAPATH).toBeUndefined();
    expect(env.GIT_EXEC_PATH).toBe(SOURCE.GIT_EXEC_PATH);
    expect(env.GIT_CEILING_DIRECTORIES).toBe(SOURCE.GIT_CEILING_DIRECTORIES);
    expect(env.GIT_DISCOVERY_ACROSS_FILESYSTEM).toBe(SOURCE.GIT_DISCOVERY_ACROSS_FILESYSTEM);
    expect(env.GIT_ALLOW_PROTOCOL).toBe(SOURCE.GIT_ALLOW_PROTOCOL);
    expect(env.GIT_TERMINAL_PROMPT).toBe(SOURCE.GIT_TERMINAL_PROMPT);
    expect(env.GIT_CONFIG_NOSYSTEM).toBe(SOURCE.GIT_CONFIG_NOSYSTEM);
    expect(env.GIT_ATTR_NOSYSTEM).toBe(SOURCE.GIT_ATTR_NOSYSTEM);
    expect(env.GIT_LFS_SKIP_SMUDGE).toBe(SOURCE.GIT_LFS_SKIP_SMUDGE);
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('safe.directory');
    expect(env.GIT_CONFIG_VALUE_0).toBe('/workspace');
    expect(env.HTTPS_PROXY).toBeUndefined();
  });
});

describe('buildGitSshEnv', () => {
  test('adds SSH, askpass, and TLS client inputs plus reindexed http.extraHeader config only', () => {
    const env = buildGitSshEnv({
      ...SOURCE,
      GIT_ASKPASS: '/usr/local/bin/git-askpass',
      GIT_SSL_CERT: '/tmp/client-cert.pem',
      GIT_SSL_KEY: '/tmp/client-key.pem',
      GIT_SSL_CERT_PASSWORD_PROTECTED: '1',
    });
    expect(env.SSH_AUTH_SOCK).toBe(SOURCE.SSH_AUTH_SOCK);
    expect(env.GIT_SSH_COMMAND).toBe(SOURCE.GIT_SSH_COMMAND);
    expect(env.GIT_ASKPASS).toBe('/usr/local/bin/git-askpass');
    expect(env.VSCODE_GIT_ASKPASS_NODE).toBe(SOURCE.VSCODE_GIT_ASKPASS_NODE);
    expect(env.VSCODE_GIT_ASKPASS_MAIN).toBe(SOURCE.VSCODE_GIT_ASKPASS_MAIN);
    expect(env.VSCODE_GIT_IPC_HANDLE).toBe(SOURCE.VSCODE_GIT_IPC_HANDLE);
    expect(env.GIT_SSL_CERT).toBe('/tmp/client-cert.pem');
    expect(env.GIT_SSL_KEY).toBe('/tmp/client-key.pem');
    expect(env.GIT_SSL_CERT_PASSWORD_PROTECTED).toBe('1');
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
    expect(env.GIT_CONFIG_VALUE_0).toBe(SOURCE.GIT_CONFIG_VALUE_0);
    expect(env.GIT_CONFIG_KEY_1).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_1).toBeUndefined();
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
    expect(env.CLAUDE_CONFIG_DIR).toBe('/custom/claude-config');
    expect(env.DEBUG_CLAUDE_AGENT_SDK).toBe('1');
    expect(env.VIRTUAL_ENV).toBe(SOURCE.VIRTUAL_ENV);
    expect(env.CONDA_PREFIX).toBe(SOURCE.CONDA_PREFIX);
    expect(env.CONDA_DEFAULT_ENV).toBe(SOURCE.CONDA_DEFAULT_ENV);
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.VSCODE_GIT_ASKPASS_NODE).toBe(SOURCE.VSCODE_GIT_ASKPASS_NODE);
    expect(env.VSCODE_GIT_ASKPASS_MAIN).toBe(SOURCE.VSCODE_GIT_ASKPASS_MAIN);
    expect(env.VSCODE_GIT_IPC_HANDLE).toBe(SOURCE.VSCODE_GIT_IPC_HANDLE);
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
    expect(env.GNUPGHOME).toBe(SOURCE.GNUPGHOME);
    expect(env.GPG_TTY).toBe(SOURCE.GPG_TTY);
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

  test('rejects askpass companion variables that could unlock credential prompts', () => {
    const env = buildWorkflowConditionEnv(
      ['VSCODE_GIT_ASKPASS_NODE', 'VSCODE_GIT_ASKPASS_MAIN', 'VSCODE_GIT_IPC_HANDLE'],
      SOURCE
    );
    expect(env.VSCODE_GIT_ASKPASS_NODE).toBeUndefined();
    expect(env.VSCODE_GIT_ASKPASS_MAIN).toBeUndefined();
    expect(env.VSCODE_GIT_IPC_HANDLE).toBeUndefined();
  });

  test('rejects inline container and cloud credential configuration', () => {
    const env = buildWorkflowConditionEnv(
      ['DOCKER_AUTH_CONFIG', 'DOCKER_CONFIG', 'CLOUDSDK_CONFIG', 'MY_TOOL_FLAG'],
      SOURCE
    );
    expect(env.DOCKER_AUTH_CONFIG).toBeUndefined();
    expect(env.DOCKER_CONFIG).toBeUndefined();
    expect(env.CLOUDSDK_CONFIG).toBeUndefined();
    expect(env.MY_TOOL_FLAG).toBe('1');
  });

  test('rejects inline git configuration carriers', () => {
    const env = buildWorkflowConditionEnv(['GIT_CONFIG_PARAMETERS'], SOURCE);
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
  });
});

describe('lookupEnvValue', () => {
  test('resolves case-variant keys case-insensitively on Windows only', () => {
    const source: Record<string, string> = {
      Path: 'C:\\Windows\\system32;C:\\Windows',
      APPDATA: 'C:\\Users\\agent\\AppData\\Roaming',
      anthropic_auth_token: 'sk-ant-oat-variant',
    };
    expect(lookupEnvValue(source, 'PATH', 'win32')).toBe(source.Path);
    expect(lookupEnvValue(source, 'AppData', 'win32')).toBe(source.APPDATA);
    expect(lookupEnvValue(source, 'ANTHROPIC_AUTH_TOKEN', 'win32')).toBe(
      source.anthropic_auth_token
    );
    expect(lookupEnvValue(source, 'PATH', 'darwin')).toBeUndefined();
    expect(lookupEnvValue(source, 'AppData', 'linux')).toBeUndefined();
    expect(lookupEnvValue(source, 'Path', 'win32')).toBe(source.Path);
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
