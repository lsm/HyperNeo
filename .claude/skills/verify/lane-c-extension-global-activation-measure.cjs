const ts = require(process.cwd() + '/node_modules/typescript');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/dev'], { encoding: 'utf8' }).trim();
const store = 'packages/daemon/src/lib/external-events/extension-config-store.ts';
const command = 'packages/daemon/src/storage/repositories/global-extension-config-write.ts';
const helper = 'packages/daemon/src/storage/repositories/global-extension-config-persist.ts';
const smoke = 'scripts/deno-smoke.sh';
const read = file => fs.readFileSync(file, 'utf8');
const previous = file => execFileSync('git', ['show', base + ':' + file], { encoding: 'utf8' });
function units(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), result = [];
  function visit(node) {
    if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isConstructorDeclaration(node)) {
      const name = ts.isConstructorDeclaration(node) ? 'constructor' : node.name?.getText(sf);
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
      const end = sf.getLineAndCharacterOfPosition(node.end).line;
      result.push({ file, name, lines: end - start + 1, sha256: hash(node.getText(sf)), body: node.body?.statements.map(s => s.getText(sf)) });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return result;
}
const old = units(store, previous(store)), current = units(store, read(store));
const oldSetter = old.find(u => u.name === 'setGlobalConfig'), setter = current.find(u => u.name === 'setGlobalConfig');
if (JSON.stringify(oldSetter.body.slice(0, 3)) !== JSON.stringify(setter.body.slice(0, 3)) || setter.body.length !== 4 || setter.body[3] !== "await gatewayFor(this.db).call(globalExtensionConfigWrites, 'persist', source, config, now);") throw Error('Global setter exceeds the authorized validation/clock-preserving call swap');
const withoutSetter = values => values.filter(u => u.name !== 'setGlobalConfig').map(({ body, ...unit }) => unit);
if (JSON.stringify(withoutSetter(old)) !== JSON.stringify(withoutSetter(current))) throw Error('Non-global store units changed');
const stableFiles = [command, helper, 'packages/daemon/src/lib/record.ts', 'packages/daemon/src/lib/external-events/extension-manager.ts', 'packages/daemon/src/lib/rpc-handlers/index.ts', 'packages/daemon/src/lib/external-events/github/github-event-extension.ts', 'packages/daemon/src/app.ts', 'packages/daemon/src/storage/db-gateway/db-op.ts', 'packages/daemon/src/storage/db-gateway/db-gateway.ts', 'packages/daemon/src/storage/db-gateway/db-gateway-worker.ts', 'packages/daemon/src/storage/db-gateway/db-ops.ts'];
const stableDependencies = stableFiles.map(file => { const text = read(file); if (text !== previous(file)) throw Error('Pinned dependency changed: ' + file); return { file, lines: text.trimEnd().split('\n').length, sha256: hash(text) }; });
if (stableDependencies[0].sha256 !== 'f095ddc13e7e99adc68f692dc3999aa3b97252e475c3c3a77ab985dacc197224' || stableDependencies[1].sha256 !== '3d500772c14766ce7c20f0e5bf1143c0bf500e756dd65078fc9312fe621705f1') throw Error('Merged command/helper identity changed');
const selected = ['constructor', 'getGlobalConfig', 'setGlobalConfig', 'ensureExternalEventExtensionConfigTables', 'globalRowToConfig', 'parseJsonRecord', 'validateGlobalConfig', 'validateSourceId'];
const ownedUnits = current.filter(u => selected.includes(u.name)).concat(units(stableFiles[2], read(stableFiles[2]))).map(({ body, ...unit }) => unit);
const fullOwnedGlobalStoreCommandHelperLines = ownedUnits.reduce((n, u) => n + u.lines, stableDependencies[0].lines + stableDependencies[1].lines);
const smokeLines = read(smoke).split('\n').filter(line => line.includes('lane-c-extension-global-activation.ts'));
if (smokeLines.length !== 1 || read(smoke).replace(smokeLines[0] + '\n', '') !== previous(smoke)) throw Error('Smoke exceeds one append-only registration');
const delta = execFileSync('git', ['diff', '--numstat', base, '--', 'packages/daemon/src', smoke], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(line => { const [a, d, file] = line.split('\t'); return { file, lines: Number(a) + Number(d) }; });
for (const d of delta) if (![store, smoke].includes(d.file)) throw Error('Activation exceeds owned scope: ' + d.file);
const changedProductionAndRegistrations = delta.reduce((n, d) => n + d.lines, 0);
if (fullOwnedGlobalStoreCommandHelperLines > 200 || changedProductionAndRegistrations > 200) throw Error('Activation cap exceeded');
console.log(JSON.stringify({ base, ownedUnits, fullOwnedGlobalStoreCommandHelperLines, changedProductionAndRegistrations, delta, stableDependencies, validationAndCallerClockUnchanged: true, nonGlobalStoreUnitsUnchanged: true, commandContract: 'extension.global.config.write/persist(source,config,now): validated data only, exact seven-binding SQL/JSON/created_at semantics, caller timestamp; ack after immediate transaction commit; no replay.', publicContract: 'Initial enabled admission is outside lifecycle catch: rejection or unknown receipt propagates without start or compensation. Start failure after known committed admission retains existing previous-config compensation. Concurrent enables share the manager start. No callbacks cross the worker boundary.', auditLimit: 'Complete owned global store helper/command graph counted. Unchanged manager, public RPC, GitHub capability and app roots are exact-file-hash pins, not a full dynamic plugin/transitive framework/startup audit. Mixed enable/disable race repair, unknown-outcome lifecycle reconciliation, reads, Space setter, constructor DDL, unbound inline gateway fallback and final global guard remain outside this activation.', netPrepare: 0, netRun: 0, baselineIncrease: false }, null, 2));
