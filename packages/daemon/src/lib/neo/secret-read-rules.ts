import { join } from 'node:path';

const SECRET_DIRS = [
  '.ssh',
  '.aws',
  '.azure',
  '.gcloud',
  '.gnupg',
  '.kube',
  '.docker',
  '.config/gcloud',
  '.config/gh',
  '.config/op',
  '.config/github-copilot',
  '.config/Code',
  '.config/Code - OSS',
  '.config/VSCodium',
  '.config/discord',
  '.config/Slack',
  '.config/Signal',
  '.config/google-chrome',
  '.config/chromium',
  '.config/BraveSoftware',
  'Library/Keychains',
  'Library/Cookies',
  'Library/Safari',
  'Library/Notes',
  'Library/Group Containers',
  'Library/Application Support/Code',
  'Library/Application Support/Code - Insiders',
  'Library/Application Support/Firefox',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Microsoft Edge',
  'Library/Application Support/BraveSoftware',
  'Library/Application Support/Arc',
  'Library/Application Support/Chromium',
  'Library/Application Support/Opera',
  'Library/Application Support/com.operasoftware.Opera',
  'Library/Application Support/Vivaldi',
  'Library/Application Support/Slack',
  'Library/Application Support/discord',
  'Library/Application Support/Signal',
  'Library/Application Support/Telegram Desktop',
  'Library/Application Support/Claude',
  'Library/Mail',
  'Library/Messages',
  'Library/MobileSync/Backups',
];
const SECRET_FILES = [
  '.claude/.credentials.json',
  '.claude/settings.json',
  '.claude/settings.local.json',
  '.claude.json',
  '.git-credentials',
  '.config/git/credentials',
  '.bash_history',
  '.zsh_history',
  '.netrc',
  '.npmrc',
  '.zshrc',
  '.zshenv',
  '.zprofile',
  '.bashrc',
  '.bash_profile',
  '.profile',
];
const SECRET_NAMES = ['.env', '.env.*', '*.pem', '*.key'];

export function secretHomePaths(home: string): string[] {
  return [...SECRET_DIRS, ...SECRET_FILES].map((path) => join(home, path));
}

export function secretNamePatterns(home: string): string[] {
  return SECRET_NAMES.flatMap((name) => [join(home, name), join(home, '*', name)]);
}

export function neoSecretReadRules(): string[] {
  return [
    ...SECRET_DIRS.map((dir) => `~/${dir}/**`),
    ...SECRET_FILES.flatMap((file) => [`~/${file}`, `~/**/${file}`]),
    ...SECRET_NAMES.map((name) => `~/**/${name}`),
  ].map((path) => `Read(${path})`);
}
