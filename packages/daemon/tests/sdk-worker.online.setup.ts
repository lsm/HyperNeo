import { vi } from 'vitest';
import { SDKBunWorkerBridge, sdkBodyAdmissionGate } from './helpers/sdk-bun-worker-bridge';

vi.mock('../src/storage/sdk-status-reader.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/storage/sdk-status-reader.ts')>();
  return {
    ...actual,
    SDKStatusReader: class extends actual.SDKStatusReader {
      constructor(...args: ConstructorParameters<typeof actual.SDKStatusReader>) {
        super(
          args[0],
          args[1] ??
            (() =>
              new SDKBunWorkerBridge(
                new URL('../src/storage/sdk-status-worker.ts', import.meta.url).href
              ) as unknown as Worker),
          args[2],
          args[3]
        );
      }
    },
  };
});

vi.mock('../src/storage/sdk-message-body-admission.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/storage/sdk-message-body-admission.ts')>();
  return {
    ...actual,
    startSdkBodyWriteAdmission: (...args: Parameters<typeof actual.startSdkBodyWriteAdmission>) =>
      actual.startSdkBodyWriteAdmission(
        args[0],
        args[1],
        args[2],
        () =>
          new SDKBunWorkerBridge(
            new URL('../src/storage/sdk-message-body-admission-worker.ts', import.meta.url).href,
            sdkBodyAdmissionGate()
          ) as unknown as Worker
      ),
  };
});
