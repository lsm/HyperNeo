const fs = require('node:fs');
const cp = require('node:child_process');
const ts = require(process.cwd() + '/node_modules/typescript');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const file = 'packages/daemon/src/lib/external-events/github/github-event-extension.ts';
const text = fs.readFileSync(file, 'utf8'), sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
const selectedNames = ['stopIdlePollingOnReader', 'runPollingCapabilityUpdate', 'pollingCapabilityTail', 'pollTimer', 'assertRpcConfigEnabled'];
const selected = [], unchanged = [], otherRpcs = [];
let caller;
const lines = node => sf.getLineAndCharacterOfPosition(node.end).line - sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
function walk(node) {
  if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isConstructorDeclaration(node)) {
    const name = ts.isConstructorDeclaration(node) ? 'constructor' : node.name?.getText(sf);
    if (selectedNames.includes(name)) selected.push({ file, name, lines: lines(node), sha256: hash(node.getText(sf)) });
    else if (name && name !== 'registerRpcHandlers') unchanged.push([name, hash(node.getText(sf))]);
  }
  if (ts.isCallExpression(node) && node.expression.getText(sf).endsWith('.onRequest') && typeof node.arguments[0]?.text === 'string') {
    const name = node.arguments[0].text, callback = node.arguments[1];
    if (name === 'space.github.unwatchRepo') {
      const body = callback.getText(sf);
      if (!body.includes('await this.stopIdlePollingOnReader();')) throw Error('Unwatch caller does not await timer ownership');
      const before = body.replace('await this.stopIdlePollingOnReader();', 'this.maybeStopPolling();');
      if (hash(before) !== '1d6799de17572842854fff6f306321dfb117f3694517fecfd74a7cc4f4746a9b') throw Error('Unwatch caller changed beyond one awaited timer call');
      caller = { file, name, lines: lines(callback), sha256: hash(body), onlyAwaitedTimerCallChanged: true };
    } else otherRpcs.push([name, hash(callback.getText(sf))]);
  }
  ts.forEachChild(node, walk);
}
walk(sf);
if (!caller || selected.length !== selectedNames.length) throw Error('Missing owned timer roots');
if (hash(JSON.stringify(unchanged)) !== '3d36aa2e60b741fcb96f0b445ddcd7323ceee770c34b952c5b65c613370e2cd6') throw Error('Other extension method or field changed');
if (hash(JSON.stringify(otherRpcs)) !== '48db5014798bba7ace37d242ae352ded3bb49733a2c6a1f1ec02d9e17c02a7c6') throw Error('Other public RPC caller changed');
const specs = [
  ['github-polling-usage-read.ts', 47, '84752c5c336df50f98a7941c53eb93c343ac0ff443e7c669fc52566a33145289'],
  ['github-polling-repos-read.ts', 56, '39618e09a7cd70b7325cf31b205eb221f338ebe58ff6ea50bebef49a22b28d06'],
  ['github-watched-repos-read.ts', 44, '4c5945ea131459249bb302cdb27ee6a014fc6aadd5d15f9d402b3226972e6a95'],
];
const data = specs.map(([name, expectedLines, expected]) => {
  const path = 'packages/daemon/src/storage/repositories/' + name, body = fs.readFileSync(path, 'utf8');
  const actualLines = body.trimEnd().split('\n').length;
  if (actualLines !== expectedLines || hash(body) !== expected) throw Error('Counted data module drift: ' + name);
  return { file: path, lines: actualLines, sha256: expected, counted: true };
});
const importLines = 1, smokeLines = 0;
const fullOwnedGraphLines = selected.concat(data, [caller]).reduce((n, row) => n + row.lines, importLines + smokeLines);
if (fullOwnedGraphLines > 200) throw Error('Public unwatch timer slice exceeds 200 lines');
const report = { head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), selected, caller, data, importLines, smokeLines, fullOwnedGraphLines, excludedLines: 0, contract: 'One public timer call site awaits the registered reader in the existing effect queue; captured handle prevents clearing another lifetime. No timer/provider skips admission, errors propagate after known writes, no fallback/replay.', auditLimit: 'Sibling #9657 refreshes only the retired six-line helper deletion pin, with selected roots and data exclusions unchanged. Sibling #9655 refreshes only the watchRepo callback pin: approved fresh167/excluded97/known264, no changes to this owned graph. Complete selected unwatch caller/auth, timer owner and reader/query/mapper counted. The retired synchronous helper is deleted; the unwatch deletion/webhook/config subtree is unchanged and not re-audited. Existing writer/capability subtrees retain separate audits; no full public/framework/runtime closure, background polling reader or #9438/#8714 completion claim.' };
fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ fullOwnedGraphLines, excludedLines: 0 }));
