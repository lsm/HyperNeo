import ts from 'typescript';
import {
  confinedWorkerRegistration,
  dbGatewayFile,
  registeredRepositoryMethod,
  registeredDbOp,
  valueImport,
} from './pipeline-worker-registration.ts';
import { createPipelineBuilderResolver } from './pipeline-builder-factory.ts';
import { serializedPipelineCallback } from './pipeline-serial-callback.ts';

export type LocalPipelineResolution =
  | { kind: 'named'; name: string; terminal?: boolean }
  | { kind: 'unknown' };

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

function recoveryWithoutPipeline(
  node: ts.Node,
  resolveCall?: (call: ts.CallExpression) => boolean
): boolean {
  if (ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)) return false;
  if (ts.isCallExpression(node) && !resolveCall?.(node)) return false;
  return !ts.forEachChild(
    node,
    (child) => !recoveryWithoutPipeline(child, resolveCall) || undefined
  );
}

export function directTryReturn(
  statement: ts.TryStatement,
  resolveCall?: (call: ts.CallExpression) => boolean
): ts.ReturnStatement | undefined {
  const [attempt] = statement.tryBlock.statements;
  if (
    statement.tryBlock.statements.length === 1 &&
    ts.isReturnStatement(attempt) &&
    !statement.finallyBlock?.statements.length &&
    (!statement.catchClause || recoveryWithoutPipeline(statement.catchClause, resolveCall))
  )
    return attempt;
}

const unknown: LocalPipelineResolution = { kind: 'unknown' };

