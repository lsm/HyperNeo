import { describe, expect, test } from 'bun:test';
import {
  buildAcpSafeEnv,
  getAcpCommandIdentity,
  getAcpCommandIdentityDigest,
  parseAcpCommand,
  redactCommandSecrets,
  shellQuote,
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

  test('keeps curl ownership across positional arguments', () => {
    expect(
      getAcpCommandIdentityDigest('curl https://example.test -H "Authorization: Bearer a"')
    ).toBe(getAcpCommandIdentityDigest('curl https://example.test -H "Authorization: Bearer b"'));
    expect(getAcpCommandIdentityDigest('curl https://example.test -u alice:topsecret')).toBe(
      getAcpCommandIdentityDigest('curl https://example.test -u alice:othersafe')
    );
  });

  test('redacts credentials behind clustered curl flags', () => {
    expect(getAcpCommandIdentityDigest(`curl -sH 'Authorization: Bearer topsecret' /a`)).toBe(
      getAcpCommandIdentityDigest(`curl -sH 'Authorization: Bearer othersafe' /a`)
    );
    expect(getAcpCommandIdentityDigest(`curl -sU alice:topsecret /a`)).toBe(
      getAcpCommandIdentityDigest(`curl -sU alice:othersafe /a`)
    );
  });

  test('redacts userinfo inside option values', () => {
    expect(getAcpCommandIdentityDigest('curl --url=https://alice:topsecret@h/a')).toBe(
      getAcpCommandIdentityDigest('curl --url=https://alice:othersafe@h/a')
    );
  });
});

describe('shellQuote', () => {
  test('passes safe tokens through and quotes the rest with single quotes', () => {
    expect(shellQuote('/usr/local/bin/curl')).toBe('/usr/local/bin/curl');
    expect(shellQuote('two words')).toBe("'two words'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });
});

describe('redactCommandSecrets', () => {
  test('redacts credentials behind clustered and attached curl flags', () => {
    expect(redactCommandSecrets('curl', ['-sH', 'Authorization: Bearer topsecret', '/a'])).toEqual([
      '-sH',
      '[redacted]',
      '/a',
    ]);
  });

  test('does not treat curl data values as credential flags', () => {
    expect(redactCommandSecrets('curl', ['-duser=delete-all', '/a'])).toEqual([
      '-duser=delete-all',
      '/a',
    ]);
    expect(getAcpCommandIdentityDigest('curl -duser=delete-all /a')).not.toBe(
      getAcpCommandIdentityDigest('curl -duser=other /a')
    );
  });

  test('redacts curl proxy-user credentials', () => {
    expect(
      redactCommandSecrets('curl', ['--proxy-user', 'alice:topsecret', 'https://api'])
    ).toEqual(['--proxy-user', '[redacted]', 'https://api']);
    expect(getAcpCommandIdentityDigest('curl --proxy-user alice:topsecret https://api')).toBe(
      getAcpCommandIdentityDigest('curl --proxy-user other:safe https://api')
    );
  });

  test('consumes dash-prefixed curl user values', () => {
    expect(redactCommandSecrets('curl', ['-u', '--topsecret:', 'https://api'])).toEqual([
      '-u',
      '[redacted]',
      'https://api',
    ]);
  });

  test('redacts url passwords with empty usernames', () => {
    expect(redactCommandSecrets('curl', ['https://:topsecret@example.test/a'])).toEqual([
      'https://:[redacted]@example.test/a',
    ]);
  });

  test('normalizes windows executable names', () => {
    expect(
      redactCommandSecrets('C:\\Windows\\System32\\curl.exe', [
        '-H',
        'Authorization: Bearer topsecret',
        'https://api',
      ])
    ).toEqual(['-H', '[redacted]', 'https://api']);
  });

  test('redacts url userinfo inside environment assignments', () => {
    expect(
      redactCommandSecrets('env', ['DATABASE_URL=postgresql://alice:topsecret@db/app', 'agent'])
    ).toEqual(['DATABASE_URL=postgresql://alice:[redacted]@db/app', 'agent']);
  });

  test('treats tokens after -- as positional data', () => {
    expect(getAcpCommandIdentityDigest(`rm -- --password file-a`)).not.toBe(
      getAcpCommandIdentityDigest(`rm -- --password file-b`)
    );
    expect(redactCommandSecrets('rm', ['--', '--password', 'file-a'])).toEqual([
      '--',
      '--password',
      'file-a',
    ]);
  });

  test('stops treating assignments as environment after the command word', () => {
    expect(getAcpCommandIdentityDigest('env FOO=1 cmd data=one')).not.toBe(
      getAcpCommandIdentityDigest('env FOO=1 cmd data=two')
    );
    expect(getAcpCommandIdentityDigest('env MODE=prod API_TOKEN=topsecret agent')).toBe(
      getAcpCommandIdentityDigest('env MODE=prod API_TOKEN=othersafe agent')
    );
  });
});
