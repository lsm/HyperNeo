const fs = require('node:fs');
const ts = require(process.cwd() + '/node_modules/typescript');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const base = 'cef03ccace652a2701e9f1e65112f17395f88460';
const extension = 'packages/daemon/src/lib/external-events/github/github-event-extension.ts';
const writer = 'packages/daemon/src/storage/repositories/github-watch-polling-write.ts';
const shared = 'packages/daemon/src/storage/repositories/github-polling-enabled-write.ts';
const source = fs.readFileSync(extension, 'utf8');
const pollingImport = "import { gitHubWatchPollingWrite } from '../../../storage/repositories/github-watch-polling-write.ts';\n";
const ast = ts.createSourceFile(extension, source, ts.ScriptTarget.Latest, true);
const lines = (file, node) => file.getLineAndCharacterOfPosition(node.end).line - file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
let callback, admission;
function walk(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast).endsWith('.onRequest') && node.arguments[0]?.text === 'space.github.watchRepo') callback = node.arguments[1];
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'assertRpcConfigEnabled') admission = node;
  ts.forEachChild(node, walk);
}
walk(ast);
if (!callback || !admission) throw Error('Missing complete caller or admission gate');
const sliceStart = source.indexOf("    hub.onRequest('space.github.watchRepo'");
const sliceEnd = source.indexOf("    hub.onRequest('space.github.autoConfigureWebhook'", sliceStart);
if (hash((source.slice(0, sliceStart) + source.slice(sliceEnd)).replace(pollingImport, '')) !== '415173c8ab611a826f2201a59e4bbed59d811c5ddef6cf50e3698b9ee31a906e') throw Error('Extension changed outside the watch callback');
const sharedText = fs.readFileSync(shared, 'utf8');
if (hash(sharedText.replace('export function readPollingSnapshot(', 'function readPollingSnapshot(')) !== '63c68646034af002fbd1e155e41e6092b61b840f5f59195c616829eb5a39869c') throw Error('Shared polling command changed beyond the snapshot export');
const sharedAst = ts.createSourceFile(shared, sharedText, ts.ScriptTarget.Latest, true);
const helpers = sharedAst.statements.filter(node => ts.isFunctionDeclaration(node) && ['readPollingSnapshot'].includes(node.name?.text));
if (helpers.length !== 1) throw Error('Missing complete shared helper roots');
const writerText = fs.readFileSync(writer, 'utf8');
const roots = [
  { file: extension, name: 'space.github.watchRepo', lines: lines(ast, callback), sha256: hash(callback.getText(ast)) },
  { file: extension, name: 'assertRpcConfigEnabled', lines: lines(ast, admission), sha256: hash(admission.getText(ast)) },
  { file: writer, name: 'complete polling writer module', lines: writerText.trimEnd().split('\n').length, sha256: hash(writerText) },
  ...helpers.map(node => ({ file: shared, name: node.name.text, lines: lines(sharedAst, node), sha256: hash(node.getText(sharedAst)) })),
];
const importAndRegistrationLines = 3;
const ownedRootLines = roots.reduce((n, row) => n + row.lines, importAndRegistrationLines);
if (ownedRootLines >= 200) throw Error('Complete owned watch control roots exceed their budget');
const report = { base, roots, importAndRegistrationLines, ownedRootLines, sharedModuleSha256: hash(sharedText),
  contract: 'Whole watch callback and admission gate, complete polling writer module, complete shared snapshot helper and registration/import lines are counted. The intent command returns snapshot data after its commit. The caller awaits its injected config store, preserving the preceding watched commit on a later failure. Shared module is verified export-only against its prior full-file hash.',
  limits: 'Named control roots measured independently of the PR diff. Measure each rung production diff separately against its fresh dev base. The repository measurement pins every remaining method after the wrapper deletion. Reused SQL/mapper/projection leaves keep their interface proofs. Full transitive runtime closure, other RPCs, remote-webhook effects and startup remain outside this scope.' };
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
