import ts from 'typescript';

function thenCall(expression: ts.Expression | undefined, count: number) {
  if (
    !expression ||
    !ts.isCallExpression(expression) ||
    (expression.flags & ts.NodeFlags.OptionalChain) !== 0 ||
    !ts.isPropertyAccessExpression(expression.expression) ||
    expression.expression.name.text !== 'then' ||
    !ts.isIdentifier(expression.expression.expression) ||
    expression.arguments.length !== count
  )
    return undefined;
  return { receiver: expression.expression.expression, args: expression.arguments };
}

function singleDeclaration(statement: ts.Statement) {
  return ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
    ? statement.declarationList.declarations[0]
    : undefined;
}

export function serializedPipelineCallback(call: ts.CallExpression, checker: ts.TypeChecker) {
  const serializer = call.expression;
  const callback = call.arguments[0];
  if (
    !ts.isIdentifier(serializer) ||
    call.arguments.length !== 1 ||
    !ts.isArrowFunction(callback) ||
    (call.flags & ts.NodeFlags.OptionalChain) !== 0
  )
    return undefined;
  const symbol = (node: ts.Node) => checker.getSymbolAtLocation(node);
  const declarations = symbol(serializer)?.declarations;
  const declaration = declarations?.length === 1 ? declarations[0] : undefined;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    !declaration.initializer ||
    !ts.isArrowFunction(declaration.initializer)
  )
    return undefined;
  const { parameters, body } = declaration.initializer;
  const [parameter] = parameters;
  if (
    parameters.length !== 1 ||
    parameter.initializer ||
    parameter.dotDotDotToken ||
    !ts.isIdentifier(parameter.name) ||
    !ts.isBlock(body) ||
    body.statements.length !== 3
  )
    return undefined;
  const [start, advance, finish] = body.statements;
  const result = singleDeclaration(start);
  const next = thenCall(result?.initializer, 1);
  if (
    !result ||
    (result.parent.flags & ts.NodeFlags.Const) === 0 ||
    !ts.isIdentifier(result.name) ||
    !next ||
    !ts.isIdentifier(next.args[0]) ||
    symbol(next.args[0]) !== symbol(parameter.name) ||
    !ts.isExpressionStatement(advance) ||
    !ts.isBinaryExpression(advance.expression) ||
    advance.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isIdentifier(advance.expression.left) ||
    !ts.isReturnStatement(finish) ||
    !finish.expression ||
    !ts.isIdentifier(finish.expression) ||
    symbol(finish.expression) !== symbol(result.name)
  )
    return undefined;
  const reset = thenCall(advance.expression.right, 2);
  if (
    !reset ||
    symbol(reset.receiver) !== symbol(result.name) ||
    reset.args.some(
      (arg) =>
        !ts.isArrowFunction(arg) ||
        arg.parameters.length !== 0 ||
        !ts.isIdentifier(arg.body) ||
        arg.body.text !== 'undefined' ||
        symbol(arg.body)?.declarations?.length
    )
  )
    return undefined;
  const pending = symbol(next.receiver);
  const cursors = pending?.declarations;
  const cursor = cursors?.length === 1 ? cursors[0] : undefined;
  if (
    !cursor ||
    !ts.isVariableDeclaration(cursor) ||
    (cursor.parent.flags & ts.NodeFlags.Let) === 0 ||
    symbol(advance.expression.left) !== pending ||
    cursor.parent.parent.parent !== declaration.parent.parent.parent ||
    cursor.pos >= declaration.pos ||
    !cursor.initializer ||
    !ts.isCallExpression(cursor.initializer) ||
    cursor.initializer.arguments.length !== 0 ||
    (cursor.initializer.flags & ts.NodeFlags.OptionalChain) !== 0 ||
    !ts.isPropertyAccessExpression(cursor.initializer.expression) ||
    cursor.initializer.expression.name.text !== 'resolve' ||
    !ts.isIdentifier(cursor.initializer.expression.expression) ||
    cursor.initializer.expression.expression.text !== 'Promise' ||
    symbol(cursor.initializer.expression.expression)
  )
    return undefined;
  const cursorName = cursor.name;
  const left = advance.expression.left;
  function hasOtherUse(node: ts.Node): boolean {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'eval'
    )
      return true;
    if (ts.isIdentifier(node) && node !== cursorName && node !== left && node !== next?.receiver) {
      const binding = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : symbol(node);
      if (binding === pending) return true;
    }
    return ts.forEachChild(node, (child) => hasOtherUse(child) || undefined) === true;
  }
  return hasOtherUse(declaration.parent.parent.parent) ? undefined : callback;
}
