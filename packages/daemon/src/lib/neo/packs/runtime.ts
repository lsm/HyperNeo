import { publishCodingHumanMerge } from './coding/human-merge-notice.ts';
import { neoPublicationWrites } from '../../../storage/repositories/neo-publication-repository.ts';
import { NEO_DEFAULT_PACKS } from './index.ts';
import { createNeoProjectTreeOperations } from './coding/project-tree-operations.ts';
import { NeoService } from '../service.ts';
import { CodingTodoPrRepository } from './coding/todo-prs.ts';
import { hostname } from 'node:os';
import type { Database } from '../../../storage/sqlite-compat.ts';
import { BUILD_METADATA } from '../../build-metadata.ts';
import { remoteDaemons } from '../../remote-daemons/registry.ts';
import { readNeoDaemonCommits } from '../daemon-commits.ts';
import { createCodingBranchPrReader } from './coding/branch-reader.ts';
import { createCodingMergeReader } from './coding/merge-reader.ts';
import { createCodingAncestryReader } from './coding/ancestry-reader.ts';
import { type NeoDeployReader, readGithubDeploys } from './coding/deploy-checks.ts';
import { createCodingPack } from './coding/pack.ts';
import { CodingAssignmentsRepository } from './coding/assignments.ts';
import { createCodingMergeOperation } from './coding/merge-operation.ts';
import { createCodingSmokeOperation } from './coding/smoke-operation.ts';
import type { NeoWorkPrReader } from './coding/work-prs.ts';
import { createCodingResultOperation } from './coding/result-operation.ts';
import { createCodingAssignmentOperation } from './coding/assign-operation.ts';
import { invokeOperation } from '../../operations/invoke.ts';
import { CodingPrEventRepository } from './coding/pr-events.ts';
import { CodingPrLedgerRepository } from './coding/pr-ledger.ts';
import { CodingPrSweepRepository } from './coding/pr-sweep.ts';
import { createCodingQueryReader } from './coding/query-reader.ts';
import { createCodingRefReader } from './coding/ref-reader.ts';
import { createCodingWorkPrReader } from './coding/work-reader.ts';
import { createCodingReviewThreadReader } from './coding/connector-review-thread-reader.ts';
import { createCodingConnectorPrReader } from './coding/connector-pr-reader.ts';
import { createCodingPrStateReader } from './coding/pr-state-reader.ts';
import { createLifeAdminPack } from './life-admin/pack.ts';
import { createDelegationPack } from './delegation/pack.ts';
import { createCoreTodoPack } from '../core-todo-checks.ts';
import type { DaemonExtension } from '../../extensions/contract.ts';

export function createNeoCodingReaders(db: () => Database) {
  const readMerge = createCodingMergeReader(db);
  const readAncestry = createCodingAncestryReader(db);
  const readPrs = createCodingWorkPrReader(db);
  const readDeploys = (urls: readonly string[], heads?: NeoWorkPrReader) =>
    readGithubDeploys(
      urls,
      () =>
        readNeoDaemonCommits({ name: hostname(), commit: BUILD_METADATA.commit }, remoteDaemons),
      undefined,
      readMerge,
      readAncestry,
      heads
    );
  return {
    readPrState: createCodingPrStateReader(db),
    readConnectorPr: createCodingConnectorPrReader(db),
    readReviewThreads: createCodingReviewThreadReader(db),
    readPrs,
    readBranchPrs: createCodingBranchPrReader(db),
    readRefStates: createCodingRefReader(() => new CodingPrLedgerRepository(db()).refFacts),
    listGithub: createCodingQueryReader(db),
    readDeploys,
    readDeliveryDeploys: ((urls) => readDeploys(urls, readPrs)) as NeoDeployReader,
  };
}

