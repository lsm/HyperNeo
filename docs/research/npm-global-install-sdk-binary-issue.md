# npm Global Install: SDK Binary Resolution

## Problem

Starting with `@anthropic-ai/claude-agent-sdk@0.2.141`, the SDK no longer ships `cli.js`. Instead, the Claude Code binary is distributed via platform-specific optional packages:

- `@anthropic-ai/claude-agent-sdk-linux-x64`
- `@anthropic-ai/claude-agent-sdk-darwin-arm64`
- etc.

When HyperNeo is installed globally (`npm install -g hyperneo`), the SDK binary is not available at startup. The previous resolution path only triggered on first user query, causing a noticeable delay (download + extraction of ~200 MB binary).

## Solution: Startup Warmup

HyperNeo now resolves/downloads the SDK binary at daemon startup via `warmupSDKCliBinary()` in `packages/daemon/src/lib/agent/sdk-cli-resolver.ts`.

### Resolution Priority

1. **node_modules** — binary already installed (dev mode, or global install with optional deps)
2. **Cache** (`~/.hyperneo/sdk/claude-<version>-<platform>/claude`) — previously downloaded
3. **Download** — fetch platform package from npm registry, verify integrity (SHA-512), extract binary

### Behavior

- Warmup runs after the HTTP/WS server binds, deferred via `setTimeout` to the next event loop tick.
- Non-fatal: daemon continues if download fails.
- `resolveSDKCliPath()` retries on first query if warmup failed.
- Warmup doesn't set negative cache — query path can still succeed later.
- Mutex prevents race between warmup and first query.

### Logging

Startup logs always visible (not gated by `HYPERNEO_VERBOSE`):

```
[SDK] Resolving Claude Code binary for @anthropic-ai/claude-agent-sdk-linux-x64 (SDK 0.2.141)
[SDK] Claude Code binary ready from cache: ~/.hyperneo/sdk/claude-0.2.141-linux-x64/claude (190.7 MB)
```

Or on first download:

```
[SDK] Resolving Claude Code binary for @anthropic-ai/claude-agent-sdk-linux-x64 (SDK 0.2.141)
[SDK] Downloading @anthropic-ai/claude-agent-sdk-linux-x64@0.2.141...
[SDK] Claude Code binary ready: ~/.hyperneo/sdk/claude-0.2.141-linux-x64/claude (199.9 MB)
```

## Container/Docker Guidance

Mount a persistent volume at `~/.hyperneo/sdk/` to cache the binary across container restarts:

```dockerfile
# In Dockerfile, after npm install -g hyperneo:
# The SDK binary is downloaded on first daemon startup and cached.
# To avoid download on every container start, mount a volume:
VOLUME /root/.hyperneo/sdk
```

Alternatively, pre-populate the cache in the image by running the daemon once:

```dockerfile
# Start daemon briefly to trigger SDK binary download, then stop it.
# Timeout must exceed resolver worst case: 15s (metadata) + 120s (download) + overhead.
RUN timeout 180 hyperneo --port 9999 || true
```

The binary will be cached at `~/.hyperneo/sdk/claude-<version>-<platform>/claude` for subsequent starts.
