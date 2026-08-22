import { describe, expect, test } from 'bun:test';
import {
  buildAcpSafeEnv,
  getAcpCommandIdentity,
  getAcpCommandIdentityDigest,
  parseAcpCommand,
  redactCommandSecrets,
} from '../../../../src/lib/acp/acp-command';

describe('buildAcpSafeEnv', () => {
  test('keeps only safe environment variables without unrelated secrets', () => {
    expect(
      buildAcpSafeEnv({
        HOME: '/Users/devin',
        PATH: '/usr/local/bin:/usr/bin:/bin',
        SHELL: '/bin/zsh',
        TMPDIR: '/var/folders/ab/',
        HTTPS_PROXY: 'http://proxy.internal:8080',
        NO_PROXY: 'localhost,.internal',
        https_proxy: 'http://legacy-secure-proxy.internal:8080',
        http_proxy: 'http://legacy-proxy.internal:8080',
        no_proxy: '127.0.0.1',
        NODE_USE_ENV_PROXY: '1',
        NODE_EXTRA_CA_CERTS: '/certs/internal.pem',
        GITHUB_TOKEN: 'secret',
        ANTHROPIC_API_KEY: 'secret',
      })
    ).toEqual({
      HOME: '/Users/devin',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      SHELL: '/bin/zsh',
      TMPDIR: '/var/folders/ab/',
      HTTPS_PROXY: 'http://proxy.internal:8080',
      NO_PROXY: 'localhost,.internal',
      https_proxy: 'http://legacy-secure-proxy.internal:8080',
      http_proxy: 'http://legacy-proxy.internal:8080',
      no_proxy: '127.0.0.1',
      NODE_USE_ENV_PROXY: '1',
      NODE_EXTRA_CA_CERTS: '/certs/internal.pem',
    });
  });

  test('keeps Windows runtime and profile variables required by native agents', () => {
    const windowsEnv = {
      USERPROFILE: 'C:\\Users\\devin',
      APPDATA: 'C:\\Users\\devin\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\devin\\AppData\\Local',
      TEMP: 'C:\\Users\\devin\\AppData\\Local\\Temp',
      TMP: 'C:\\Windows\\Temp',
      SystemRoot: 'C:\\Windows',
      SystemDrive: 'C:',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      COMSPEC: 'C:\\Windows\\system32\\cmd.exe',
    };

    expect(buildAcpSafeEnv(windowsEnv)).toEqual(windowsEnv);
  });
});

describe('parseAcpCommand', () => {
  test('parses quoted paths, quoted arguments, and escapes', () => {
    expect(
      parseAcpCommand('"/Applications/Devin CLI/devin" acp "model one" escaped\\ arg')
    ).toEqual({
      command: '/Applications/Devin CLI/devin',
      args: ['acp', 'model one', 'escaped arg'],
    });
  });

  test('rejects empty commands', () => {
    expect(() => parseAcpCommand('   ')).toThrow('Invalid ACP command: command is empty');
  });

  test('rejects unmatched quotes', () => {
    expect(() => parseAcpCommand("devin 'acp")).toThrow('Invalid ACP command: unmatched quote');
    expect(() => parseAcpCommand('devin "acp')).toThrow('Invalid ACP command: unmatched quote');
  });
});

describe('getAcpCommandIdentity', () => {
  test('normalizes equivalent command identities', () => {
    expect(getAcpCommandIdentity('devin   acp "model one"')).toBe(
      getAcpCommandIdentity("devin acp 'model one'")
    );
  });
});

