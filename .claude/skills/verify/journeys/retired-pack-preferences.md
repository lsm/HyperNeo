# Retired pack preferences

On the checked-out revision, use an isolated test environment and synthetic databases:

```sh
cd packages/daemon
NODE_ENV=test bun test tests/unit/1-core/operations/pack-preferences.test.ts tests/unit/4-space-storage/storage/work-free-workers.test.ts
```

The operation test seeds a retired setting and checks that get and list hide it.
The migration test reruns the upgrade against synthetic rows and checks that only
coding session strategy rows disappear while copied core settings remain.
