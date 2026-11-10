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
    if (name === 'space.github.watchRepo') {
      const body = callback.getText(sf);
      if (!body.includes('await this.stopIdlePollingOnReader();')) throw Error('Watch caller does not await timer ownership');
      const before = body.replace('await this.stopIdlePollingOnReader();', 'this.maybeStopPolling();');
      if (hash(before) !== '5dd5a3ede0594bc8e0fec2e6350020bcfc846568dbbcadcd55045e12e2366dbe') throw Error('Watch caller changed beyond reviewed watch bridges');
      caller = { file, name, lines: lines(callback), sha256: hash(body), reviewedWatchBridgesOnly: true };
    } else otherRpcs.push([name, hash(callback.getText(sf))]);
  }
  ts.forEachChild(node, walk);
}
walk(sf);
if (!caller || selected.length !== selectedNames.length) throw Error('Missing owned timer roots');
if (hash(JSON.stringify(unchanged)) !== '3d36aa2e60b741fcb96f0b445ddcd7323ceee770c34b952c5b65c613370e2cd6') throw Error('Other extension method or field changed');
if (hash(JSON.stringify(otherRpcs)) !== 'a633c811f27a703debf71e8522d132eff7035773afe51cd62e2c48dd9accb806') throw Error('Other public RPC caller changed');
const specs = [
  ['github-polling-usage-read.ts', 47, '84752c5c336df50f98a7941c53eb93c343ac0ff443e7c669fc52566a33145289'],
  ['github-polling-repos-read.ts', 56, '39618e09a7cd70b7325cf31b205eb221f338ebe58ff6ea50bebef49a22b28d06'],
  ['github-watched-repos-read.ts', 44, '4c5945ea131459249bb302cdb27ee6a014fc6aadd5d15f9d402b3226972e6a95'],
];
const data = specs.map(([name, expectedLines, expected]) => {
  const path = 'packages/daemon/src/storage/repositories/' + name, body = fs.readFileSync(path, 'utf8');
  const actualLines = body.trimEnd().split('\n').length;
  if (actualLines !== expectedLines || hash(body) !== expected) throw Error('Counted data module drift: ' + name);
  return { file: path, lines: actualLines, sha256: expected, counted: name === 'github-polling-usage-read.ts', auditedStable: name !== 'github-polling-usage-read.ts' };
});
const importLines = 1, smokeLines = 0;
const knownTotal = selected.concat(data, [caller]).reduce((n, row) => n + row.lines, importLines + smokeLines);
const excludedLines = data.filter(row => row.auditedStable).reduce((n, row) => n + row.lines, 0);
const fresh = knownTotal - excludedLines;
if (fresh > 200) throw Error('Public watch timer slice exceeds 200 lines');
const report = { head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), selected, caller, data, importLines, smokeLines, fresh, excludedLines, knownTotal, contract: 'One public timer call site awaits the registered reader in the existing effect queue; captured handle prevents clearing another lifetime. No timer/provider skips admission, errors propagate after known writes, no fallback/replay.', auditLimit: 'Sibling #9657 refreshes only the retired six-line helper deletion pin, with selected roots and data exclusions unchanged. Complete selected watch caller/auth, timer owner and reader/query/mapper counted. Neo approved only the two unchanged constructor-free query/mapper modules (97 lines) outside the fresh 167-line envelope, 264 known total. The reviewed watch config slice moves key reads and atomic mutations to the gateway. Remaining polling-intent/snapshot effects are not re-audited by this timer measurement. The retired legacy helper is deleted under #9657. Existing writer/capability subtrees retain separate audits; no full public/framework/runtime closure, background polling reader or #9438/#8714 completion claim.' };
fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ fresh, excludedLines, knownTotal }));
