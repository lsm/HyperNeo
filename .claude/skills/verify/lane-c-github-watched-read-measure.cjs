const ts = require(process.cwd() + '/node_modules/typescript');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const repo = 'packages/daemon/src/lib/external-events/github/github-repository.ts';
const helper = 'packages/daemon/src/storage/repositories/github-watched-repos-read.ts';
const smoke = 'scripts/deno-smoke.sh';
const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/dev'], { encoding: 'utf8' }).trim();
const previous = file => execFileSync('git', ['show', base + ':' + file], { encoding: 'utf8' });
const read = file => fs.readFileSync(file, 'utf8');
const pairs = { listWatchedRepos: 'listGitHubWatchedRepos', rowToRepo: 'mapGitHubWatchedRepo' };
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
  visit(sf); return units;
}
const old = inspect(repo, previous(repo)), current = inspect(repo, read(repo)), extracted = inspect(helper, read(helper));
function interfaces(text) {
  const sf = ts.createSourceFile(repo, text, ts.ScriptTarget.Latest, true);
  return sf.statements.filter(ts.isInterfaceDeclaration).map(node => ({ name:node.name.text, sha256:hash(node.getText(sf)) }));
}
const typeContracts = interfaces(read(repo));
if (JSON.stringify(typeContracts) !== JSON.stringify(interfaces(previous(repo)))) throw Error('Exported type contracts changed');

for (const [name, target] of Object.entries(pairs)) {
  const before = old.find(u => u.name === name), wrapper = current.find(u => u.name === name), after = extracted.find(u => u.name === target);
  if (JSON.stringify(before.body.map(s => shape(s.replaceAll('this.db', 'db').replaceAll('this.rowToRepo(r)', 'mapGitHubWatchedRepo(r)')))) !== JSON.stringify(after.body.map(shape))) throw Error('SQL/bind/default/error contract changed: ' + name);
  if (wrapper.body.length !== 1 || wrapper.body[0] !== `return ${target}(${name === 'rowToRepo' ? 'row' : 'this.db, spaceId'});`) throw Error('Unexpected wrapper: ' + name);
}
const stable = units => units.filter(u => !pairs[u.name]).map(({ body, ...u }) => u);
if (JSON.stringify(stable(old)) !== JSON.stringify(stable(current))) throw Error('Other repository units or constructor/backfill changed');
const selected = ['constructor','setRepoEnabled','isSpaceEnabled','getPollingIntent','getFilterCurrentUser','listWatchedRepos','rowToRepo'];
const ownedUnits = current.filter(u => selected.includes(u.name)).map(({ body, ...u }) => u);
const helperLines = read(helper).trimEnd().split('\n').length;
const sourcePersist = 'packages/daemon/src/storage/repositories/github-space-enabled-persist.ts';
if (read(sourcePersist) !== previous(sourcePersist)) throw Error('Source writer dependency changed');
const settingsRead = 'packages/daemon/src/storage/repositories/github-space-settings-read.ts';
if (read(settingsRead) !== previous(settingsRead)) throw Error('Settings read dependency changed');
const ownedGraphLines = ownedUnits.reduce((n,u) => n+u.lines, helperLines + read(sourcePersist).trimEnd().split('\n').length + read(settingsRead).trimEnd().split('\n').length);
const delta = execFileSync('git', ['diff','--numstat',base,'--','packages/daemon/src',smoke],{encoding:'utf8'}).trim().split('\n').filter(Boolean).map(line=>{const[a,d,file]=line.split('\t');return{file,lines:Number(a)+Number(d)};});
for (const d of delta) if (![repo,helper,smoke].includes(d.file)) throw Error('Unexpected source scope: '+d.file);
const smokeLines=read(smoke).split('\n').filter(line=>line.includes('lane-c-github-watched-repos-read.ts'));
if (smokeLines.length!==1 || read(smoke).replace(smokeLines[0]+'\n','')!==previous(smoke)) throw Error('Smoke exceeds one append-only registration');
const productionLines=delta.filter(d=>d.file!==smoke).reduce((n,d)=>n+d.lines,0);
if(ownedGraphLines>200||productionLines+1>200)throw Error('Slice cap exceeded');
const fixture='.claude/skills/verify/lane-c-github-space-settings-read.ts';
const rpcFixture='.claude/skills/verify/lane-c-github-space-enabled-extract.ts';
if(read(rpcFixture)!==previous(rpcFixture))throw Error('Imported original RPC fixture changed');
if(read(fixture)!==previous(fixture))throw Error('Imported native fixture changed');
console.log(JSON.stringify({base,ownedUnits,typeContracts,completeHelper:{file:helper,lines:helperLines,sha256:hash(read(helper))},sourceWriterDependency:{file:sourcePersist,lines:read(sourcePersist).trimEnd().split('\n').length,sha256:hash(read(sourcePersist)),contract:'Existing two-write source enable helper; constructor-free; no new public movement'},settingsReadDependency:{file:settingsRead,lines:read(settingsRead).trimEnd().split('\n').length,sha256:hash(read(settingsRead)),contract:'Three existing query/default wrappers; unchanged'},publicRpcFixture:{file:fixture,sha256:hash(read(fixture)),originalRpcFixtureSha256:hash(read(rpcFixture)),contract:'Unchanged prior settings proof imports unchanged native Space enable/disable/list RPC fixture; four main writes remain; all close before new scratch proof'},ownedGraphLines,productionLines,smokeLines:1,delta,sqlBindingsOrderAndMapperAstUnchanged:true,allOtherRepositoryUnits:stable(current),netPrepare:0,netRun:0,baselineIncrease:false,mainThreadMovementClaim:false,auditLimit:'Complete list/mapper helpers and conservative source repository units counted; other production methods, exported type interfaces and constructor/backfill remain unchanged. Other mapper consumers pinned byte-identical, not transitively audited. Full GitHub/plugin/startup/Space closure outside this extraction; imported native fixture supplies observable behavior characterization only.'},null,2));
