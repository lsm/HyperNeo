.PHONY: dev serve-random self self-test run run-e2e build test test-daemon test-daemon-shard test-web test-shared e2e e2e-ui lint lint-fix format strip-comments typecheck check compile compile-all package-npm release release-prepare sync-sdk-types setup-hooks setup test-proxy-start test-proxy-stop test-proxy-status test-proxy-restart desktop-dev desktop-build desktop-build-sidecar

# Development server - uses random available port by default
# Usage: make dev
#        make dev PORT=8080
#        make dev DB_PATH=/tmp/mydb.db           # isolated DB (avoids lock conflicts)
#        make dev PORT=8080 DB_PATH=/tmp/mydb.db
dev:
	@mkdir -p tmp
	@if [ -n "$(PORT)" ]; then \
		PORT=$(PORT); \
		echo "$(PORT)" > tmp/.dev-server-running; \
	else \
		echo "Finding available port..."; \
		PORT=$$(node -e "const net = require('net'); const s = net.createServer(); s.listen(0, () => { console.log(s.address().port); s.close(); });"); \
	fi; \
	if [ -n "$(DB_PATH)" ]; then DB_FLAGS="--db-path $(DB_PATH)"; else DB_FLAGS=""; fi; \
	echo "Starting development server on port $$PORT..."; \
	echo ""; \
	echo "================================================"; \
	echo "🚀 Development server starting on http://localhost:$$PORT"; \
	if [ -n "$(DB_PATH)" ]; then echo "   Database: $(DB_PATH)"; fi; \
	echo "================================================"; \
	echo ""; \
	NODE_ENV=development HYPERNEO_PORT=$$PORT bun run packages/cli/main.ts --port $$PORT $$DB_FLAGS

# Alias for dev-random (deprecated, use make dev)
dev-random:
	@$(MAKE) dev

# Production server on random port - starts production build on available port
# Usage: make serve-random
serve-random:
	@PORT=$$(node -e "const net = require('net'); const server = net.createServer(); server.listen(0, () => { const port = server.address().port; console.log(port); server.close(); });"); \
	echo "Running with PORT=$$PORT"; \
	$(MAKE) run PORT=$$PORT

# Self-developing mode - production build on port 9983
self:
	@HYPERNEO_SELF_MODE=1 $(MAKE) run PORT=9983

# Run E2E tests against the `make self` instance (requires `make self` to be running)
# Usage: make self-test TEST=tests/core/navigation-3-column.e2e.ts
#        make self-test (runs all tests)
self-test:
	@PLAYWRIGHT_BASE_URL=http://localhost:9983 cd packages/e2e && bunx playwright test $(TEST)

# Run production server
# Usage: make run [PORT=8080] [DB_PATH=/tmp/mydb.db]
run:
	@mkdir -p tmp
	@if [ -n "$(PORT)" ]; then \
		echo "$(PORT)" > tmp/.prod-server-running; \
	fi
	@echo "Starting production server..."
	@if [ -n "$(PORT)" ]; then \
		echo "   Listening on port $(PORT)"; \
	fi
	@$(MAKE) build
	@DB_FLAGS=""; if [ -n "$(DB_PATH)" ]; then DB_FLAGS="--db-path $(DB_PATH)"; fi; \
	if [ -n "$(PORT)" ]; then \
		NODE_ENV=production bun run packages/cli/main.ts --port $(PORT) $$DB_FLAGS; \
	else \
		NODE_ENV=production bun run packages/cli/main.ts $$DB_FLAGS; \
	fi

# Run E2E tests with an auto-started server on a random port (self-contained, no server needed)
# Usage: make run-e2e TEST=tests/features/slash-cmd.e2e.ts
#        make run-e2e (runs all tests)
run-e2e:
	@PORT=$$(node -e "const net = require('net'); const s = net.createServer(); s.listen(0, () => { console.log(s.address().port); s.close(); });"); \
	echo "Running E2E tests on random port $$PORT..."; \
	cd packages/e2e && E2E_PORT=$$PORT bunx playwright test $(TEST)