export function createLocalPipelineResolver(
  source: string,
  fileName = 'route.ts',
  strictCalls = false,
  sources?: ReadonlyMap<string, string> | ((file: string) => string | undefined)
): ((operationName: string) => LocalPipelineResolution) & {
  exportedFactory(name: string, arity: number): LocalPipelineResolution;
  repositoryMethod(
    repository: string,
    method: string,
    registrationOffset: number
  ): LocalPipelineResolution;
  exportedRunner(name: string): LocalPipelineResolution;
} {
  const sourceOf = typeof sources === 'function' ? sources : sources?.get.bind(sources);
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
    if (
      !ts.isCallExpression(current) ||
      !ts.isPropertyAccessExpression(current.expression) ||
      (strictCalls && (current.flags & ts.NodeFlags.OptionalChain) !== 0)
    )
      return unknown;
    if (!['end', 'endAsync'].includes(current.expression.name.text)) return unknown;
    current = unwrap(current.expression.expression);
    while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
      if (
        !['input', 'pipe'].includes(current.expression.name.text) ||
        (strictCalls && (current.flags & ts.NodeFlags.OptionalChain) !== 0)
      )
        return unknown;
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

  function resolveRecoveryCall(call: ts.CallExpression, seen: ReadonlySet<ts.Node>): boolean {
    const callee = unwrap(call.expression);
    if (!ts.isIdentifier(callee)) return false;
    const declarations = checker.getSymbolAtLocation(callee)?.declarations;
    const declaration = declarations?.length === 1 ? declarations[0] : undefined;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const) ||
      !declaration.initializer ||
      seen.has(declaration)
    )
      return false;
    const initializer = unwrap(declaration.initializer);
    const visited = new Set([...seen, declaration]);
    return (
      (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
      recoveryWithoutPipeline(initializer, (nested) => resolveRecoveryCall(nested, visited))
    );
  }

  function callable(expression: ts.Expression, seen: Set<ts.Node>): LocalPipelineResolution {
    expression = unwrap(expression);
    const direct = pipeline(expression);
    if (direct.kind === 'named') return direct;
    const imported = importedFactory(expression);
    if (imported.kind === 'named') return imported;
    const built = localFactory(expression);
    if (built.kind === 'named') return built;
    if (strictCalls) {
      const name = resolveBuilder(expression);
      if (name !== undefined) return { kind: 'named', name };
    }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      if (ts.isBlock(expression.body)) {
        const body = expression.body.statements;
        const statement = body[0];
        if (strictCalls && body.length === 1 && ts.isTryStatement(statement)) {
          const attempt = directTryReturn(statement, (call) =>
            resolveRecoveryCall(call, new Set())
          );
          return attempt?.expression ? action(attempt.expression, seen) : unknown;
        }
        if (
          strictCalls &&
          statement &&
          body.length === 2 &&
          ts.isVariableStatement(statement) &&
          (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
          statement.declarationList.declarations.length === 1
        ) {
          const { name, initializer } = statement.declarationList.declarations[0];
          const projection = body[1];
          return ts.isIdentifier(name) &&
            initializer &&
            ts.isReturnStatement(projection) &&
            recoveryWithoutPipeline(projection, (call) => resolveRecoveryCall(call, new Set()))
            ? action(initializer, seen)
            : unknown;
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

  function importedReference(identifier: ts.Identifier) {
    const declarations = checker.getSymbolAtLocation(identifier)?.declarations;
    const specifier = declarations?.length === 1 ? declarations[0] : undefined;
    return specifier && ts.isImportSpecifier(specifier)
      ? valueImport(fileName, specifier)
      : undefined;
  }

  function gatewayCall(call: ts.CallExpression): LocalPipelineResolution {
    const callee = unwrap(call.expression);
    const [command, method] = call.arguments;
    if (
      !sourceOf ||
      !strictCalls ||
      !ts.isPropertyAccessExpression(callee) ||
      !['call', 'run'].includes(callee.name.text) ||
      (callee.name.text === 'run' && call.arguments.length !== 2) ||
      !command ||
      !ts.isIdentifier(command) ||
      (callee.name.text === 'call' && (!method || !ts.isStringLiteral(method))) ||
      call.arguments.some(ts.isSpreadElement)
    )
      return unknown;
    const receiver = unwrap(callee.expression);
    if (
      !ts.isCallExpression(receiver) ||
      !ts.isIdentifier(receiver.expression) ||
      (receiver.flags & ts.NodeFlags.OptionalChain) !== 0 ||
      receiver.arguments.length !== 1 ||
      ts.isSpreadElement(receiver.arguments[0])
    )
      return unknown;
    const helper = importedReference(receiver.expression);
    if (helper?.file !== dbGatewayFile || helper.name !== 'gatewayFor') return unknown;
    const target = importedReference(command);
    if (!target || !sources || typeof sources === 'function') return unknown;
    if (!confinedWorkerRegistration(sources, fileName, target)) return unknown;
    if (callee.name.text === 'run') {
      const name = registeredDbOp(target, sourceOf);
      return name === undefined ? unknown : { kind: 'named', name, terminal: true };
    }
    if (!method || !ts.isStringLiteral(method)) return unknown;
    const repository = registeredRepositoryMethod(target, method.text, sourceOf);
    const source = repository ? sourceOf(target.file) : undefined;
    if (!repository || source === undefined) return unknown;
    return createLocalPipelineResolver(source, target.file, true, sourceOf).repositoryMethod(
      repository.name,
      method.text,
      repository.registrationOffset
    );
  }

  function returnedMethod(call: ts.CallExpression, seen: Set<ts.Node>): LocalPipelineResolution {
    const access = unwrap(call.expression);
    if (
      !call.arguments.every((argument) => {
        if (!ts.isIdentifier(argument)) return false;
        const declarations = checker.getSymbolAtLocation(argument)?.declarations;
        return (
          declarations?.length === 1 &&
          (ts.isParameter(declarations[0]) || ts.isVariableDeclaration(declarations[0]))
        );
      }) ||
      !ts.isPropertyAccessExpression(access) ||
      (access.flags & ts.NodeFlags.OptionalChain) !== 0
    )
      return unknown;
    const create = unwrap(access.expression);
    if (
      !ts.isCallExpression(create) ||
      (create.flags & ts.NodeFlags.OptionalChain) !== 0 ||
      create.arguments.length !== 0 ||
      !ts.isIdentifier(create.expression)
    )
      return unknown;
    const declarations = checker.getSymbolAtLocation(create.expression)?.declarations;
    const declaration = declarations?.length === 1 ? declarations[0] : undefined;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      (declaration.parent.flags & ts.NodeFlags.BlockScoped) !== ts.NodeFlags.Const ||
      !declaration.initializer ||
      seen.has(declaration)
    )
      return unknown;
    const factory = unwrap(declaration.initializer);
    if (
      !ts.isArrowFunction(factory) ||
      factory.parameters.length !== 0 ||
      factory.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword)
    )
      return unknown;
    const body = factory.body;
    const statement = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : null;
    const returned = ts.isBlock(body)
      ? statement && ts.isReturnStatement(statement) && statement.expression
      : body;
    if (!returned) return unknown;
    const object = unwrap(returned);
    if (
      !ts.isObjectLiteralExpression(object) ||
      object.properties.length !== 1 ||
      object.properties.some(
        (property) =>
          ts.isSpreadAssignment(property) ||
          (property.name && ts.isComputedPropertyName(property.name))
      )
    )
      return unknown;
    const properties = object.properties.filter(
      (property) =>
        property.name &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === access.name.text
    );
    if (properties.length !== 1 || !ts.isPropertyAssignment(properties[0])) return unknown;
    const method = unwrap(properties[0].initializer);
    if (
      !ts.isArrowFunction(method) ||
      method.parameters.length !== call.arguments.length ||
      method.parameters.some(
        (parameter) =>
          !ts.isIdentifier(parameter.name) ||
          parameter.initializer ||
          parameter.dotDotDotToken ||
          parameter.questionToken
      )
    )
      return unknown;
    seen.add(declaration);
    return callable(method, seen);
  }

  function action(expression: ts.Expression, seen: Set<ts.Node>): LocalPipelineResolution {
    expression = unwrap(expression);
    if (ts.isAwaitExpression(expression)) return action(expression.expression, seen);
    if (
      !ts.isCallExpression(expression) ||
      (strictCalls && (expression.flags & ts.NodeFlags.OptionalChain) !== 0)
    )
      return unknown;
    const serialized = strictCalls ? serializedPipelineCallback(expression, checker) : undefined;
    if (serialized) {
      const { callback, declaration } = serialized;
      if (seen.has(declaration)) return unknown;
      seen.add(declaration);
      return callable(callback, seen);
    }
    const callee = strictCalls ? unwrap(expression.expression) : expression.expression;
    if (ts.isIdentifier(callee)) return callable(callee, seen);
    if (!strictCalls) return unknown;
    const inline = pipeline(callee);
    if (inline.kind === 'named') return inline;
    const method = returnedMethod(expression, seen);
    return method.kind === 'named' ? method : gatewayCall(expression);
  }

  const matches = new Map<string, ts.Expression[]>();

  const importedFiles = new Map<string, ReturnType<typeof createLocalPipelineResolver>>();
  function importedFactory(expression: ts.Expression): LocalPipelineResolution {
    if (
      !sourceOf ||
      !strictCalls ||
      !ts.isCallExpression(expression) ||
      (expression.flags & ts.NodeFlags.OptionalChain) !== 0 ||
      expression.arguments.some(ts.isSpreadElement) ||
      !ts.isIdentifier(expression.expression)
    )
      return unknown;
    const ref = importedReference(expression.expression);
    if (!ref || ref.file.startsWith('../') || ref.file.startsWith('/')) return unknown;
    const target = ref.file;
    let resolver = importedFiles.get(target);
    if (!resolver) {
      const text = sourceOf(target);
      if (text === undefined) return unknown;
      resolver = createLocalPipelineResolver(text, target, true);
      importedFiles.set(target, resolver);
    }
    return resolver.exportedFactory(ref.name, expression.arguments.length);
  }

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
      const ambiguousProperties =
        strictCalls &&
        properties.some(
          (property) =>
            ts.isSpreadAssignment(property) ||
            (property.name && ts.isComputedPropertyName(property.name))
        );
      const handler =
        execute && ts.isPropertyAssignment(execute)
          ? execute.initializer
          : strictCalls && execute && ts.isShorthandPropertyAssignment(execute)
            ? execute.name
            : undefined;
      if (
        handler &&
        !ambiguousProperties &&
        handlers.length === 1 &&
        name &&
        ts.isPropertyAssignment(name) &&
        ts.isStringLiteral(name.initializer)
      ) {
        const nameMatches = matches.get(name.initializer.text) ?? [];
        nameMatches.push(handler);
        matches.set(name.initializer.text, nameMatches);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  function exportedFactory(name: string, arity: number): LocalPipelineResolution {
    const statements = parsed.statements.filter(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name
    );
    if (statements.length !== 1) return unknown;
    const [decl] = statements;
    if (
      !decl.body ||
      decl.body.statements.length !== 1 ||
      decl.asteriskToken ||
      decl.parameters.length !== arity ||
      !decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ||
      decl.modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ||
      decl.parameters.some((p) => !ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken)
    )
      return unknown;
    const declarationName = decl.name!;
    const binding = checker.getSymbolAtLocation(declarationName);
    if (!binding || binding.declarations?.length !== 1) return unknown;
    function hasOtherUse(node: ts.Node): boolean {
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (ts.isIdentifier(callee) && callee.text === 'eval') return true;
      }
      if (ts.isIdentifier(node) && node !== declarationName && node.text === name) {
        const parent = node.parent;
        const value = ts.isShorthandPropertyAssignment(parent)
          ? checker.getShorthandAssignmentValueSymbol(parent)
          : checker.getSymbolAtLocation(node);
        if (value === binding && !(ts.isCallExpression(parent) && parent.expression === node))
          return true;
      }
      return ts.forEachChild(node, (child) => (hasOtherUse(child) ? true : undefined)) === true;
    }
    if (hasOtherUse(parsed)) return unknown;
    const [statement] = decl.body.statements;
    return ts.isReturnStatement(statement) && statement.expression
      ? pipeline(statement.expression)
      : unknown;
  }

  function repositoryMethod(
    repository: string,
    method: string,
    registrationOffset: number
  ): LocalPipelineResolution {
    const classes = parsed.statements.filter(
      (node): node is ts.ClassDeclaration =>
        ts.isClassDeclaration(node) && node.name?.text === repository
    );
    if (classes.length !== 1) return unknown;
    const [declaration] = classes;
    if (
      ts.getDecorators(declaration)?.length ||
      declaration.heritageClauses?.length ||
      declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    )
      return unknown;
    function usesClass(node: ts.Node): boolean {
      if (ts.isIdentifier(node) && node.text === repository)
        return node !== declaration.name && node.getStart(parsed) !== registrationOffset;
      return ts.forEachChild(node, (child) => usesClass(child) || undefined) === true;
    }
    if (usesClass(parsed)) return unknown;
    if (
      declaration.members.some(
        (member) =>
          !ts.isMethodDeclaration(member) &&
          !(ts.isConstructorDeclaration(member) && member.body?.statements.length === 0)
      )
    )
      return unknown;
    if (declaration.members.some((member) => member.name && ts.isComputedPropertyName(member.name)))
      return unknown;
    const candidates = declaration.members.filter(
      (member) =>
        member.name &&
        (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) &&
        member.name.text === method
    );
    if (candidates.length !== 1) return unknown;
    const [candidate] = candidates;
    if (
      !ts.isMethodDeclaration(candidate) ||
      candidate.asteriskToken ||
      ts.getDecorators(candidate)?.length ||
      candidate.parameters.some(
        (parameter) =>
          parameter.initializer ||
          !ts.isIdentifier(parameter.name) ||
          ts.getDecorators(parameter)?.length
      ) ||
      candidate.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.StaticKeyword || m.kind === ts.SyntaxKind.AsyncKeyword
      ) ||
      candidate.body?.statements.length !== 1
    )
      return unknown;
    const [statement] = candidate.body.statements;
    if (!ts.isReturnStatement(statement) || !statement.expression) return unknown;
    const returned = unwrap(statement.expression);
    if (
      !ts.isCallExpression(returned) ||
      !ts.isIdentifier(returned.expression) ||
      (returned.flags & ts.NodeFlags.OptionalChain) !== 0 ||
      returned.arguments.some((argument) => {
        if (!ts.isIdentifier(argument)) return true;
        const binding = checker.getSymbolAtLocation(argument);
        return (
          !binding ||
          !candidate.parameters.some(
            (parameter) =>
              ts.isIdentifier(parameter.name) &&
              checker.getSymbolAtLocation(parameter.name) === binding
          )
        );
      })
    )
      return unknown;
    const ref = importedReference(returned.expression);
    const source = ref ? sourceOf?.(ref.file) : undefined;
    if (!ref || source === undefined) return unknown;
    return createLocalPipelineResolver(source, ref.file, true).exportedRunner(ref.name);
  }

  function exportedRunner(name: string): LocalPipelineResolution {
    const statements = parsed.statements
      .filter(ts.isVariableStatement)
      .filter((statement) =>
        statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      )
      .flatMap((statement) => [...statement.declarationList.declarations])
      .filter((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === name);
    if (statements.length !== 1) return unknown;
    const [declaration] = statements;
    return (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && declaration.initializer
      ? pipeline(declaration.initializer)
      : unknown;
  }

  return Object.assign(
    (operationName: string) => {
      const found = matches.get(operationName);
      return found?.length === 1 ? callable(found[0], new Set()) : unknown;
    },
    { exportedFactory, repositoryMethod, exportedRunner }
  );
}
