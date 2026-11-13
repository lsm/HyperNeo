# Provider usage

Expose plan quota through one existing operation, with provider-specific parsing behind `Provider`.

## One interface

Add `getUsage?(): Promise<ProviderUsageResult>` to the shared `Provider` interface. Register read-only `settings.provider.usage` beside `settings.model.get` in the settings operation family; callers use `operation.invoke` or agent `invoke` with `{ providerId: "kimi" }`. Reuse the model operation's local-app/Neo caller gate.

```ts
type UsageWindow = {
  label: string;
  used: number;
  limit: number;
  resetAt: string | null;
};
type ProviderUsageResult =
  | { supported: true; provider: string; windows: UsageWindow[] }
  | { supported: false; provider: string; reason: 'not_supported' };
```

A missing provider or one without `getUsage` returns `not_supported`; other providers need no stubs. `resetAt` is an ISO timestamp or null. No cache, polling, UI or additional provider is in scope.

## Kimi adapter

Implement only `KimiProvider.getUsage`. Support the Kimi Coding configuration; the global Moonshot configuration returns `not_supported`.

GET the effective Coding model-list base plus `/usages`; the default is `https://api.kimi.com/coding/v1/usages`. Authorization is `Bearer` plus `getApiKey()`, so the already-hydrated provider uses the existing credential store and its current environment fallback. The operation accepts no key or URL, and keys never enter results, errors or logs.

Map top-level `usage` and each `limits[]` entry into `windows`. Use `used`, or derive it as `limit - remaining`; take labels from `name`/`title`/`scope` or `window.duration`/`timeUnit`; read `reset_at`/`resetAt`/`reset_time`/`resetTime` into `resetAt`. Missing credentials, non-2xx replies and malformed payloads fail without returning response bodies.

## One implementation PR

`feat: expose Kimi usage through provider operations`.

Fail first: `settings.provider.usage returns Kimi windows through operation.invoke` in `packages/daemon/tests/unit/1-core/operations/provider-usage-operation.test.ts`.

Kimi unit tests cover the exact URL and Bearer header, used and remaining forms, 5-hour/7-day labels and reset times, global/unsupported results, missing keys and HTTP failures. Operation tests cover `not_supported` and verify that results contain no credential. Add a verify journey that invokes the real isolated operation against a loopback usage fixture with a synthetic stored key and asserts the normalized windows.

Payload reference: [kimi-cli usage reader](https://github.com/MoonshotAI/kimi-cli/blob/main/src/kimi_cli/ui/shell/usage.py).