build:
	@echo "📦 Building web production bundle..."
	@cd packages/web && bun run build

test: test-daemon test-web

test-daemon:
	@./scripts/test-daemon.sh --coverage

test-daemon-shard:
	@./scripts/test-daemon.sh $(SHARD) --coverage

test-web:
	@echo "Running web tests..."
	@cd packages/web && bun run coverage

lint:
	@bun run lint

lint-fix:
	@bun run lint:fix

format:
	@bun run strip-comments && bun run format

strip-comments:
	@bun run strip-comments

typecheck:
	@bun run typecheck

check:
	@bun run check

# Build compiled binary for current platform
compile:
	@bun run scripts/build-binary.ts --target bun-$(shell uname -s | tr '[:upper:]' '[:lower:]')-$(shell uname -m | sed 's/aarch64/arm64/' | sed 's/x86_64/x64/')

# Build compiled binaries for all platforms (cross-compilation)
compile-all:
	@bun run scripts/build-binary.ts

# Package npm packages from compiled binaries
package-npm:
	@bun run scripts/package-npm.ts

# Sync SDK type definitions from installed package to shared types
sync-sdk-types:
	@echo "Syncing Claude SDK type definitions..."
	@mkdir -p packages/shared/src/sdk
	@cp packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts packages/shared/src/sdk/
	@cp packages/daemon/node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts packages/shared/src/sdk/
	@echo "SDK types synced to packages/shared/src/sdk/"

# Full release pipeline: build + compile + package
release: compile-all package-npm
	@echo "Release artifacts ready in dist/npm/"

# Check for outdated dependencies across all workspace packages
outdated:
	@echo "📦 Checking for outdated dependencies..."
	@echo ""
	@echo "=== Root ==="
	@bun outdated || true
	@echo ""
	@echo "=== packages/cli ==="
	@cd packages/cli && bun outdated || true
	@echo ""
	@echo "=== packages/daemon ==="
	@cd packages/daemon && bun outdated || true
	@echo ""
	@echo "=== packages/web ==="
	@cd packages/web && bun outdated || true
	@echo ""
	@echo "=== packages/shared ==="
	@cd packages/shared && bun outdated || true

# Interactive dependency update across all workspace packages
update:
	@echo "🔄 Updating dependencies interactively..."
	@echo ""
	@echo "=== Root ==="
	@bun update --interactive
	@echo ""
	@echo "=== packages/cli ==="
	@cd packages/cli && bun update --interactive
	@echo ""
	@echo "=== packages/daemon ==="
	@cd packages/daemon && bun update --interactive
	@echo ""
	@echo "=== packages/web ==="
	@cd packages/web && bun update --interactive
	@echo ""
	@echo "=== packages/shared ==="
	@cd packages/shared && bun update --interactive
	@echo ""
	@echo "✅ All packages updated!"

# Install git hooks
setup-hooks:
	@echo "Installing git hooks..."
	@cp scripts/git-hooks/pre-commit .git/hooks/pre-commit
	@chmod +x .git/hooks/pre-commit
	@echo "✅ Git hooks installed"

# Full development environment setup
setup: setup-hooks
	@echo "✅ Development environment ready"

# Dev Proxy management for tests
# Usage: make test-proxy-start, make test-proxy-stop, etc.
test-proxy-start:
	@./scripts/dev-proxy.sh start

test-proxy-stop:
	@./scripts/dev-proxy.sh stop

test-proxy-status:
	@./scripts/dev-proxy.sh status

test-proxy-restart:
	@./scripts/dev-proxy.sh restart

# Desktop (Tauri) — see packages/desktop/README.md.
# `make desktop-dev` assumes a daemon is reachable on http://localhost:9283.
# Run it in a separate terminal:
#   make dev DB_PATH=/tmp/beokai-9283 PORT=9283
desktop-dev:
	@cd packages/desktop && bun run dev

desktop-build-sidecar:
	@cd packages/desktop && bun run build:sidecar

desktop-build:
	@cd packages/desktop && bun run build