describe('getAcpCommandIdentityDigest', () => {
  test('excludes secret-shaped argument values from the digest', () => {
    expect(getAcpCommandIdentityDigest('devin acp --token topsecret')).toBe(
      getAcpCommandIdentityDigest('devin acp --token othersecret')
    );
    expect(getAcpCommandIdentityDigest('agent --api-key=k1 --stdio')).toBe(
      getAcpCommandIdentityDigest('agent --api-key=k2 --stdio')
    );
    expect(getAcpCommandIdentityDigest('agent --password p1 run')).toBe(
      getAcpCommandIdentityDigest('agent --password p2 run')
    );
    expect(getAcpCommandIdentityDigest('devin acp --auth-token=a')).toBe(
      getAcpCommandIdentityDigest('devin acp --auth-token=b')
    );
    expect(getAcpCommandIdentityDigest('agent --token -abc')).toBe(
      getAcpCommandIdentityDigest('agent --token -xyz')
    );
    expect(
      getAcpCommandIdentityDigest('curl -H "Authorization: Bearer topsecret" https://api')
    ).toBe(getAcpCommandIdentityDigest('curl -H "Authorization: Bearer othersafe" https://api'));
    expect(getAcpCommandIdentityDigest('curl -H "Cookie: session=topsecret" https://a')).toBe(
      getAcpCommandIdentityDigest('curl -H "Cookie: session=other" https://a')
    );
    expect(
      getAcpCommandIdentityDigest('sh -c "curl -H \'Authorization: Bearer topsecret\' https://a"')
    ).toBe(
      getAcpCommandIdentityDigest('sh -c "curl -H \'Authorization: Bearer othersafe\' https://a"')
    );
    expect(getAcpCommandIdentityDigest("curl -H'Authorization: Bearer topsecret' https://a")).toBe(
      getAcpCommandIdentityDigest("curl -H'Authorization: Bearer othersafe' https://a")
    );
    expect(getAcpCommandIdentityDigest('curl -u admin:topsecret https://a')).toBe(
      getAcpCommandIdentityDigest('curl -u admin:othersafe https://a')
    );
    expect(getAcpCommandIdentityDigest('curl -uadmin:topsecret https://a')).toBe(
      getAcpCommandIdentityDigest('curl -uadmin:othersafe https://a')
    );
    expect(getAcpCommandIdentityDigest('curl --user admin:topsecret https://a')).toBe(
      getAcpCommandIdentityDigest('curl --user admin:othersafe https://a')
    );
  });

  test('keeps non-credential header values visible in the digest', () => {
    expect(getAcpCommandIdentityDigest('curl -H "X-HTTP-Method-Override: DELETE" /a')).not.toBe(
      getAcpCommandIdentityDigest('curl -H "X-HTTP-Method-Override: PUT" /a')
    );
    expect(getAcpCommandIdentityDigest('curl -H "Accept: application/json" /a')).not.toBe(
      getAcpCommandIdentityDigest('curl -H "Accept: text/plain" /a')
    );
    expect(getAcpCommandIdentityDigest('sh -c "curl -H \'X-Method: DELETE\' /a"')).not.toBe(
      getAcpCommandIdentityDigest('sh -c "curl -H \'X-Method: PUT\' /a"')
    );
    expect(getAcpCommandIdentityDigest("curl -H'X-Method: DELETE' /a")).not.toBe(
      getAcpCommandIdentityDigest("curl -H'X-Method: PUT' /a")
    );
  });

  test('redacts userinfo credentials embedded in positional URLs', () => {
    expect(getAcpCommandIdentityDigest('psql postgresql://alice:topsecret@db/app')).toBe(
      getAcpCommandIdentityDigest('psql postgresql://alice:othersafe@db/app')
    );
    expect(getAcpCommandIdentityDigest('curl https://alice:topsecret@example.test/a')).toBe(
      getAcpCommandIdentityDigest('curl https://alice:othersafe@example.test/a')
    );
    expect(getAcpCommandIdentityDigest('psql postgresql://alice:pw@db-a/app')).not.toBe(
      getAcpCommandIdentityDigest('psql postgresql://alice:pw@db-b/app')
    );
  });

  test('gates tool-specific user options on their executables', () => {
    expect(getAcpCommandIdentityDigest('python3 -u agent-a.py')).not.toBe(
      getAcpCommandIdentityDigest('python3 -u agent-b.py')
    );
    expect(getAcpCommandIdentityDigest('pip install --user package-a')).not.toBe(
      getAcpCommandIdentityDigest('pip install --user package-b')
    );
    expect(getAcpCommandIdentityDigest('python3 -c \'print("one")\'')).not.toBe(
      getAcpCommandIdentityDigest('python3 -c \'print("two")\'')
    );
    expect(getAcpCommandIdentityDigest('curl --user admin:topsecret https://a')).toBe(
      getAcpCommandIdentityDigest('curl --user admin:othersafe https://a')
    );
    expect(getAcpCommandIdentityDigest('curl --user=admin:topsecret https://a')).toBe(
      getAcpCommandIdentityDigest('curl --user=admin:othersafe https://a')
    );
    expect(getAcpCommandIdentityDigest('env API_TOKEN=topsecret agent')).toBe(
      getAcpCommandIdentityDigest('env API_TOKEN=othersafe agent')
    );
    expect(getAcpCommandIdentityDigest('env MODE=fast agent')).not.toBe(
      getAcpCommandIdentityDigest('env MODE=slow agent')
    );
    expect(getAcpCommandIdentityDigest("sh -c 'API_TOKEN=topsecret curl https://a'")).toBe(
      getAcpCommandIdentityDigest("sh -c 'API_TOKEN=othersafe curl https://a'")
    );
    expect(getAcpCommandIdentityDigest("sh -c 'export API_TOKEN=topsecret'")).toBe(
      getAcpCommandIdentityDigest("sh -c 'export API_TOKEN=othersafe'")
    );
  });

  test('does not swallow the next flag after a valueless secret flag', () => {
    expect(getAcpCommandIdentityDigest('agent --token --verbose one')).not.toBe(
      getAcpCommandIdentityDigest('agent --token --verbose two')
    );
    expect(getAcpCommandIdentityDigest('agent --token --verbose')).not.toBe(
      getAcpCommandIdentityDigest('agent --verbose --token')
    );
  });

  test('still distinguishes commands that differ outside secret arguments', () => {
    expect(getAcpCommandIdentityDigest('devin acp --stdio')).not.toBe(
      getAcpCommandIdentityDigest('other-acp --stdio')
    );
    expect(getAcpCommandIdentityDigest('devin acp --model one')).not.toBe(
      getAcpCommandIdentityDigest('devin acp --model two')
    );
    expect(getAcpCommandIdentityDigest('devin acp --token a --stdio')).not.toBe(
      getAcpCommandIdentityDigest('devin acp --token a --verbose')
    );
    expect(getAcpCommandIdentityDigest('devin acp --max-tokens 4096')).not.toBe(
      getAcpCommandIdentityDigest('devin acp --max-tokens 8192')
    );
    expect(getAcpCommandIdentityDigest('devin acp --password-policy strict')).not.toBe(
      getAcpCommandIdentityDigest('devin acp --password-policy relaxed')
    );
  });
});

