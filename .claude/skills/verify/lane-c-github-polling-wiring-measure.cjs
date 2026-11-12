const fs = require('node:fs');
const cp = require('node:child_process');
const ts = require(process.cwd() + '/node_modules/typescript');
const { createHash } = require('node:crypto');
const root = 'packages/daemon/src/';
const hash = text => createHash('sha256').update(text).digest('hex');
const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
const lines = (sf, node) => sf.getLineAndCharacterOfPosition(node.end).line - sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
function named(sf, name) {
  let found;
  function walk(node) {
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(sf) === name) found = node;
    if (!found) ts.forEachChild(node, walk);
  }
  walk(sf);
  if (!found) throw Error('Missing root ' + name);
  return found;
}
const dataSpecs = [
  ['github-watched-repo-lookups.ts', 28, 'ed10d2284643624e608b22eff1c17f50c0848c567681b41d11ff7f0345c438df', 'Key/id SELECT, lower owner/repo and exact Space/id; existing mapper/null/errors'],
  ['github-watched-repos-read.ts', 38, 'f41326de1acc9416d313230f3144405d21638e8c6d846149431558a26f883165', 'Ordered complete SELECT and flags/null/default/cursor mapper, no initialization'],
  ['github-space-settings-read.ts', 30, 'b81f7c1ec84794b804f5308cc3a0c90306e3c60405fdddfd0dde70111a751752', 'Enabled/intent/filter defaults, no initialization'],
  ['github-cursor-persist.ts', 13, 'fcef214c6ba43ee94d34e8ed44fcaa913ab0bf9761fd61404b4328eab70744f4', 'Existing cursor JSON/time/ID bind order and caller rollback'],
  ['github-watched-update-persist.ts', 67, '193d6426e2c4bc6e70449a6ca53f75b2a18375a1f07d12215816617978f4b5c4', 'Exact UPDATE flags/null/COALESCE/binds, supplied time, caller transaction'],
  ['github-watched-upsert-persist.ts', 40, 'c108d5f4cff7893041110ad4c28154c7922b8a6204388a68ab7ab9a0cf5addd9', 'Constructor-free UPSERT/UUID/clock/Space fallback and cursor policy'],
  ['github-polling-enabled-write.ts', 66, '35ea83f321ef4b0d1dc211a079fd10422dc6407b557e8f40f369b600cb99a75a', 'Serializable Space/enabled input; one existing gateway transaction; exact committed config receipt; no replay'],
];
const data = dataSpecs.map(([name, expectedLines, expectedHash, contract]) => {
  const file = root + 'storage/repositories/' + name, text = fs.readFileSync(file, 'utf8');
  const actualLines = text.trimEnd().split('\n').length;
  if (actualLines !== expectedLines || hash(text) !== expectedHash) throw Error('Approved data module drift: ' + file);
  return { file, lines: actualLines, sha256: expectedHash, contract, auditedStable: true };
});
const freshFiles = [
  ['storage/repositories/github-watched-insert-persist.ts', 'Exact INSERT and supplied UUID/Space/time/defaults/caller transaction'],
  ['storage/repositories/github-polling-intent-persist.ts', 'Exact intent UPSERT, enabled preservation and supplied time'],
  ['storage/repositories/space-extension-config-persist.ts', 'Exact saved config JSON/key/creation time and caller transaction'],
  ['lib/external-events/github/github-watched-projection.ts', 'Sanitized saved projection, configured-secret marker, no secret/cursor leak'],
].map(([path, contract]) => {
  const file = root + path, text = fs.readFileSync(file, 'utf8');
  return { file, lines: text.trimEnd().split('\n').length, sha256: hash(text), contract };
});
const uuidFile = 'packages/shared/src/utils.ts', uuidText = fs.readFileSync(uuidFile, 'utf8');
const uuidSf = parse(uuidFile, uuidText), uuid = named(uuidSf, 'generateUUID');
const uuidRoot = { file: uuidFile, lines: lines(uuidSf, uuid), sha256: hash(uuid.getText(uuidSf)), fullModuleSha256: hash(uuidText), contract: 'Existing complete UUID leaf; shared barrel/runtime closure unclaimed' };
const extension = root + 'lib/external-events/github/github-event-extension.ts';
const source = fs.readFileSync(extension, 'utf8'), sf = parse(extension, source);
let callback;
function findCallback(node) {
  if (ts.isCallExpression(node) && node.arguments[0]?.text === 'space.github.setPollingEnabled') callback = node.arguments[1];
  ts.forEachChild(node, findCallback);
}
findCallback(sf);
if (!callback) throw Error('Missing polling handler');
let handler = callback.getText(sf), phase = 'wired';
if (handler.includes('this.repo.upsertWatchedRepo')) {
  phase = 'planned';
  handler = handler.replace(/      const repos = this\.repo\.listWatchedRepos[\s\S]*?\n      if \(params\.enabled\)/, `      await gatewayFor(this.db).run(gitHubPollingWrites, {
        spaceId: params.spaceId,
        enabled: params.enabled,
      });
      if (params.enabled)`)
    .replace(/        this\.repo\.setPollingIntent\(params\.spaceId, (?:true|false)\);\n/g, '')
    .replace('      await this.persistSpaceConfig(context, params.spaceId);\n', '');
}
const auth = named(sf, 'assertRpcConfigEnabled');
const handlerRoot = { file: extension, lines: handler.split('\n').length, sha256: hash(handler), phase, contract: 'Original auth/interval/response and callbacks; exactly one data-only writer call, no snapshot rebuild/replay' };
const authorization = { file: extension, lines: lines(sf, auth), sha256: hash(auth.getText(sf)), contract: 'Existing RPC configuration admission before worker command' };
const interfaceSpecs = [
  [extension, ['enablePollingCapability', 'disablePollingCapabilityIfUnused', 'assertPollingIntervalEnabled', 'ensurePollingActive', 'getPollIntervalMs', 'scheduleNextPoll']],
  [root + 'lib/external-events/github/github-repository.ts', ['listAllPollingConfiguredRepos', 'countSpacesWithPollingIntent', 'listPollingRepos']],
  [root + 'lib/external-events/extension-config-store.ts', ['getGlobalConfig', 'setGlobalConfig']],
];
const interfaces = interfaceSpecs.flatMap(([file, names]) => {
  const text = fs.readFileSync(file, 'utf8'), sf = parse(file, text);
  return names.map(name => { const node = named(sf, name); return { file, name, lines: lines(sf, node), sha256: hash(node.getText(sf)), pinnedNotAudited: true, contract: 'Capability helpers use the reader and effect queue under #9649; timer/interval and config interfaces remain bounded roots. Query wrappers delegate to exact SQL under #9645. Separate extraction/activation graphs are counted without exclusions; transitive effects and constructors not audited here' }; });
});
const fresh = freshFiles.reduce((n, row) => n + row.lines, 0) + uuidRoot.lines + handlerRoot.lines + authorization.lines;
const dataExcluded = data.reduce((n, row) => n + row.lines, 0);
const interfaceLines = interfaces.reduce((n, row) => n + row.lines, 0);
const approvedInterfaceHashes = {
  "enablePollingCapability": "77becc21a2f52b962d6c22398b7daa6ce9dee68643dc016431ca03c43596df31",
  "disablePollingCapabilityIfUnused": "10a30e900f2cd8b6b62ddbe226c0d733d90f20948e6e4cd910a34b8856bae22e",
  "assertPollingIntervalEnabled": "2ae3a9ab8e9201104ad1f5b257f0bd73b9569abbe1a69cac15bf3d18fa7e0332",
  "ensurePollingActive": "b40fa77bfb50f6856fdbffbecba6650605de19a902eb79c3628c08f57bee6590",
  "getPollIntervalMs": "2836cf7a3bf0c7162a3e55b25bae19640e8cbeecb491f89f0ac304d936fb0232",
  "scheduleNextPoll": "412d5ea222fb60761a0bf8e6aac10a512079c91859e5a866fdcbbd9dca28b70b",
  "listAllPollingConfiguredRepos": "dfb08f6440274ffe99e70d8c5a84e04921c8ccee39d7590848f234e3967ea7b6",
  "countSpacesWithPollingIntent": "527c51aeda4b35502edabe46a0dc35b884a7eed594ded784f651633125d60ed9",
  "listPollingRepos": "fd546cea51365ecede177c801d4a5c9865ac8fc4f2124acbcc22ff5dcaf18015",
  "getGlobalConfig": "34bae87ad4dce4c77e3ac0caa2465d62db43dbdf4ba0009183b520c58efd3e23",
  "setGlobalConfig": "9fda9b0825dc5a808ea4876bdd824280ed4dc40d30fffd76faaa3542a516986a"
};
for (const row of interfaces) {
  if (approvedInterfaceHashes[row.name] !== row.sha256) throw Error('Approved interface root drift: ' + row.name);
  row.hashVerified = true;
}
const report = { head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), phase, fresh, dataExcluded, ownedKnown: fresh + dataExcluded, interfaceLines, previousGrant: { fresh: 154, dataExcluded: 272, ownedKnown: 426, interfaceLines: 116 }, data, freshFiles, uuidRoot, handlerRoot, authorization, interfaces, getterInterfaceContract: 'Child #9671 changes the existing four-line getter to reader-backed delegation, preserving validation/result/error interfaces. Its complete owned graph is independently measured with zero exclusions; no new data exclusion or transitive audit here.', auditLimit: 'Sibling #9663 refreshes only getGlobalConfig to a four-line main-side delegation; its constructor-free query/JSON extraction is independently counted with zero exclusions, not a new transitive audit here. Seven audited data exclusions only. Interface roots explicitly pinned-not-audited; no full public/shared barrel/runtime closure. The selected public polling timer caller has its own 199-line #9651 audit. The unwatch timer callback separately counts 196 lines with zero exclusions under #9653. The watch callback separately uses its Neo-approved fresh167/excluded97/known264 boundary under #9655; global config reads still block #8714; #9438 is separately closed for its timer/capability family. The retired six-line maybeStopPolling root is deleted under #9657; eleven remaining interface roots now total 67 after the additional getGlobalConfig delegation under #9663 after the three exact query delegations extracted under #9645 and capability reader/effect-queue activation under #9649; their original measured total was 117 (correcting 116). The complete extracted helper/mapper/constructor graph is counted by its own 146-line extraction audit, with zero exclusions. Capability activation separately counts 175 owned lines plus the same get/set config interface roots, now 10 lines and one smoke registration (186 known, no exclusions). Deliberate pin refresh; no additional root or data exclusion. Any unreviewed interface drift fails this measurement.' };
fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ phase, fresh, dataExcluded, ownedKnown: report.ownedKnown, interfaceLines }));
