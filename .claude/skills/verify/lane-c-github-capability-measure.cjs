const fs = require('node:fs');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const ts = require(process.cwd() + '/node_modules/typescript');
const hash = text => createHash('sha256').update(text).digest('hex');
const extension = 'packages/daemon/src/lib/external-events/github/github-event-extension.ts';
function units(file) {
  const text = fs.readFileSync(file, 'utf8'), sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), rows = [];
  function walk(node) {
    if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isConstructorDeclaration(node)) {
      const name = ts.isConstructorDeclaration(node) ? 'constructor' : node.name?.getText(sf);
      if (name) rows.push({ file, name, lines: sf.getLineAndCharacterOfPosition(node.end).line - sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, sha256: hash(node.getText(sf)) });
    }
    ts.forEachChild(node, walk);
  }
  walk(sf);
  return rows;
}
const selectedNames = ['enablePollingCapability', 'disablePollingCapabilityIfUnused', 'pollingCapabilityTail', 'runPollingCapabilityUpdate'];
const all = units(extension), selected = all.filter(row => selectedNames.includes(row.name));
if (selected.length !== 4) throw Error('Missing capability effect owner/queue');
const untouched = all.filter(row => !selectedNames.includes(row.name)).map(row => [row.name, row.sha256]);
if (hash(JSON.stringify(untouched)) !== '84ef91134de24f90d9a73c49b2d85484fd02b19b66aca56812f7790f14a926b9') throw Error('Other extension code changed');
const specs = [
  ['github-polling-usage-read.ts', 47, '84752c5c336df50f98a7941c53eb93c343ac0ff443e7c669fc52566a33145289'],
  ['github-polling-repos-read.ts', 56, '39618e09a7cd70b7325cf31b205eb221f338ebe58ff6ea50bebef49a22b28d06'],
  ['github-watched-repos-read.ts', 44, '4c5945ea131459249bb302cdb27ee6a014fc6aadd5d15f9d402b3226972e6a95'],
];
const data = specs.map(([name, lines, expected]) => {
  const file = 'packages/daemon/src/storage/repositories/' + name, text = fs.readFileSync(file, 'utf8');
  if (text.trimEnd().split('\n').length !== lines || hash(text) !== expected) throw Error('Counted reader/query/mapper drift: ' + name);
  return { file, lines, sha256: expected, counted: true };
});
const bridges = units('packages/daemon/src/lib/external-events/extension-config-store.ts').filter(row => ['getGlobalConfig', 'setGlobalConfig'].includes(row.name));
if (bridges.length !== 2) throw Error('Missing existing config bridge root');
const bridgeHashes = { getGlobalConfig: '34bae87ad4dce4c77e3ac0caa2465d62db43dbdf4ba0009183b520c58efd3e23', setGlobalConfig: '9fda9b0825dc5a808ea4876bdd824280ed4dc40d30fffd76faaa3542a516986a' };
for (const row of bridges) { if (row.sha256 !== bridgeHashes[row.name]) throw Error('Existing config bridge drift'); row.pinnedNotAudited = true; }
const fresh = selected.concat(data).reduce((n, row) => n + row.lines, 1);
const bridgeLines = bridges.reduce((n, row) => n + row.lines, 0), smokeLines = 0;
const knownTotal = fresh + bridgeLines + smokeLines;
if (knownTotal > 200) throw Error('Capability reader wiring exceeds 200 lines');
const report = { head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), selected, data, bridges, fresh, bridgeLines, smokeLines, knownTotal, excludedDataLines: 0, contract: 'Capability usage moves to existing read-only worker pipeline; main owns global config effects, serialized by the local capability effect queue across read/config awaits. Existing source/scope/error behavior remains; no read fallback or write replay.', getterInterfaceContract: 'Child #9671 changes the existing four-line getter to reader-backed delegation, preserving validation/result/error interfaces. Its complete owned graph is independently measured with zero exclusions; no new data exclusion or transitive audit here.', auditLimit: 'Sibling #9663 refreshes only getGlobalConfig to a four-line main-side delegation; its constructor-free query/JSON extraction is independently counted with zero exclusions, not a new transitive audit here. Sibling #9657 refreshes only the retired six-line helper deletion pin, with selected roots and data exclusions unchanged. Sibling #9655 refreshes only the watchRepo callback pin: approved fresh167/excluded97/known264, no changes to this owned graph. Same existing get/set config interface roots counted and pinned-not-audited, no full public/framework/transitive closure. Sibling #9651 intentionally refreshes the non-capability pin for a separately counted 199-line public polling timer activation; the remaining global-config reads stay main-side; Sibling #9653 refreshes only the unwatch callback pin for its fully counted 196-line timer activation; no startup/shutdown or final #8714 claim. Queue covers these extension-owned capability helpers, not unrelated config writers.' };
fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ fresh, bridgeLines, smokeLines, knownTotal, excludedDataLines: 0 }));
