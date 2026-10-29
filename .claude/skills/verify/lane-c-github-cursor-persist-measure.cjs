const ts = require(process.cwd() + '/node_modules/typescript');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const repo = 'packages/daemon/src/lib/external-events/github/github-repository.ts';
const helper = 'packages/daemon/src/storage/repositories/github-cursor-persist.ts';
const smoke = 'scripts/deno-smoke.sh';
const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/dev'], { encoding: 'utf8' }).trim();
const previous = file => execFileSync('git', ['show', base + ':' + file], { encoding: 'utf8' });
const read = file => fs.readFileSync(file, 'utf8');
function shape(text) {
  const sf = ts.createSourceFile('statement.ts', text, ts.ScriptTarget.Latest, true);
  function visit(node) { const children = []; ts.forEachChild(node, child => { children.push(visit(child)); }); return children.length ? [node.kind, children] : [node.kind, node.text ?? node.getText(sf)]; }
  return JSON.stringify(visit(sf));
}
function inspect(file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true), units = [];
  function visit(node) {
    if (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isConstructorDeclaration(node)) {
      const name = ts.isConstructorDeclaration(node) ? 'constructor' : node.name?.getText(sf);
      const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line, end = sf.getLineAndCharacterOfPosition(node.end).line;
      units.push({ file, name, lines: end - start + 1, sha256: hash(node.getText(sf)), body: node.body?.statements.map(s => s.getText(sf)) });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return units;
}
const old = inspect(repo, previous(repo)), current = inspect(repo, read(repo)), extracted = inspect(helper, read(helper));
const oldMethod = old.find(u => u.name === 'updatePollCursorJson'), newMethod = current.find(u => u.name === 'updatePollCursorJson'), helperMethod = extracted.find(u => u.name === 'persistGitHubPollCursorJson');
const oldStatements = oldMethod.body.map(s => shape(s.replaceAll('this.db', 'db'))), newStatements = helperMethod.body.map(shape);
if (JSON.stringify(oldStatements) !== JSON.stringify(newStatements) || newMethod.body.length !== 1 || shape(newMethod.body[0]) !== shape('persistGitHubPollCursorJson(this.db, id, cursor);')) throw Error('SQL, serialization/clock/binding order or void result changed');
const stable = units => units.filter(u => u.name !== 'updatePollCursorJson').map(({ body, ...u }) => u);
if (JSON.stringify(stable(old)) !== JSON.stringify(stable(current))) throw Error('Other repository units or constructor/backfill changed');
const selected = ['constructor', 'updatePollCursorJson'];
const ownedUnits = current.filter(u => selected.includes(u.name)).map(({ body, ...u }) => u);
const helperLines = read(helper).trimEnd().split('\n').length;
const stableReadModules = [];
const stablePublicModules=['packages/daemon/src/lib/external-events/github/github-event-extension.ts','packages/daemon/src/lib/external-events/extension-config-store.ts','packages/daemon/src/app.ts'].map(file=>{if(read(file)!==previous(file))throw Error('Public/shared module changed');return{file,sha256:hash(read(file))};});
const fullOwnedGraphLines = ownedUnits.reduce((n, u) => n + u.lines, helperLines) + stableReadModules.reduce((n,u)=>n+u.lines,0);
const delta = execFileSync('git', ['diff', '--numstat', base, '--', 'packages/daemon/src', smoke], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(line => { const [a, d, file] = line.split('\t'); return { file, lines: Number(a) + Number(d) }; });
for (const d of delta) if (![repo, helper, smoke].includes(d.file)) throw Error('Unexpected extraction scope: ' + d.file);
const smokeLines = read(smoke).split('\n').filter(line => line.includes('lane-c-github-cursor-persist-extract.ts'));
if (smokeLines.length !== 1 || read(smoke).replace(smokeLines[0] + '\n', '') !== previous(smoke)) throw Error('Smoke exceeds one append-only registration');
const productionLines = delta.filter(d => d.file !== smoke).reduce((n, d) => n + d.lines, 0);
if (fullOwnedGraphLines > 200 || productionLines + 1 > 200) throw Error('Extraction cap exceeded');
console.log(JSON.stringify({ base, ownedUnits, completeHelper: { file: helper, lines: helperLines, sha256: hash(read(helper)) }, fullOwnedGraphLines, stableReadModules, stablePublicModules, stableDependencySha256:hash(JSON.stringify({stableReadModules,stablePublicModules,repoUnits:stable(current)})), productionLines, smokeLines: 1, delta, statementAstSha256: oldStatements.map(hash), allOtherRepositoryUnits: stable(current), sqlSerializationClockBindingsAndResultUnchanged: true, netPrepare: 0, netRun: 0, baselineIncrease: false, mainThreadMovementClaim: false, contract: 'One exact UPDATE: prepare statement, JSON.stringify(cursor), Date.now(), then run JSON/time/id. Existing clock stays inside the kernel; void result, only cursor/update time change. No initialization, transaction or retry. Preparation errors precede serialization/clock; serialization errors precede clock/write; caller rollback retained.', auditLimit: 'Complete helper and conservative wrapper/constructor counted, all other repository units and public/config-store/app roots pinned unchanged. Real polling activation/reset/disable and saved projection characterized. Full transitive callers, UPSERT/reset policy, GitHub/plugin/startup/Space closure are not audited. Public mutations remain on main; worker command and activation are separate rungs.' }, null, 2));