export function createNeoBuiltinPacks(
  db: Database,
  deps: Omit<
    Parameters<typeof createCodingPack>[0],
    'prLedger' | 'prSweep' | 'prEvents' | 'database'
  >
) {
  return {
    coding: createCodingPack({
      ...deps,
      database: () => db,
      prLedger: new CodingPrLedgerRepository(db),
      prSweep: new CodingPrSweepRepository(db),
      prEvents: new CodingPrEventRepository(db),
    }),
    lifeAdmin: createLifeAdminPack(),
    delegation: createDelegationPack(() => db),
  };
}

type NeoServiceArgs =
  ConstructorParameters<typeof NeoService> extends [unknown, ...infer Args] ? Args : never;

export function createNeoService(...args: NeoServiceArgs) {
  const [db] = args;
  const readers = createNeoCodingReaders(() => db.getDatabase());
  const todoPrs = new CodingTodoPrRepository(db.getDatabase());
  const service = new NeoService(
    (core) => {
      const configured = Object.assign(core, readers, { todoPrs });
      const { coding, lifeAdmin, delegation } = createNeoBuiltinPacks(db.getDatabase(), {
        readPrs: (urls) => configured.readPrs(urls),
        readRefStates: (refs) => configured.readRefStates(refs),
        listGithub: (args, coverage) => configured.listGithub(args, coverage),
        todoPrs,
        prSweepDeps: {
          human: (key, text) =>
            publishCodingHumanMerge(
              {
                conversation: () => configured.repo.conversationId(),
                append: (input) =>
                  configured.db.gateway.call(neoPublicationWrites, 'append', input),
                notify: configured.notifyPublicationsChanged,
              },
              key,
              text
            ),
          tell: (ref, key, text, todoId) => configured.sendToRef(ref, key, text, todoId),
          wake: (key, text) => configured.wakeNeo(key, text),
          delivery: {
            recipient: () => configured.defaultSessionId() ?? null,
            status: async (recipient, key) => configured.deliveryStatus(recipient, key),
            send: async (recipient, key, text) => {
              await configured.deliverForward(recipient, key, text, recipient, 'event');
              return true;
            },
          },
        },
        projectRepos: () => configured.repo.allRepositories(),
      });
      coding.operations = [
        ...(coding.operations ?? []),
        createCodingMergeOperation({
          db: db.getDatabase(),
          todos: todoPrs,
          review: coding.review,
          prepareMerge: coding.prepareMerge,
        }),
        createCodingAssignmentOperation({
          db: db.getDatabase(),
          ledger: new CodingPrLedgerRepository(db.getDatabase()),
          todos: todoPrs,
          review: coding.review,
          invoke: (name, input, caller) =>
            invokeOperation(core.sessions.getOperationRegistry(), name, input, caller),
        }),
        createCodingSmokeOperation(
          todoPrs.deliveryFacts,
          new CodingAssignmentsRepository(db.getDatabase()),
          (urls) => configured.readDeliveryDeploys(urls)
        ),
        createCodingResultOperation(
          new CodingAssignmentsRepository(db.getDatabase()),
          new CodingPrLedgerRepository(db.getDatabase())
        ),
      ];
      return {
        packs: [
          coding,
          lifeAdmin,
          delegation,
          createCoreTodoPack(db.getDatabase(), async (repo, sha, build) => {
            const fact = await new CodingPrLedgerRepository(db.getDatabase()).ancestryFacts.refresh(
              {
                repo,
                baseOid: sha,
                headOid: build,
              }
            );
            return fact.ancestry.status === 'known' && fact.ancestry.contains;
          }),
        ],
        defaults: NEO_DEFAULT_PACKS,
        operations: createNeoProjectTreeOperations(core.repo, (refs) =>
          configured.readRefStates(refs)
        ).map((operation) => ({
          ...operation,
          pack: { id: coding.id, enabledIds: core.enabledOperationPackIds },
        })),
      };
    },
    ...args
  );
  return Object.assign(service, readers, { todoPrs });
}

export function neoPacksExtension(service: NeoService): DaemonExtension {
  return {
    id: 'neo-packs',
    schema: (db) => {
      for (const pack of service.builtinPacks) pack.todos?.schema(db);
    },
    operations: () => service.packOperations,
  };
}
