const fs = require('node:fs');
const cp = require('node:child_process');
const ts = require(process.cwd() + '/node_modules/typescript');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const base = 'cef03ccace652a2701e9f1e65112f17395f88460';
const extension = 'packages/daemon/src/lib/external-events/github/github-event-extension.ts';
const writer = 'packages/daemon/src/storage/repositories/github-watch-polling-write.ts';
const registry = 'packages/daemon/src/storage/db-gateway/db-ops.ts';
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
if (hash((source.slice(0, sliceStart) + source.slice(sliceEnd)).replace(pollingImport, '')) !== 'b25f0ed333c8e4074000418e07a4fdb4be8f45c82b9987e7545ce057201615f0') throw Error('Extension changed outside the watch callback');
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
const diff = cp.execFileSync('git', ['diff', '--numstat', base, '--', 'packages/daemon/src'], { encoding: 'utf8' });
const changes = diff.trim().split('\n').filter(Boolean).map(line => {
  const [added, removed, file] = line.split('\t');
  return { file, added: Number(added), removed: Number(removed) };
});
if (!changes.some(row => row.file === writer)) changes.push({ file: writer, added: writerText.trimEnd().split('\n').length, removed: 0 });
if (changes.some(row => ![extension, writer, shared, registry].includes(row.file))) throw Error('Unexpected production scope');
const report = { base, roots, importAndRegistrationLines, ownedRootLines, changedProductionLines: changes.reduce((n, row) => n + row.added + row.removed, 0), changes, sharedModuleSha256: hash(sharedText),
  contract: 'Whole watch callback and admission gate, complete polling writer module, complete shared snapshot helper and registration/import lines are counted. The intent command returns snapshot data after its commit. The caller awaits its injected config store, preserving the preceding watched commit on a later failure. Shared module is verified export-only against its prior full-file hash.',
  limits: 'Named control roots measured independently of the diff. Reused SQL/mapper/projection leaves keep their interface proofs. Full transitive runtime closure, other RPCs, remote-webhook effects and startup remain outside this scope.' };
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
