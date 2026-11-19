import ts from 'typescript';

export type LocalPipelineResolution = { kind: 'named'; name: string } | { kind: 'unknown' };

export function unwrapPipelineExpression(expression: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  )
    expression = expression.expression;
  return expression;
}

const unknown: LocalPipelineResolution = { kind: 'unknown' };

export function createLocalPipelineResolver(
  source: string,
  fileName = 'route.ts',
  strictCalls = false
): (operationName: string) => LocalPipelineResolution {
  const unwrap = unwrapPipelineExpression;
  const path = fileName.endsWith('.tsx') ? '/route.tsx' : '/route.ts';
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, noEmit: true };
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === path ? parsed : undefined);
  host.fileExists = (name) => name === path;
  host.readFile = (name) => (name === path ? source : undefined);
  const program = ts.createProgram([path], options, host);
  const checker = program.getTypeChecker();

  function importDeclaration(identifier: ts.Identifier): ts.ImportDeclaration | undefined {
    const declarations = checker.getSymbolAtLocation(identifier)?.declarations;
    if (declarations?.length !== 1) return undefined;
    let node: ts.Node | undefined = declarations[0];
    while (node && !ts.isImportDeclaration(node)) node = node.parent;
    return node;
  }

  function importedOperation(identifier: ts.Identifier): boolean {
    const symbol = checker.getSymbolAtLocation(identifier);
    const declaration = symbol?.declarations?.[0];
    const imported = importDeclaration(identifier);
    return !!(
      declaration &&
      ts.isImportSpecifier(declaration) &&
      (declaration.propertyName ?? declaration.name).text === 'defineOperation' &&
      imported &&
      ts.isStringLiteral(imported.moduleSpecifier) &&
      /(?:^|\/)registry(?:\.[cm]?[jt]s)?$/.test(imported.moduleSpecifier.text)
    );
  }

  function importedSuperpipe(identifier: ts.Identifier): boolean {
    const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
    const imported = importDeclaration(identifier);
    return !!(
      declaration &&
      ts.isImportClause(declaration) &&
      declaration.name?.text === identifier.text &&
      imported &&
      ts.isStringLiteral(imported.moduleSpecifier) &&
      imported.moduleSpecifier.text === 'superpipe'
    );
  }

  function pipeline(
    expression: ts.Expression,
    parameters = new Map<ts.Symbol, string>()
  ): LocalPipelineResolution {
    let current = unwrap(expression);
    if (!ts.isCallExpression(current) || !ts.isPropertyAccessExpression(current.expression))
      return unknown;
    if (!['end', 'endAsync'].includes(current.expression.name.text)) return unknown;
    current = unwrap(current.expression.expression);
    while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      if (!['input', 'pipe'].includes(current.expression.name.text)) return unknown;
      current = unwrap(current.expression.expression);
    }
    if (!ts.isCallExpression(current) || current.arguments.length !== 1) return unknown;
    const name = current.arguments[0];
    const factory = unwrap(current.expression);
    if (
      !ts.isCallExpression(factory) ||
      !ts.isIdentifier(factory.expression) ||
      !importedSuperpipe(factory.expression)
    )
      return unknown;
    const symbol = ts.isIdentifier(name) ? checker.getSymbolAtLocation(name) : undefined;
    if (
      symbol &&
      parameters.has(symbol) &&
      (factory.arguments.length !== 1 ||
        !ts.isObjectLiteralExpression(factory.arguments[0]) ||
        factory.arguments[0].properties.length !== 0)
    )
      return unknown;
    const resolvedName = ts.isStringLiteral(name) ? name.text : symbol && parameters.get(symbol);
    return resolvedName === undefined ? unknown : { kind: 'named', name: resolvedName };
  }

  function localFactory(expression: ts.Expression): LocalPipelineResolution {
    if (!ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) return unknown;
    const declarations = checker.getSymbolAtLocation(expression.expression)?.declarations;
    if (declarations?.length !== 1 || !ts.isVariableDeclaration(declarations[0])) return unknown;
    const declaration = declarations[0];
    if (
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const) ||
      !declaration.initializer
    )
      return unknown;
    const initializer = unwrap(declaration.initializer);
    if (
      !ts.isArrowFunction(initializer) ||
      initializer.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    )
      return unknown;
    if (initializer.parameters.length !== expression.arguments.length) return unknown;
    const parameters = new Map<ts.Symbol, string>();
    for (let i = 0; i < initializer.parameters.length; i++) {
      const parameter = initializer.parameters[i];
      const argument = unwrap(expression.arguments[i]);
      if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken || parameter.initializer)
        return unknown;
      const symbol = checker.getSymbolAtLocation(parameter.name);
      if (symbol && ts.isStringLiteral(argument)) parameters.set(symbol, argument.text);
    }
    if (!ts.isBlock(initializer.body)) return pipeline(initializer.body, parameters);
    if (initializer.body.statements.length !== 1) return unknown;
    const statement = initializer.body.statements[0];
    return ts.isReturnStatement(statement) && statement.expression
      ? pipeline(statement.expression, parameters)
      : unknown;
  }

  function callable(expression: ts.Expression, seen: Set<ts.Node>): LocalPipelineResolution {
    expression = unwrap(expression);
    const direct = pipeline(expression);
    if (direct.kind === 'named') return direct;
    const built = localFactory(expression);
    if (built.kind === 'named') return built;
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      if (ts.isBlock(expression.body)) {
        if (expression.body.statements.length !== 1) return unknown;
        const statement = expression.body.statements[0];
        return ts.isReturnStatement(statement) && statement.expression
          ? action(statement.expression, seen)
          : unknown;
      }
      return action(expression.body, seen);
    }
    if (!ts.isIdentifier(expression)) return unknown;
    const declarations = checker.getSymbolAtLocation(expression)?.declarations;
    if (declarations?.length !== 1) return unknown;
    const declaration = declarations[0];
    if (
      !ts.isVariableDeclaration(declaration) ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const) ||
      !declaration.initializer ||
      seen.has(declaration)
    )
      return unknown;
    seen.add(declaration);
    return callable(declaration.initializer, seen);
  }

  function action(expression: ts.Expression, seen: Set<ts.Node>): LocalPipelineResolution {
    expression = unwrap(expression);
    if (ts.isAwaitExpression(expression)) return action(expression.expression, seen);
    if (
      !ts.isCallExpression(expression) ||
      (strictCalls && (expression.flags & ts.NodeFlags.OptionalChain) !== 0) ||
      !ts.isIdentifier(expression.expression)
    )
      return unknown;
    return callable(expression.expression, seen);
  }

  const matches = new Map<string, ts.Expression[]>();
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      importedOperation(node.expression) &&
      node.arguments.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const properties = node.arguments[0].properties;
      const name = properties.find(
        (property) => ts.isPropertyAssignment(property) && property.name.getText(parsed) === 'name'
      );
      const execute = properties.find(
        (property) =>
          ts.isPropertyAssignment(property) && property.name.getText(parsed) === 'execute'
      );
      if (
        name &&
        ts.isPropertyAssignment(name) &&
        ts.isStringLiteral(name.initializer) &&
        execute &&
        ts.isPropertyAssignment(execute)
      ) {
        const nameMatches = matches.get(name.initializer.text) ?? [];
        nameMatches.push(execute.initializer);
        matches.set(name.initializer.text, nameMatches);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return (operationName) => {
    const found = matches.get(operationName);
    return found?.length === 1 ? callable(found[0], new Set()) : unknown;
  };
}
