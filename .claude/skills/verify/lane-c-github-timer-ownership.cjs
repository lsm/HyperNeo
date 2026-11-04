const fs = require('node:fs');
const ts = require(process.cwd() + '/node_modules/typescript');
const file = 'packages/daemon/src/lib/external-events/github/github-event-extension.ts';
const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
const expected = ['space.github.watchRepo', 'space.github.unwatchRepo', 'space.github.setPollingEnabled'];
const callbacks = [];
let retired = 0;
function countAwaitedReader(node) {
  let count = 0;
  function visit(n) {
    if (ts.isAwaitExpression(n) && ts.isCallExpression(n.expression) && n.expression.expression.getText(source) === 'this.stopIdlePollingOnReader') count++;
    ts.forEachChild(n, visit);
  }
  visit(node);
  return count;
}
function visit(node) {
  if (ts.isIdentifier(node) && node.text === 'maybeStopPolling') retired++;
  if (ts.isCallExpression(node) && node.expression.getText(source).endsWith('.onRequest') && expected.includes(node.arguments[0]?.text)) {
    const name = node.arguments[0].text;
    if (countAwaitedReader(node.arguments[1]) !== 1) throw Error(name + ' must await exactly one reader timer decision');
    callbacks.push(name);
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (retired) throw Error('Retired synchronous timer helper remains on main');
if (callbacks.length !== expected.length || expected.some(name => !callbacks.includes(name))) throw Error('Missing public timer callback');
const result = { callbacks, retiredReferences: retired, scope: 'Three public timer callbacks only; other SQL families and runtime transitive closure are not covered.' };
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
