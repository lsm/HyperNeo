import ts from 'typescript';

type Route = { name: string; kind: 'builder' | 'runner' };
type Arguments = ReadonlyMap<ts.Symbol, Route>;

export function createPipelineBuilderResolver(
  checker: ts.TypeChecker,
  unwrap: (expression: ts.Expression) => ts.Expression,
  importedSuperpipe: (identifier: ts.Identifier) => boolean
): (expression: ts.Expression) => string | undefined {
  const stable = new Map<ts.Symbol, boolean>();

  function isPrivateFactory(declaration: ts.FunctionDeclaration, symbol: ts.Symbol): boolean {
    const cached = stable.get(symbol);
    if (cached !== undefined) return cached;
    if (declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
      return false;

    function hasOtherUse(node: ts.Node): boolean {
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (ts.isIdentifier(callee) && callee.text === 'eval') return true;
      }
      if (
        ts.isIdentifier(node) &&
        node !== declaration.name &&
        node.text === declaration.name?.text
      ) {
        const parent = node.parent;
        const binding = ts.isShorthandPropertyAssignment(parent)
          ? checker.getShorthandAssignmentValueSymbol(parent)
          : checker.getSymbolAtLocation(node);
        if (binding === symbol && !(ts.isCallExpression(parent) && parent.expression === node))
          return true;
      }
      return ts.forEachChild(node, (child) => (hasOtherUse(child) ? true : undefined)) === true;
    }

    const result = !hasOtherUse(declaration.parent);
    stable.set(symbol, result);
    return result;
  }

  function factory(symbol: ts.Symbol) {
    const declarations = symbol.declarations;
    if (declarations?.length !== 1) return undefined;
    const declaration = declarations[0];
    if (ts.isFunctionDeclaration(declaration))
      return !declaration.asteriskToken && isPrivateFactory(declaration, symbol)
        ? declaration
        : undefined;
    if (
      !ts.isVariableDeclaration(declaration) ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const) ||
      !declaration.initializer
    )
      return undefined;
    const init = unwrap(declaration.initializer);
    return ts.isArrowFunction(init) ? init : undefined;
  }

  function resolve(
    expression: ts.Expression,
    args: Arguments,
    seen: Set<ts.Symbol>
  ): Route | undefined {
    const node = unwrap(expression);
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      return symbol ? args.get(symbol) : undefined;
    }
    if (
      !ts.isCallExpression(node) ||
      (node.flags & ts.NodeFlags.OptionalChain) !== 0 ||
      node.arguments.some(ts.isSpreadElement)
    )
      return undefined;
    const callee = unwrap(node.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (!['input', 'pipe', 'end', 'endAsync'].includes(method)) return undefined;
      const route = resolve(callee.expression, args, seen);
      if (route?.kind !== 'builder') return undefined;
      return ['end', 'endAsync'].includes(method) ? { name: route.name, kind: 'runner' } : route;
    }
    if (ts.isCallExpression(callee)) {
      const name = node.arguments[0];
      return node.arguments.length === 1 &&
        ts.isStringLiteral(name) &&
        ts.isIdentifier(callee.expression) &&
        importedSuperpipe(callee.expression)
        ? { name: name.text, kind: 'builder' }
        : undefined;
    }
    if (!ts.isIdentifier(callee)) return undefined;
    const symbol = checker.getSymbolAtLocation(callee);
    if (!symbol || seen.has(symbol)) return undefined;
    const fn = factory(symbol);
    if (
      !fn?.body ||
      fn.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
      fn.parameters.length !== node.arguments.length
    )
      return undefined;
    const body = fn.body;
    const statement = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : null;
    const returned = ts.isBlock(body)
      ? statement && ts.isReturnStatement(statement) && statement.expression
      : body;
    if (!returned) return undefined;
    const next = new Map<ts.Symbol, Route>();
    const visiting = new Set(seen).add(symbol);
    for (const [i, param] of fn.parameters.entries()) {
      if (!ts.isIdentifier(param.name) || param.initializer || param.dotDotDotToken)
        return undefined;
      const binding = checker.getSymbolAtLocation(param.name);
      const route = resolve(node.arguments[i], args, visiting);
      if (binding && route?.kind === 'builder') next.set(binding, route);
    }
    if (next.size === 0) return undefined;
    return resolve(returned, next, visiting);
  }

  return (expression) => {
    const route = resolve(expression, new Map(), new Set());
    return route?.kind === 'runner' ? route.name : undefined;
  };
}
