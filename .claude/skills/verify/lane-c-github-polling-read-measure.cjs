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
  ['countSpacesWithPollingIntent', 'countGitHubSpacesWithPollingIntent', 'bd97191ac0706b63a10525de02fecd6aae367e4b24e6457c64ee01df4b1b9016', false],
  ['listPollingRepos', 'listGitHubPollingRepos', '3b410d5c508a4f9615be4c10928e5471f785795bc0beb8b2c8893bd78c8c9bfc', true],
  ['listAllPollingConfiguredRepos', 'listGitHubPollingConfiguredRepos', '398040635a0c60d1fd726ecde0d286347edf18f6bcdeafd6dbb4afb95e8cb5ab', true],
];
const methods = units(repo), helpers = units(helper), names = contracts.map(row => row[0]);
const untouched = methods.filter(row => !names.includes(row.name)).map(row => [row.name, row.sha256]);
if (hash(JSON.stringify(untouched)) !== '83b9ad2c2d1b99940130b06a636722cd47d28c54c8e026dfe0ed2e1b10057a56') throw Error('Other repository method or constructor changed');
if (hash(read(mapper)) !== '4c5945ea131459249bb302cdb27ee6a014fc6aadd5d15f9d402b3226972e6a95') throw Error('Complete mapper module changed');
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
