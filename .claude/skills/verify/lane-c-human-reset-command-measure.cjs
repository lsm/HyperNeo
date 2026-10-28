const ts = require(process.cwd() + '/node_modules/typescript');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const hash = text => createHash('sha256').update(text).digest('hex');
const measure = (file, names, classes = {}, whole = false) => {
 const text = fs.readFileSync(file, 'utf8');
 const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
 const units = [];
 const add = (node, name) => {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  units.push({ file, name, start, end, lines: end - start + 1, sha256: hash(node.getText(source)) });
 };
 if (whole) return [{file,name:'whole local module',lines:text.trimEnd().split('\n').length,sha256:hash(text)}];
 const visit = node => {
  if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name && names.includes(node.name.getText(source))) add(node,node.name.getText(source));
  if (ts.isClassDeclaration(node) && node.name && classes[node.name.getText(source)]) for (const member of node.members) {
   const name = ts.isConstructorDeclaration(member) ? 'constructor' : member.name?.getText(source);
   if (classes[node.name.getText(source)].includes(name)) add(member,node.name.getText(source)+'.'+name);
  }
  ts.forEachChild(node,visit);
 };visit(source);return units;
};
const localUnits = [
 ...(fs.existsSync('packages/daemon/src/storage/repositories/neo-conversation-reservation.ts') ? measure('packages/daemon/src/storage/repositories/neo-conversation-reservation.ts',[],{},true) : []),
 ...measure('packages/daemon/src/storage/repositories/human-device-reset-repository.ts',[],{},true),
 ...(fs.existsSync('packages/daemon/src/storage/repositories/human-device-reset-write.ts') ? measure('packages/daemon/src/storage/repositories/human-device-reset-write.ts',[],{},true) : []),
 ...measure('packages/daemon/src/storage/repositories/neo-repository.ts',['bindingColumns'],{NeoRepository:['constructor','defaultBinding','conversationId']}),
 ...measure('packages/daemon/src/storage/repositories/neo-project-merge-repository.ts',[],{NeoProjectMergeRepository:['constructor']}),
];
const stableAppendUnits = [
 ...measure('packages/daemon/src/storage/repositories/neo-publication-repository.ts',['columns','decode','appendImmutable','append','neoPublicationWrites'],{NeoPublicationRepository:['constructor','append']}),
 ...measure('packages/daemon/src/lib/neo/publication.ts',['text','origin','NeoPublicationObject','publicationTextRule','NeoPublicationSchema','admitNeoPublication']),
 ...measure('packages/daemon/src/lib/artifacts/file-contracts.ts',['byteCount','artifactId','ArtifactRefSchema']),
 ...measure('packages/shared/src/types/artifact-file.ts',['ARTIFACT_KINDS']),
];
const stableGatewayAdapterUnits = measure('packages/daemon/src/storage/db-gateway/db-op.ts',['defineRepositoryOp'],{ChangeRecorder:['notifyChange','beginTransaction','commitTransaction','abortTransaction']});
const base = execFileSync('git',['merge-base','HEAD','origin/dev'],{encoding:'utf8'}).trim();
const delta = execFileSync('git',['diff','--numstat',base,'--','packages/daemon/src','scripts/deno-smoke.sh'],{encoding:'utf8'}).trim().split('\n').filter(Boolean).map(line=>{const [added,removed,file]=line.split('\t');return {file,lines:Number(added)+Number(removed)};});
const totalLines = localUnits.reduce((n,u)=>n+u.lines,0);
const productionLines = delta.filter(d=>d.file.startsWith('packages/daemon/src/')).reduce((n,d)=>n+d.lines,0);
const smokeRegistrationLines = delta.filter(d=>d.file==='scripts/deno-smoke.sh').reduce((n,d)=>n+d.lines,0);
console.log(JSON.stringify({base,localUnits,totalLines,productionLines,smokeRegistrationLines,delta,auditedStableAppend:{authorization:'Neo explicitly approved separate audited measurement of the already-registered worker-owned append subtree.',contract:'neo.publications.write / write / append(input); synchronous same-connection execution inside the reset transaction; cloneable accepted/refused receipt; no independent gateway call or outer commit. Legacy reset calls the identical Repository.append implementation exposed by this op.',units:stableAppendUnits,totalLines:stableAppendUnits.reduce((n,u)=>n+u.lines,0),contractTest:'packages/daemon/tests/unit/1-core/pairing/human-reset-command.test.ts'},stableGatewayAdapterUnits,sharedPlumbing:'Existing native gateway, SQLite/Zod/builtin internals and notifications are not moved or changed. This construction measurement does not exercise the public reset operation.'},null,2));
if (totalLines>200 || productionLines+smokeRegistrationLines>200) process.exitCode=1;
