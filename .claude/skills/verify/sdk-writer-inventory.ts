import assert from 'node:assert/strict';
import ts from 'typescript';
import { resolve } from 'node:path';
import { sdkMessageWrites } from '../../../packages/daemon/src/storage/repositories/sdk-message-writes.ts';

const configFile = ts.readConfigFile('packages/daemon/tsconfig.json', ts.sys.readFile);
const config = ts.parseJsonConfigFileContent(configFile.config, ts.sys, resolve('packages/daemon'));
const program = ts.createProgram(config.fileNames, config.options);
const checker = program.getTypeChecker();
const writers = new Set<string>(sdkMessageWrites.methods);
const units: Record<string, string[] | true> = {
  'storage/repositories/sdk-message-repository.ts': true,
  'storage/repositories/sdk-message-transactions.ts': true,
  'lib/agent/message-delivery-outbox.ts': ['commitRetryPrompt'],
  'lib/mailbox/cancellation.ts': ['persistSessionDeliveryTeardown'],
  'lib/mailbox/failure.ts': ['persistExistingMailboxFailure', 'persistMailboxFailure'],
};
const sqlUnits: Record<string, string[] | true> = {
  'storage/repositories/sdk-message-repository.ts': true,
  'storage/repositories/job-queue-repository.ts': ['transitionDeliverySendStatusFencedSync'],
  'storage/repositories/sdk-message-body-write.ts': true,
  'storage/repositories/sdk-message-status-plan.ts': true,
  'storage/sdk-message-body-copy.ts': true,
  'storage/schema/migrations.ts': true,
  'storage/schema/m395-neo-archive-holders.ts': ['runMigration395'],
  'storage/schema/m413-sdk-message-columns.ts': ['backfillSdkMessageColumnsChunk'],
  'lib/agent/message-delivery-outbox.ts': true,
};
const kernelCalls: string[] = [];
const sqlKernels = new Set<string>();
const violations: string[] = [];
for (const source of program.getSourceFiles()) {
  const file = source.fileName.split('/packages/daemon/src/')[1];
  if (!file) continue;
  function visit(node: ts.Node) {
    if (ts.isPropertyAccessExpression(node) && writers.has(node.name.text)) {
      const type = checker.getTypeAtLocation(node.expression);
      if (type.getSymbol()?.getName() === 'SDKMessageRepository') {
        let owner = '';
        for (let parent = node.parent; parent; parent = parent.parent) {
          if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name) { owner = parent.name.getText(); break; }
        }
        const unit = units[file];
        const { line } = source.getLineAndCharacterOfPosition(node.getStart());
        const location = `${file}:${line + 1} ${owner}.${node.name.text}`;
        if (unit === true || unit?.includes(owner)) kernelCalls.push(location);
        else violations.push(location);
      }
    }
    if ((ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) && /(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+sdk_messages\b/i.test(node.getText())) {
      let owner = '';
      for (let parent = node.parent; parent; parent = parent.parent) {
        if ((ts.isFunctionDeclaration(parent) || ts.isMethodDeclaration(parent)) && parent.name) { owner = parent.name.getText(); break; }
      }
      const unit = sqlUnits[file];
      if (unit === true || unit?.includes(owner)) sqlKernels.add(`${file} ${owner}`);
      else violations.push(`${file} ${owner}: raw SDK mutation SQL`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
}
assert(kernelCalls.length > 10, 'the typed inventory must resolve the SDK repository');
assert.deepEqual(violations, [], `raw live SDK writers: ${violations.join(', ')}`);
console.log(JSON.stringify({ pass: true, registeredWriters: writers.size, kernelCalls, sqlKernels: [...sqlKernels], violations }, null, 2));
