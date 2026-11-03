const ts = require(process.cwd() + '/node_modules/typescript');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
const roots = ['git-capture', 'resolve-operation', 'stored-kind', 'read-operations', 'registration-binding', 'file-policy'];
const modules = roots.map(name => {
  const file = `packages/daemon/src/lib/artifacts/${name}.ts`;
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const units = source.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isTypeAliasDeclaration(node) && !ts.isInterfaceDeclaration(node)).map(node => {
    const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const end = source.getLineAndCharacterOfPosition(node.end).line + 1;
    return { name: node.name?.getText(source) ?? node.declarationList?.declarations[0]?.name.getText(source), start, end, lines: end - start + 1, sha256: hash(node.getText(source)) };
  });
  const imports = source.statements.filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.text);
  return { file, sha256: hash(text), executableLines: units.reduce((count, unit) => count + unit.lines, 0), imports, units };
});
const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/dev'], { encoding: 'utf8' }).trim();
const diff = execFileSync('git', ['diff', '--numstat', base, '--', 'packages/daemon/src', 'packages/shared/src', 'scripts/deno-smoke.sh'], { encoding: 'utf8' });
console.log(JSON.stringify({ base, modules, diff, auditLimit: 'Current local executable-unit inventory and direct imports only. Transitive runtime/OS/library behavior is not audited by this script; real Git and legacy-reader proofs remain required.' }, null, 2));
