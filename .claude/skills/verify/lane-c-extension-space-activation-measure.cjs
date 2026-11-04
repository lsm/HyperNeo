const ts = require(process.cwd() + '/node_modules/typescript');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/dev'], { encoding: 'utf8' }).trim();
const store = 'packages/daemon/src/lib/external-events/extension-config-store.ts';
const command = 'packages/daemon/src/storage/repositories/space-extension-config-write.ts';
const helper = 'packages/daemon/src/storage/repositories/space-extension-config-persist.ts';
const smoke = 'scripts/deno-smoke.sh';
const read = file => fs.readFileSync(file, 'utf8');
const previous = file => execFileSync('git', ['show', base + ':' + file], { encoding: 'utf8' });
function units(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), result = [];
  function visit(node) {
    if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isConstructorDeclaration(node)) {
      const name = ts.isConstructorDeclaration(node) ? 'constructor' : node.name?.getText(sf);
      result.push({ file, name, lines: sf.getLineAndCharacterOfPosition(node.end).line - sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, sha256: hash(node.getText(sf)), body: node.body?.statements.map(s => s.getText(sf)) });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return result;
}
const old = units(store, previous(store)), current = units(store, read(store));
const oldSetter = old.find(u => u.name === 'setSpaceConfig'), setter = current.find(u => u.name === 'setSpaceConfig');
const call = setter.body[4];
if (JSON.stringify(oldSetter.body.slice(0, 4)) !== JSON.stringify(setter.body.slice(0, 4)) || setter.body.length !== 5 || call.replace(/\s+/g, '') !== "awaitgatewayFor(this.db).call(spaceExtensionConfigWrites,'persist',spaceId,source,config,now);") throw Error('Space setter exceeds validation/clock-preserving call swap');
const normalized = read(store).replace("import { spaceExtensionConfigWrites } from '../../storage/repositories/space-extension-config-write.ts';", "import { persistSpaceExtensionConfig } from '../../storage/repositories/space-extension-config-persist.ts';").replace(call, 'persistSpaceExtensionConfig(this.db, spaceId, source, config, now);');
if (normalized !== previous(store)) throw Error('Other store bytes changed');
const stableFiles = [command, helper, 'packages/daemon/src/lib/record.ts', 'packages/daemon/src/lib/external-events/extension-manager.ts', 'packages/daemon/src/lib/rpc-handlers/index.ts', 'packages/daemon/src/lib/external-events/github/github-event-extension.ts', 'packages/daemon/src/app.ts', 'packages/daemon/src/storage/db-gateway/db-op.ts', 'packages/daemon/src/storage/db-gateway/db-gateway.ts', 'packages/daemon/src/storage/db-gateway/db-gateway-worker.ts', 'packages/daemon/src/storage/db-gateway/db-ops.ts'];
const stableDependencies = stableFiles.map(file => { const text = read(file); if (text !== previous(file)) throw Error('Pinned dependency changed: ' + file); return { file, lines: text.trimEnd().split('\n').length, sha256: hash(text), pinnedNotTransitiveAudited: true }; });
if (stableDependencies[0].sha256 !== 'ccd58099379de43213799351e40395c2ca3936b174888a635786d4884e64252a' || stableDependencies[1].sha256 !== '3eb49614501626f43b0d679f09a7cfea5ae6d9592070e907adf1c283ed87758f') throw Error('Merged command/helper identity changed');
const selected = ['constructor', 'getSpaceConfig', 'listEnabledSpaces', 'setSpaceConfig', 'ensureExternalEventExtensionConfigTables', 'spaceRowToConfig', 'parseJsonRecord', 'validateSpaceConfig', 'validateSourceId', 'validateSpaceId'];
const ownedUnits = current.filter(u => selected.includes(u.name)).concat(units(stableFiles[2], read(stableFiles[2]))).map(({ body, ...unit }) => unit);
const fullOwnedSpaceStoreCommandHelperLines = ownedUnits.reduce((n, u) => n + u.lines, stableDependencies[0].lines + stableDependencies[1].lines);
const smokeLines = read(smoke).split('\n').filter(line => line.includes('lane-c-extension-space-activation.ts'));
if (smokeLines.length !== 1 || read(smoke).replace(smokeLines[0] + '\n', '') !== previous(smoke)) throw Error('Smoke exceeds one append-only registration');
const delta = execFileSync('git', ['diff', '--numstat', base, '--', 'packages/daemon/src', smoke], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(line => { const [a, d, file] = line.split('\t'); return { file, lines: Number(a) + Number(d) }; });
for (const d of delta) if (![store, smoke].includes(d.file)) throw Error('Activation exceeds owned scope: ' + d.file);
const changedProductionAndRegistrations = delta.reduce((n, d) => n + d.lines, 0), importLines = 1, smokeRegistrationLines = 1;
if (fullOwnedSpaceStoreCommandHelperLines + importLines + smokeRegistrationLines > 200 || changedProductionAndRegistrations > 200) throw Error('Activation cap exceeded');
console.log(JSON.stringify({ base, ownedUnits, fullOwnedSpaceStoreCommandHelperLines, importLines, smokeRegistrationLines, fullOwnedWithRegistrations: fullOwnedSpaceStoreCommandHelperLines + importLines + smokeRegistrationLines, excludedDataLines: 0, changedProductionAndRegistrations, delta, stableDependencies, validationAndCallerClockUnchanged: true, nonSpaceStoreBytesUnchanged: true, commandContract: 'extension.space.config.write/persist(spaceId,source,config,now): validated data only, exact six-binding SQL/JSON/created_at/FK semantics, caller clock; void acknowledgement after existing immediate transaction commits, no replay.', publicContract: 'The existing unwatch RPC awaits the config commit before notification/reply. Its preceding watched-row removal remains a separate committed mutation even if config admission or receipt fails; no new atomicity, compensation or lifecycle-recovery claim.', auditLimit: 'Owned Space-store runtime units including constructor/DDL/read/mapping/validators plus record helpers and full command/SQL helper counted; no data exclusion. Existing public RPC/caller/app/framework roots are unchanged full-file identity pins, not a full public/plugin/runtime transitive audit. Unbound inline test gateway, constructor DDL, reads and upstream GitHub mutations remain outside off-main activation. Deliberately held writer RPC exceeds 250ms; no final #8714 or GUI/live deployment claim.', netPrepare: 0, netRun: 0, baselineIncrease: false }, null, 2));
