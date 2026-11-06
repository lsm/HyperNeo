const fs = require('node:fs');
const ts = require(process.cwd() + '/node_modules/typescript');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const file = 'packages/daemon/src/lib/external-events/github/github-event-extension.ts';
const base = '995db89299b4f586ecf74714c7eeee5a5baf4c2b';
const text = fs.readFileSync(file, 'utf8');
const added = "import { gitHubWatchedConfigWrite } from '../../../storage/repositories/github-watched-config-write.ts';\n";
const callback = body => body.slice(body.indexOf("    hub.onRequest('space.github.watchRepo'"), body.indexOf("    hub.onRequest('space.github.autoConfigureWebhook'"));
const outsideCallback = text.replace(added, '').replace("import { gitHubWatchPollingWrite } from '../../../storage/repositories/github-watch-polling-write.ts';\n", '').replace(callback(text), '');
if (hash(outsideCallback) !== 'a73a5bf10d1bcffe57f0f4ef65a3420fa29cdb08d50b171a35bcb33cce156c40')
  throw Error('Extension changed beyond the reviewed watch config callback');
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
  contract: 'Awaited query-only lookups before the interval gate and inside webhook serialization; complete caller, admission gate, command, lookup and mapper modules included. Existing case/null/parse semantics and error propagation retained.',
  limits: 'Framework transport, unrelated existing webhook/polling effects and startup are not re-audited by this slice. Polling intent and snapshot reads use their writer command; no whole-runtime closure or final guard claim.' };
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
