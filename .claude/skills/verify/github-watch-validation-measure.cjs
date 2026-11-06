const fs = require('node:fs');
const cp = require('node:child_process');
const ts = require(process.cwd() + '/node_modules/typescript');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const file = 'packages/daemon/src/lib/external-events/github/github-event-extension.ts';
const base = '24d78fdf4bf4d78c4fd7083c40756186abc2a839';
const text = fs.readFileSync(file, 'utf8');
const before = cp.execFileSync('git', ['show', base + ':' + file], { encoding: 'utf8' });
const added = "import { gitHubWatchedRepoRead } from '../../../storage/repositories/github-watched-repo-read.ts';\n";
const currentLookup = `const existingForValidation = await gatewayFor(this.db).run(gitHubWatchedRepoRead, {
        spaceId: params.spaceId,
        owner: params.owner,
        repo: params.repo,
      });`;
const previousLookup = `const existingForValidation = this.repo.getWatchedRepo(
        params.spaceId,
        params.owner,
        params.repo
      );`;
if (!text.includes(currentLookup) || text.replace(added, '').replace(currentLookup, previousLookup) !== before)
  throw Error('Extension changed beyond the validation reader bridge');
const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
const lines = node => source.getLineAndCharacterOfPosition(node.end).line - source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
let caller, admission;
function walk(node) {
  if (ts.isCallExpression(node) && node.expression.getText(source).endsWith('.onRequest') && node.arguments[0]?.text === 'space.github.watchRepo')
    caller = { file, name: 'space.github.watchRepo', lines: lines(node.arguments[1]), sha256: hash(node.arguments[1].getText(source)) };
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'assertRpcConfigEnabled')
    admission = { file, name: node.name.text, lines: lines(node), sha256: hash(node.getText(source)) };
  ts.forEachChild(node, walk);
}
walk(source);
if (!caller || !admission) throw Error('Missing complete caller or admission gate');
const modules = ['github-watched-repo-read.ts', 'github-watched-repo-lookups.ts', 'github-watched-repos-read.ts'].map(name => {
  const file = 'packages/daemon/src/storage/repositories/' + name;
  const text = fs.readFileSync(file, 'utf8');
  return { file, lines: text.trimEnd().split('\n').length, sha256: hash(text), counted: true };
});
const importsAndRegistrations = 3;
const productionGraphLines = caller.lines + admission.lines + modules.reduce((n, row) => n + row.lines, importsAndRegistrations);
if (productionGraphLines >= 200) throw Error('Validation reader owned graph must stay below 200 lines');
const report = { base, caller, admission, modules, importsAndRegistrations, productionGraphLines, excludedLines: 0,
  contract: 'One awaited query-only lookup before the existing interval gate; complete caller, admission gate, command, lookup and mapper modules included. Existing case/null/parse semantics and error propagation retained.',
  limits: 'Framework transport, unrelated existing webhook/polling effects and startup are not re-audited by this slice. Their main SQL remains for subsequent rungs; no whole-runtime closure or final guard claim.' };
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
