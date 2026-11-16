# Shared rules

For `packages/shared`. The root `AGENTS.md` still applies.

- Vendored `src/sdk/{sdk,sdk-tools}.d.ts` keep their generated `Upstream SDK documentation` comment; refresh it with `make sync-sdk-types`.
- Operation names live in `src/types/operation-names.ts`; `check:operation-names` requires them to match the `defineOperation` names both ways.
