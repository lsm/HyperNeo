const fs = require('node:fs');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const ts = require(process.cwd() + '/node_modules/typescript');
const hash = text => createHash('sha256').update(text).digest('hex');
const repo = 'packages/daemon/src/lib/external-events/github/github-repository.ts';
const helper = 'packages/daemon/src/storage/repositories/github-polling-repos-read.ts';
const mapper = 'packages/daemon/src/storage/repositories/github-watched-repos-read.ts';
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
const read = file => fs.readFileSync(file, 'utf8');
const count = text => text.trimEnd().split('\n').length;
const lineCount = (sf, n) => sf.getLineAndCharacterOfPosition(n.end).line - sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
function shape(text) {
  const sf = parse('body.ts', text);
  function visit(node) {
    const children = [];
    ts.forEachChild(node, child => { children.push(visit(child)); });
    return children.length ? [node.kind, children] : [node.kind, node.text ?? node.getText(sf)];
  }
  return JSON.stringify(visit(sf));
}
function units(file) {
  const sf = parse(file, read(file)), found = [];
  function walk(n) {
    if (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isConstructorDeclaration(n)) {
      found.push({ name: ts.isConstructorDeclaration(n) ? 'constructor' : n.name.getText(sf), lines: lineCount(sf, n), sha256: hash(n.getText(sf)), body: n.body.getText(sf) });
    }
    ts.forEachChild(n, walk);
  }
  walk(sf);
  return found;
}
const contracts = [
  ['countSpacesWithPollingIntent', 'countGitHubSpacesWithPollingIntent', 'f101cc0cdbd1465b68796b9fef4d627a3015a15a124f38ebbc40c4916115b2fa', false],
  ['listPollingRepos', 'listGitHubPollingRepos', '9912d576ac968369717d599699d5e36aea7e61046a9ab5126170554ccb90e5d1', true],
  ['listAllPollingConfiguredRepos', 'listGitHubPollingConfiguredRepos', 'd11efe71dedd859e2d1a688a157b46514067efa66a13fd2e77cab03cd6501b05', true],
];
const methods = units(repo), helpers = units(helper), names = contracts.map(row => row[0]);
if (methods.some(row => ['clearWebhookRegistration', 'clearWebhookDeliveryHistory'].includes(row.name))) throw Error('Retired watched webhook wrappers remain');
const untouched = methods.filter(row => !names.includes(row.name)).map(row => [row.name, row.sha256]);
if (hash(JSON.stringify(untouched)) !== '3472d55a44b83d5711e6cf19d5c4c5d1586d2a240393fdbfd76626f2938247b5') throw Error('Other repository method or constructor changed');
if (hash(read(mapper)) !== 'f41326de1acc9416d313230f3144405d21638e8c6d846149431558a26f883165') throw Error('Complete mapper module changed');
for (const [name, fn, expected, scoped] of contracts) {
  const extracted = helpers.find(row => row.name === fn), wrapper = methods.find(row => row.name === name);
  if (!extracted || hash(shape(extracted.body)) !== expected) throw Error('SQL/map/parse/result body changed: ' + fn);
  if (shape(wrapper.body) !== shape(`{ return ${fn}(this.db${scoped ? ', spaceId' : ''}); }`)) throw Error('Wrapper exceeds exact delegation: ' + name);
}
const selected = methods.filter(row => [...names, 'constructor', 'rowToRepo'].includes(row.name)).map(({ body, ...row }) => row);
const completeHelper = { file: helper, lines: count(read(helper)), sha256: hash(read(helper)) };
const completeMapper = { file: mapper, lines: count(read(mapper)), sha256: hash(read(mapper)) };
const fullOwnedGraphLines = selected.reduce((n, row) => n + row.lines, 0) + completeHelper.lines + completeMapper.lines;
if (fullOwnedGraphLines > 200) throw Error('Extraction graph exceeds 200 lines');
const report = {
  head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  originalQueryBase: '523249e73922f781d3cbd79caf697df31a4ebe6f',
  selected, completeHelper, completeMapper, fullOwnedGraphLines,
  excludedLines: 0, netPrepare: 0, netRun: 0,
  helperBodyAstHashes: Object.fromEntries(contracts.map(row => [row[1], row[2]])),
  contract: 'Exact original SELECT text/args/order/map/errors; constructor-free and query-only; legacy wrappers delegate once. No worker activation or policy change.',
  auditLimit: 'Complete helper and mapper, legacy wrappers and unchanged constructor/mapper wrapper counted. Other repository methods pinned unchanged; full public/runtime/transitive closure not claimed. Existing callback reads still block #9438/#8714.',
};
fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ fullOwnedGraphLines, completeHelper: completeHelper.lines, completeMapper: completeMapper.lines, excludedLines: 0 }));
