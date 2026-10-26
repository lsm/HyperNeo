import { dirname, relative } from 'node:path';
import ts from 'typescript';

const WRITERS: Array<[file: string, method: string]> = [
  ...[
    'createSession',
    'updateSession',
    'deleteSession',
    'clearAcpSessionIds',
    'detachSessionFromParent',
    'setSessionParent',
    'setSessionLastError',
    'markRestartInterruptedTurns',
    'takeRestartCooldownResume',
    'casSessionInputDraft',
    'casSessionRuntimeSettings',
  ].map((method): [string, string] => ['/storage/index.ts', method]),
  ['/lib/agent/agent-session.ts', 'updateMetadata'],
  ['/lib/agent/session-config-handler.ts', 'updateMetadata'],
];
const root = process.cwd();
const tests = process.argv.includes('--tests');
const scanned = `${root}/packages/daemon/${tests ? 'tests' : 'src'}/`;
const configPath = ts.findConfigFile(
  `${root}/packages/daemon`,
  ts.sys.fileExists,
  tests ? 'tsconfig.tests.json' : 'tsconfig.json'
);
if (!configPath) throw new Error('packages/daemon tsconfig not found');
const config = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => {
    throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  },
});
if (!config) throw new Error('could not parse tsconfig');
const program = ts.createProgram(config.fileNames, config.options);
const checker = program.getTypeChecker();

function settledByCaller(call: ts.Node): boolean {
  let node = call;
  let caught = false;
  for (;;) {
    const parent = node.parent;
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)) {
      node = parent;
      continue;
    }
    if (
      ts.isPropertyAccessExpression(parent) &&
      ['then', 'catch', 'finally'].includes(parent.name.text) &&
      ts.isCallExpression(parent.parent)
    ) {
      caught ||= parent.name.text === 'catch';
      node = parent.parent;
      continue;
    }
    if (ts.isAwaitExpression(parent) || ts.isReturnStatement(parent)) return true;
    if (ts.isArrowFunction(parent) && parent.body === node) return true;
    if (ts.isArrayLiteralExpression(parent)) return true;
    return caught;
  }
}

const floating: string[] = [];
for (const file of program.getSourceFiles()) {
  if (file.isDeclarationFile || !file.fileName.startsWith(scanned)) continue;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const returned = checker.getTypeAtLocation(node);
      const isPromise = returned.getSymbol()?.getName() === 'Promise';
      const declared = checker.getResolvedSignature(node)?.getDeclaration()?.getSourceFile().fileName;
      const isWriter = WRITERS.some(([file, name]) => name === method && declared?.endsWith(file));
      if (isPromise && isWriter && !settledByCaller(node)) {
        const { line } = file.getLineAndCharacterOfPosition(node.getStart());
        let fn: ts.Node | undefined = node.parent;
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
        const name = fn && 'name' in fn && fn.name ? (fn.name as ts.Node).getText() : '<anonymous>';
        const isAsync = !!fn && ts.getCombinedModifierFlags(fn as ts.Declaration) & ts.ModifierFlags.Async;
        floating.push(
          `${relative(root, file.fileName)}:${line + 1}  ${node.expression.getText()}  in ${isAsync ? 'async ' : ''}${name}`
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
}
for (const entry of floating) console.log(entry);
console.log(`${floating.length} unawaited session write(s) in ${relative(root, scanned)}`);
process.exit(floating.length === 0 ? 0 : 1);
