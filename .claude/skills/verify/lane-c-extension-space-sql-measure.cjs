const ts = require(process.cwd() + '/node_modules/typescript');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const store = 'packages/daemon/src/lib/external-events/extension-config-store.ts';
const helper = 'packages/daemon/src/storage/repositories/space-extension-config-persist.ts';
const record = 'packages/daemon/src/lib/record.ts';
const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/dev'], { encoding: 'utf8' }).trim();
const printer = ts.createPrinter({ removeComments: true });
function statementShape(text) {
  const sf = ts.createSourceFile('statement.ts', text, ts.ScriptTarget.Latest, true);
  function shape(node) {
    const children = [];
    ts.forEachChild(node, child => { children.push(shape(child)); });
    return children.length ? [node.kind, children] : [node.kind, node.text ?? node.getText(sf)];
  }
  return JSON.stringify(shape(sf));
}
function inspect(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const units = [], sql = [], stable = [];
  let statement, clock;
  function visit(node) {
    const name = ts.isConstructorDeclaration(node) ? 'constructor' : node.name?.getText(sf);
    if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isConstructorDeclaration(node)) {
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      const end = sf.getLineAndCharacterOfPosition(node.end).line + 1;
      units.push({ file, name, lines: end - start + 1, sha256: hash(node.getText(sf)) });
      if (name !== 'setSpaceConfig') stable.push({ name, sha256: hash(node.getText(sf)) });
      if (['setSpaceConfig', 'persistSpaceExtensionConfig'].includes(name)) {
        for (const child of node.body.statements) {
          if (ts.isExpressionStatement(child) && child.getText(sf).includes('INSERT INTO space_external_event_source_configs')) statement = statementShape(child.getText(sf).replace('this.db', 'db'));
          if (ts.isVariableStatement(child) && child.getText(sf).includes('Date.now')) clock = printer.printNode(ts.EmitHint.Unspecified, child, sf);
        }
      }
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text.includes('INSERT INTO space_external_event_source_configs')) sql.push({ bytes: Buffer.byteLength(node.text), sha256: hash(node.text) });
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return { units, sql, stable, statement, clock };
}
const old = inspect(store, execFileSync('git', ['show', base + ':' + store], { encoding: 'utf8' }));
const now = inspect(store, fs.readFileSync(store, 'utf8'));
const extracted = inspect(helper, fs.readFileSync(helper, 'utf8'));
if (old.statement !== extracted.statement || JSON.stringify(old.sql) !== JSON.stringify(extracted.sql) || old.clock !== now.clock || JSON.stringify(old.stable) !== JSON.stringify(now.stable)) throw Error('SQL bytes, argument/serialization order, wrapper clock or unchanged store methods changed');
const selected = ['constructor', 'getSpaceConfig', 'setSpaceConfig', 'ensureExternalEventExtensionConfigTables', 'spaceRowToConfig', 'parseJsonRecord', 'validateSpaceConfig', 'validateSourceId', 'validateSpaceId', 'listEnabledSpaces'];
const units = [...now.units.filter(u => selected.includes(u.name)), ...inspect(record, fs.readFileSync(record, 'utf8')).units];
const helperLines = fs.readFileSync(helper, 'utf8').trimEnd().split('\n').length;
const fullOwnedStoreGraphLines = units.reduce((n, u) => n + u.lines, helperLines);
const delta = execFileSync('git', ['diff', '--numstat', base, '--', 'packages/daemon/src', 'scripts/deno-smoke.sh'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(line => { const [a, d, file] = line.split('\t'); return { file, lines: Number(a) + Number(d) }; });
for (const d of delta) if (![store, helper, 'scripts/deno-smoke.sh'].includes(d.file)) throw Error('Unexpected production scope: ' + d.file);
const productionLines = delta.filter(d => d.file !== 'scripts/deno-smoke.sh').reduce((n, d) => n + d.lines, 0);
const smokeLines = delta.filter(d => d.file === 'scripts/deno-smoke.sh').reduce((n, d) => n + d.lines, 0);
if (productionLines + smokeLines > 200 || fullOwnedStoreGraphLines > 200 || smokeLines !== 1) throw Error('Extraction budget exceeded');
console.log(JSON.stringify({ base, units, completeHelper: { file: helper, lines: helperLines, sha256: hash(fs.readFileSync(helper, 'utf8')) }, fullOwnedStoreGraphLines, productionLines, smokeLines, delta, sql: extracted.sql, statementAstSha256: hash(extracted.statement), sqlAndSerializationAndBindingsUnchanged: true, wrapperClockUnchanged: true, stableStoreMethods: now.stable, netPrepare: 0, netRun: 0, mainThreadMovementClaim: false, contract: 'persistSpaceExtensionConfig(db,spaceId,source,config,now): exact legacy six-binding UPSERT/JSON order; compound Space/source key, caller clock, validation, transaction ownership and parent cascade retained; created_at survives updates.', auditLimit: 'Only Space store SQL extraction plus local validation/read/table helpers measured. Actual GitHub Space enable/disable/list RPC behavior is characterized with empty watched repos; additional GitHub source-settings/watch-row writes, full plugin/startup/Space dependency closure, constructor DDL, reads and writer activation are outside this extraction. No main-thread movement claimed.' }, null, 2));
