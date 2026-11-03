import { execFileSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';

const checkedFiles = new Map<string, string>();

export function checkWindowsCredential(path: string, create = false, identity?: string): void {
  if (create) checkedFiles.delete(path);
  else if (identity !== undefined && checkedFiles.get(path) === identity) return;
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot)
    throw new Error('SystemRoot is required to verify local credential permissions.');
  const script = `
$ErrorActionPreference = 'Stop'
$credentialPath = $env:HYPERNEO_CREDENTIAL_PATH
$ownerSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($env:HYPERNEO_CREDENTIAL_CREATE -eq '1') {
  $credentialAcl = [System.Security.AccessControl.FileSecurity]::new()
  $credentialAcl.SetOwner($ownerSid)
  $credentialAcl.SetAccessRuleProtection($true, $false)
  $credentialRule = [System.Security.AccessControl.FileSystemAccessRule]::new($ownerSid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
  $credentialAcl.AddAccessRule($credentialRule)
  [System.IO.File]::SetAccessControl($credentialPath, $credentialAcl)
}
$credentialAcl = [System.IO.File]::GetAccessControl($credentialPath)
if ($credentialAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $ownerSid.Value) { throw 'Local credential has another owner.' }
foreach ($credentialRule in $credentialAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($credentialRule.AccessControlType -eq 'Allow' -and ($credentialRule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::ReadData) -ne 0 -and $credentialRule.IdentityReference.Value -ne $ownerSid.Value) { throw 'Local credential is readable by another principal.' }
}`;
  execFileSync(
    join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      env: {
        SystemRoot: systemRoot,
        USERPROFILE: process.env.USERPROFILE,
        TEMP: process.env.TEMP,
        HYPERNEO_CREDENTIAL_PATH: path,
        HYPERNEO_CREDENTIAL_CREATE: create ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 10_000,
    }
  );
  if (!create && identity !== undefined) checkedFiles.set(path, identity);
}
