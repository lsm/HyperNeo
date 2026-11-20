import ts from 'typescript';
import { createPipelineBuilderResolver } from './pipeline-builder-factory.ts';

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

  const stableDeclarations = new Map<ts.FunctionDeclaration, boolean>();
  function stableLocalFactory(declaration: ts.FunctionDeclaration, symbol: ts.Symbol): boolean {
    const scope = declaration.parent;
    if (!ts.isBlock(scope) || !ts.isFunctionLike(scope.parent)) return false;
    const cached = stableDeclarations.get(declaration);
    if (cached !== undefined) return cached;

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

    const stable = !hasOtherUse(scope);
    stableDeclarations.set(declaration, stable);
    return stable;
  }

  function factoryFunction(
    symbol: ts.Symbol
  ): ts.ArrowFunction | ts.FunctionDeclaration | undefined {
    const declarations = symbol.declarations;
    if (declarations?.length !== 1) return undefined;
    const declaration = declarations[0];
    if (ts.isFunctionDeclaration(declaration)) {
      return strictCalls &&
        declaration.body &&
        !declaration.asteriskToken &&
        stableLocalFactory(declaration, symbol)
        ? declaration
        : undefined;
    }
    if (
      !ts.isVariableDeclaration(declaration) ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const) ||
      !declaration.initializer
    )
      return undefined;
    const initializer = unwrap(declaration.initializer);
    return ts.isArrowFunction(initializer) ? initializer : undefined;
  }

  function localFactory(expression: ts.Expression): LocalPipelineResolution {
    if (
      !ts.isCallExpression(expression) ||
      !ts.isIdentifier(expression.expression) ||
      (expression.flags & ts.NodeFlags.OptionalChain) !== 0 ||
      expression.arguments.some(ts.isSpreadElement)
    )
      return unknown;
    const symbol = checker.getSymbolAtLocation(expression.expression);
    const initializer = symbol && factoryFunction(symbol);
    if (
      !initializer?.body ||
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

  const resolveBuilder = createPipelineBuilderResolver(checker, unwrap, importedSuperpipe);

  function callable(expression: ts.Expression, seen: Set<ts.Node>): LocalPipelineResolution {
    expression = unwrap(expression);
    const direct = pipeline(expression);
    if (direct.kind === 'named') return direct;
    const built = localFactory(expression);
    if (built.kind === 'named') return built;
    if (strictCalls) {
      const name = resolveBuilder(expression);
      if (name !== undefined) return { kind: 'named', name };
    }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      if (ts.isBlock(expression.body)) {
        const body = expression.body.statements;
        if (
          strictCalls &&
          body.length === 1 &&
          ts.isTryStatement(body[0]) &&
          body[0].tryBlock.statements.length === 1
        ) {
          const [attempt] = body[0].tryBlock.statements;
          if (ts.isReturnStatement(attempt) && attempt.expression)
            return action(attempt.expression, seen);
        }
        const statement = body[0];
        if (
          strictCalls &&
          statement &&
          ts.isVariableStatement(statement) &&
          (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
          statement.declarationList.declarations.length === 1
        ) {
          const { name, initializer } = statement.declarationList.declarations[0];
          return ts.isIdentifier(name) && initializer ? action(initializer, seen) : unknown;
        }
        if (expression.body.statements.length !== 1) return unknown;
        return ts.isReturnStatement(statement) && statement.expression
          ? action(statement.expression, seen)
          : unknown;
      }
      return action(expression.body, seen);
    }
    if (!ts.isIdentifier(expression)) return unknown;
    const binding =
      ts.isShorthandPropertyAssignment(expression.parent) && expression.parent.name === expression
        ? checker.getShorthandAssignmentValueSymbol(expression.parent)
        : checker.getSymbolAtLocation(expression);
    const declarations = binding?.declarations;
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
      (strictCalls && (expression.flags & ts.NodeFlags.OptionalChain) !== 0)
    )
      return unknown;
    const callee = strictCalls ? unwrap(expression.expression) : expression.expression;
    return ts.isIdentifier(callee) ? callable(callee, seen) : unknown;
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
      const handlers = properties.filter(
        ({ name }) =>
          name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'execute'
      );
      const [execute] = handlers;
      const shorthand =
        strictCalls &&
        execute &&
        ts.isShorthandPropertyAssignment(execute) &&
        !properties.some(
          (property) =>
            ts.isSpreadAssignment(property) ||
            (property.name && ts.isComputedPropertyName(property.name))
        );
      if (
        name &&
        ts.isPropertyAssignment(name) &&
        ts.isStringLiteral(name.initializer) &&
        execute &&
        handlers.length === 1 &&
        (ts.isPropertyAssignment(execute) || shorthand)
      ) {
        const handler = ts.isPropertyAssignment(execute)
          ? execute.initializer
          : ts.isShorthandPropertyAssignment(execute)
            ? execute.name
            : null;
        if (!handler) return;
        const nameMatches = matches.get(name.initializer.text) ?? [];
        nameMatches.push(handler);
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
