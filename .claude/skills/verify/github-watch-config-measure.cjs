const fs = require('node:fs');
const cp = require('node:child_process');
const ts = require(process.cwd() + '/node_modules/typescript');
const { createHash } = require('node:crypto');
const base = '995db89299b4f586ecf74714c7eeee5a5baf4c2b';
const allowed = [
  'packages/daemon/src/lib/external-events/github/github-event-extension.ts',
  'packages/daemon/src/lib/external-events/github/github-repository.ts',
  'packages/daemon/src/storage/db-gateway/db-ops.ts',
  'packages/daemon/src/storage/repositories/github-watched-config-write.ts',
  'packages/daemon/src/storage/repositories/github-webhook-clear-persist.ts',
];
const roots = allowed.map(file => {
  const text = fs.readFileSync(file, 'utf8');
  return { file, fullModuleLines: text.trimEnd().split('\n').length,
    sha256: createHash('sha256').update(text).digest('hex') };
});
const tracked = cp.execFileSync('git', ['diff', '--numstat', base, '--', 'packages/daemon/src'], { encoding: 'utf8' });
const rows = tracked.trim().split('\n').filter(Boolean).map(line => {
  const [added, removed, file] = line.split('\t');
  return { file, added: Number(added), removed: Number(removed) };
});
for (const file of allowed) {
  if (!rows.some(row => row.file === file)) {
    try { cp.execFileSync('git', ['cat-file', '-e', base + ':' + file], { stdio: 'ignore' }); }
    catch { rows.push({ file, added: fs.readFileSync(file, 'utf8').trimEnd().split('\n').length, removed: 0 }); }
  }
}
if (rows.some(row => !allowed.includes(row.file))) throw Error('Unexpected production scope');
const changedProductionLines = rows.reduce((n, row) => n + row.added + row.removed, 0);
if (changedProductionLines >= 200) throw Error('Watch config production diff exceeds its budget');
const source = ts.createSourceFile(allowed[0], fs.readFileSync(allowed[0], 'utf8'), ts.ScriptTarget.Latest, true);
let callbackLines, admissionLines;
function walk(node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'assertRpcConfigEnabled')
    admissionLines = source.getLineAndCharacterOfPosition(node.end).line - source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  if (ts.isCallExpression(node) && node.expression.getText(source).endsWith('.onRequest') && node.arguments[0]?.text === 'space.github.watchRepo') {
    const callback = node.arguments[1];
    callbackLines = source.getLineAndCharacterOfPosition(callback.end).line - source.getLineAndCharacterOfPosition(callback.getStart(source)).line + 1;
  }
  ts.forEachChild(node, walk);
}
walk(source);
if (!callbackLines || !admissionLines) throw Error('Missing complete caller or admission gate');
const repository = ts.createSourceFile(allowed[1], fs.readFileSync(allowed[1], 'utf8'), ts.ScriptTarget.Latest, true);
let wrapperLines = 0;
function wrappers(node) {
  if (ts.isMethodDeclaration(node) && ['clearWebhookRegistration', 'clearWebhookDeliveryHistory'].includes(node.name.getText(repository)))
    wrapperLines += repository.getLineAndCharacterOfPosition(node.end).line - repository.getLineAndCharacterOfPosition(node.getStart(repository)).line + 1;
  ts.forEachChild(node, wrappers);
}
wrappers(repository);
const readerLines = fs.readFileSync('packages/daemon/src/storage/repositories/github-watched-repo-read.ts', 'utf8').trimEnd().split('\n').length;
const importAndRegistrationLines = 7;
const ownedRootLines = callbackLines + admissionLines + wrapperLines + readerLines + importAndRegistrationLines + roots.slice(3).reduce((n, row) => n + row.fullModuleLines, 0);
if (ownedRootLines >= 200) throw Error('Complete owned watch config roots exceed their budget');
const report = { base, rows, changedProductionLines, callbackLines, admissionLines, wrapperLines, readerLines, importAndRegistrationLines, ownedRootLines, roots,
  contract: 'The whole watch callback and admission gate, both complete new command/clear modules, the complete reader bridge and legacy clear wrappers are counted. Gateway owns the transaction. UUID/time/default/cursor behavior stays in the reused upsert helper.',
  limits: 'Complete owned roots and diff reported separately. Reused upsert/query/mapper, gateway, webhook HTTP and timer libraries are exercised through existing interfaces; no full transitive-runtime audit or audited-dependency exclusion grant is claimed. Polling intent and snapshot SQL remain for the next rung.' };
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