describe('redactCommandSecrets', () => {
  test('preserves token boundaries when redisplaying shell command arguments', () => {
    expect(redactCommandSecrets('sh', ['-c', `rm -- "important file" --token topsecret`])).toEqual([
      '-c',
      `rm -- "important file" --token [redacted]`,
    ]);
    expect(
      redactCommandSecrets('sh', ['-c', `curl -H 'Authorization: Bearer topsecret' https://a`])
    ).toEqual(['-c', `curl -H '[redacted]' https://a`]);
    expect(
      redactCommandSecrets('sh', ['-c', `echo "safe; rm -rf /" && curl --token topsecret`])
    ).toEqual(['-c', `echo "safe; rm -rf /" && curl --token [redacted]`]);
    expect(redactCommandSecrets('sh', ['-c', `API_TOKEN=topsecret curl https://a`])).toEqual([
      '-c',
      `API_TOKEN=[redacted] curl https://a`,
    ]);
    expect(redactCommandSecrets('sh', ['-c', `pip install --user package-a`])).toEqual([
      '-c',
      `pip install --user package-a`,
    ]);
    expect(redactCommandSecrets('sh', ['-c', `echo topsecret && curl --token topsecret`])).toEqual([
      '-c',
      `echo topsecret && curl --token [redacted]`,
    ]);
    expect(
      redactCommandSecrets('sh', ['-c', `echo 'Bearer x' && curl -H 'Authorization: Bearer x'`])
    ).toEqual(['-c', `echo 'Bearer x' && curl -H '[redacted]'`]);
    expect(
      redactCommandSecrets('sh', ['-c', `echo "--token topsecret" && curl --token topsecret`])
    ).toEqual(['-c', `echo "--token topsecret" && curl --token [redacted]`]);
  });

  test('stops treating assignments as environment after the command word', () => {
    expect(getAcpCommandIdentityDigest(`sh -c "rm -- 'API_TOKEN=one'"`)).not.toBe(
      getAcpCommandIdentityDigest(`sh -c "rm -- 'API_TOKEN=two'"`)
    );
    expect(redactCommandSecrets('sh', ['-c', `rm -- 'API_TOKEN=one'`])).toEqual([
      '-c',
      `rm -- 'API_TOKEN=one'`,
    ]);
    expect(redactCommandSecrets('sh', ['-c', `MODE=prod rm -- 'API_TOKEN=one'`])).toEqual([
      '-c',
      `MODE=prod rm -- 'API_TOKEN=one'`,
    ]);
    expect(getAcpCommandIdentityDigest('env FOO=1 cmd data=one')).not.toBe(
      getAcpCommandIdentityDigest('env FOO=1 cmd data=two')
    );
    expect(getAcpCommandIdentityDigest('env MODE=prod API_TOKEN=topsecret agent')).toBe(
      getAcpCommandIdentityDigest('env MODE=prod API_TOKEN=othersafe agent')
    );
    expect(getAcpCommandIdentityDigest("sh -c 'export MODE=prod API_TOKEN=topsecret'")).toBe(
      getAcpCommandIdentityDigest("sh -c 'export MODE=prod API_TOKEN=othersafe'")
    );
  });

  test('keeps the quote wrapper around redacted url tokens', () => {
    expect(redactCommandSecrets('sh', ['-c', `curl 'https://u:p@h/a?x=1&y=2'`])).toEqual([
      '-c',
      `curl 'https://u:[redacted]@h/a?x=1&y=2'`,
    ]);
  });

  test('recurses combined shell flags with c before other letters', () => {
    expect(getAcpCommandIdentityDigest(`bash -cl 'curl --token topsecret'`)).toBe(
      getAcpCommandIdentityDigest(`bash -cl 'curl --token othersafe'`)
    );
    expect(redactCommandSecrets('bash', ['-cl', `curl --token topsecret`])).toEqual([
      '-cl',
      `curl --token [redacted]`,
    ]);
  });

  test('redacts leading assignments inside shell scripts', () => {
    expect(
      getAcpCommandIdentityDigest("sh -c 'MODE=prod API_TOKEN=topsecret curl https://a'")
    ).toBe(getAcpCommandIdentityDigest("sh -c 'MODE=prod API_TOKEN=othersafe curl https://a'"));
    expect(
      redactCommandSecrets('sh', ['-lc', `MODE=prod API_TOKEN=topsecret curl https://a`])
    ).toEqual(['-lc', `MODE=prod API_TOKEN=[redacted] curl https://a`]);
    expect(getAcpCommandIdentityDigest('bash -xc "curl --token topsecret"')).toBe(
      getAcpCommandIdentityDigest('bash -xc "curl --token othersafe"')
    );
    expect(redactCommandSecrets('bash', ['-lc', `curl --token topsecret`])).toEqual([
      '-lc',
      `curl --token [redacted]`,
    ]);
    expect(redactCommandSecrets('bash', ['-xc', `curl --token topsecret`])).toEqual([
      '-xc',
      `curl --token [redacted]`,
    ]);
  });

  test('redisplays shell scripts verbatim when nothing was redacted', () => {
    expect(redactCommandSecrets('sh', ['-c', 'echo "safe; rm -rf /"'])).toEqual([
      '-c',
      'echo "safe; rm -rf /"',
    ]);
    expect(redactCommandSecrets('sh', ['-c', "echo 'a b' && echo c"])).toEqual([
      '-c',
      "echo 'a b' && echo c",
    ]);
  });
});
