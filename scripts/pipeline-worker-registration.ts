import { posix } from 'node:path';
import ts from 'typescript';

type SourceOf = (file: string) => string | undefined;
type ImportRef = { file: string; name: string };

export function valueImport(file: string, specifier: ts.ImportSpecifier): ImportRef | undefined {
  const clause = specifier.parent.parent;
  const { moduleSpecifier } = clause.parent;
  if (
    specifier.isTypeOnly ||
    clause.isTypeOnly ||
    !ts.isStringLiteral(moduleSpecifier) ||
    !/^\.\.?\/[^\\?#]+\.tsx?$/.test(moduleSpecifier.text)
  )
    return undefined;
  return {
    file: posix.normalize(posix.join(posix.dirname(file), moduleSpecifier.text)),
    name: (specifier.propertyName ?? specifier.name).text,
  };
}

const gatewayDirectory = 'packages/daemon/src/storage/db-gateway';
export const dbGatewayFile = `${gatewayDirectory}/db-gateway.ts`;

function namedConstant(source: ts.SourceFile, name: string) {
  const found = source.statements
    .filter(ts.isVariableStatement)
    .filter((node) => (node.declarationList.flags & ts.NodeFlags.Const) !== 0)
    .flatMap((node) => [...node.declarationList.declarations])
    .filter((node) => ts.isIdentifier(node.name) && node.name.text === name);
  if (found.length !== 1) return undefined;
  const [declaration] = found;
  const statement = declaration.parent.parent;
  return ts.isVariableStatement(statement) &&
    statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ? declaration.initializer
    : undefined;
}

function parse(sourceOf: SourceOf, file: string) {
  const source = sourceOf(file);
  return source === undefined
    ? undefined
    : ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}

function namedImports(file: string, source: ts.SourceFile) {
  return source.statements
    .filter(ts.isImportDeclaration)
    .flatMap((node) => {
      const bindings = node.importClause?.namedBindings;
      return bindings && ts.isNamedImports(bindings) ? [...bindings.elements] : [];
    })
    .map((node) => [node.name.text, valueImport(file, node)] as const);
}

function isRegistrationList(expression: ts.Expression | undefined) {
  if (
    !expression ||
    !ts.isNewExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== 'Map' ||
    expression.arguments?.length !== 1
  )
    return undefined;
  const [map] = expression.arguments;
  if (
    !ts.isCallExpression(map) ||
    (map.flags & ts.NodeFlags.OptionalChain) !== 0 ||
    !ts.isPropertyAccessExpression(map.expression) ||
    map.expression.name.text !== 'map' ||
    !ts.isArrayLiteralExpression(map.expression.expression) ||
    map.arguments.length !== 1
  )
    return undefined;
  const [project] = map.arguments;
  if (
    !ts.isArrowFunction(project) ||
    project.parameters.length !== 1 ||
    !ts.isIdentifier(project.parameters[0].name) ||
    !ts.isArrayLiteralExpression(project.body) ||
    project.body.elements.length !== 2
  )
    return undefined;
  const parameter = project.parameters[0].name.text;
  const [key, value] = project.body.elements;
  if (
    !ts.isIdentifier(value) ||
    value.text !== parameter ||
    !ts.isPropertyAccessExpression(key) ||
    key.name.text !== 'name' ||
    !ts.isIdentifier(key.expression) ||
    key.expression.text !== parameter
  )
    return undefined;
  const { elements } = map.expression.expression;
  const identifiers = elements.filter(ts.isIdentifier);
  return identifiers.length === elements.length
    ? identifiers.map((element) => element.text)
    : undefined;
}

function registeredCall(command: ImportRef, source: ts.SourceFile) {
  const registration = namedConstant(source, command.name);
  if (
    !registration ||
    !ts.isCallExpression(registration) ||
    (registration.flags & ts.NodeFlags.OptionalChain) !== 0 ||
    !ts.isIdentifier(registration.expression)
  )
    return undefined;
  const callee = registration.expression.text;
  const maker = namedImports(command.file, source).filter(([local]) => local === callee);
  return maker.length === 1 && maker[0][1]?.file === `${gatewayDirectory}/db-op.ts`
    ? { maker: maker[0][1].name, args: registration.arguments }
    : undefined;
}

function registrationKey(command: ImportRef, sourceOf: SourceOf) {
  const source = parse(sourceOf, command.file);
  const call = source && registeredCall(command, source);
  const argument = call?.args[0];
  if (!call || !argument) return undefined;
  if (call.maker === 'defineRepositoryOp' && ts.isStringLiteral(argument)) return argument.text;
  if (call.maker !== 'defineDbOp' || !ts.isObjectLiteralExpression(argument)) return undefined;
  if (
    argument.properties.some(
      (property) =>
        ts.isSpreadAssignment(property) ||
        (property.name && ts.isComputedPropertyName(property.name))
    )
  )
    return undefined;
  const keys = argument.properties.filter(
    ({ name }) =>
      name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === 'name'
  );
  const [key] = keys;
  return keys.length === 1 && ts.isPropertyAssignment(key) && ts.isStringLiteral(key.initializer)
    ? key.initializer.text
    : undefined;
}

export function registeredRepositoryMethod(command: ImportRef, method: string, sourceOf: SourceOf) {
  const file = `${gatewayDirectory}/db-ops.ts`;
  const registry = parse(sourceOf, file);
  const source = parse(sourceOf, command.file);
  if (!registry || !source) return undefined;
  const registrations = isRegistrationList(namedConstant(registry, 'DB_OPS'));
  if (!registrations) return undefined;
  const imports = namedImports(file, registry);
  const registered = imports.filter(
    ([local, ref]) =>
      ref?.file === command.file && ref.name === command.name && registrations.includes(local)
  );
  if (
    registered.length !== 1 ||
    registrations.filter((local) => local === registered[0][0]).length !== 1
  )
    return undefined;
  const registration = registeredCall(command, source);
  if (registration?.maker !== 'defineRepositoryOp' || registration.args.length !== 4)
    return undefined;
  const [name, mode, repository, methods] = registration.args;
  if (
    !ts.isStringLiteral(name) ||
    !ts.isStringLiteral(mode) ||
    !['read', 'write'].includes(mode.text) ||
    !ts.isIdentifier(repository) ||
    !ts.isArrayLiteralExpression(methods)
  )
    return undefined;
  const later = registrations.slice(registrations.indexOf(registered[0][0]) + 1);
  const references = new Map(imports);
  if (
    later.some((local) => {
      const ref = references.get(local);
      const key = ref && registrationKey(ref, sourceOf);
      return key === undefined || key === name.text;
    })
  )
    return undefined;
  const literals = methods.elements.filter(ts.isStringLiteral);
  return literals.length === methods.elements.length &&
    literals.filter((element) => element.text === method).length === 1
    ? repository.text
    : undefined;
}
