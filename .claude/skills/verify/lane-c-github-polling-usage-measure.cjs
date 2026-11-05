const fs = require('node:fs');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const root = 'packages/daemon/src/storage/repositories/';
const specs = [
  ['github-polling-usage-read.ts', 47, null],
  ['github-polling-repos-read.ts', 56, '39618e09a7cd70b7325cf31b205eb221f338ebe58ff6ea50bebef49a22b28d06'],
  ['github-watched-repos-read.ts', 44, '4c5945ea131459249bb302cdb27ee6a014fc6aadd5d15f9d402b3226972e6a95'],
];
const modules = specs.map(([name, expectedLines, expectedHash]) => {
  const file = root + name, text = fs.readFileSync(file, 'utf8');
  const lines = text.trimEnd().split('\n').length, sha256 = hash(text);
  if (lines !== expectedLines || (expectedHash && sha256 !== expectedHash)) throw Error('Polling read module drift: ' + name);
  return { file, lines, sha256, counted: true };
});
const registry = fs.readFileSync('packages/daemon/src/storage/db-gateway/db-ops.ts', 'utf8');
for (const name of ['gitHubPollingCapabilityReads', 'gitHubPollingTimerReads']) {
  if ((registry.match(new RegExp('    ' + name + ',', 'g')) ?? []).length !== 1) throw Error('Missing/duplicate registry entry: ' + name);
}
const fullOwnedGraphLines = modules.reduce((n, row) => n + row.lines, 0);
const sharedRegistrationChangedLines = 7, smokeRegistrationLines = 0;
const knownTotal = fullOwnedGraphLines + sharedRegistrationChangedLines + smokeRegistrationLines;
if (knownTotal > 200) throw Error('Polling read construction exceeds 200 lines');
const report = {
  head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  modules, fullOwnedGraphLines, sharedRegistrationChangedLines, smokeRegistrationLines,
  knownTotal, excludedLines: 0,
  contract: 'Read-only capability/timer operations, boolean-only replies, configured/intent/session short-circuit order and existing active-row selection/errors; gateway owns deferred read snapshot, no initialization or callbacks.',
  auditLimit: 'Complete command/query/mapper modules counted plus append-only registrations. Shared gateway/runtime/public callback closure not audited; no public callback activation. #9438/#8714 remain incomplete.',
};
fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ fullOwnedGraphLines, knownTotal, excludedLines: 0 }));
