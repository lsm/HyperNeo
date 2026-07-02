# Contributing to HyperNeo

Thank you for your interest in contributing to HyperNeo! This document provides guidelines and information for contributors.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Install dependencies: `bun install`
4. Create a new branch from `dev` for your changes

## Branching Strategy

This project uses `dev` as the sole integration and release branch:

### Branches

- **`dev`** (default branch) - Active development and release branch
  - All feature branches should target `dev`
  - PRs to `dev` run lint, type check, unit tests, and integration tests
  - Push to `dev` triggers the full CI gate (including web tests, CLI tests, build)
  - Releases go directly from `dev` via version tags
  - E2E tests run on-demand via `workflow_dispatch`

### Workflow

1. **Feature Development**
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b feature/my-feature
   # make changes
   git push origin feature/my-feature
   # create PR targeting dev
   ```

2. **After PR is merged to `dev`**
   - Monitor CI to ensure all checks pass
   - Dev branch is the source of truth

3. **Releasing**
   - Bump version and create a PR to `dev` (see [`docs/release-process.md`](docs/release-process.md))
   - Tag the merge commit: `git tag vX.Y.Z && git push origin vX.Y.Z`
   - The release pipeline builds, publishes to npm, and creates a GitHub Release

### CI/CD Pipeline

| Event | Target Branch | Tests Run |
|-------|---------------|-----------|
| PR → `dev` | `dev` | Lint, type check, unit tests, integration tests |
| Push to `dev` | `dev` | Lint, type check, unit tests, integration tests, web tests, CLI tests, build |
| `workflow_dispatch` | any | **All** tests including E2E |
## Development Guidelines

### Code Style

- Follow the existing code style in the codebase
- Run `bun run lint` to check for linting errors
- Run `bun run format` to format code automatically

### Testing

- Write tests for new features and bug fixes
- Do not run `bun test` from the repository root; this monorepo blocks it intentionally.
- Run the full quality suite before submitting a PR: `bun run check`
- For daemon unit shards: `./scripts/test-daemon.sh`
- For targeted daemon tests: `cd packages/daemon && bun test ./tests/unit/some-test.test.ts`
- For web tests: `cd packages/web && bunx vitest run`
- For E2E tests: `make run-e2e TEST=tests/features/foo.e2e.ts`

### Commit Messages

Use clear and descriptive commit messages following conventional commit format:
- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `test:` for test-related changes
- `refactor:` for code refactoring
- `chore:` for maintenance tasks
- `ci:` for CI/CD changes

Example:
```
feat: add model switching support in coordinator mode

- Add model parameter to coordinator options
- Update UI to show current model
- Add tests for model switching
```

## Pull Request Process

1. **Ensure your branch is up to date** with `dev`
   ```bash
   git checkout dev
   git pull origin dev
   git checkout your-feature-branch
   git rebase dev
   ```

2. **Create a pull request** targeting the `dev` branch

3. **Provide a clear description** of your changes
   - What problem does it solve?
   - How does it work?
   - Are there any breaking changes?

4. **Wait for CI checks to pass**
   - PRs to dev run lint, type check, unit tests, and integration tests
   - All other checks must pass

5. **Request review** from maintainers

6. **Address feedback** from reviewers
   - Make requested changes
   - Push updates to your branch

7. **Merge** will happen after approval and passing checks

## Setting Up Your Development Environment

### Prerequisites

- [Bun](https://bun.sh/) 1.3.8 or later
- Node.js 20.x or later (for compatibility)
- Git

### Installation

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/neokai.git
cd neokai

# Add upstream remote
git remote add upstream https://github.com/lsm/neokai.git

# Install dependencies
bun install

# Build packages
bun run build
```

### Running Locally

```bash
# Start the development server from the CLI package
(cd packages/cli && bun run dev)

# From the repository root, run quality checks
bun run check

# From the repository root, run daemon unit shards
./scripts/test-daemon.sh

# Or run targeted daemon tests package-locally
(cd packages/daemon && bun test ./tests/unit/some-test.test.ts)
```

### Environment Variables

Create a `.env` file in the root directory:

```bash
ANTHROPIC_API_KEY=your_api_key_here
GLM_API_KEY=your_glm_key_here  # Optional, for GLM provider
```

## Questions or Issues?

If you have questions or run into issues:
- Check [existing issues](https://github.com/lsm/neokai/issues) on GitHub
- Open a new issue with a clear description
- Join our community discussions

## Code of Conduct

- Be respectful and inclusive
- Provide constructive feedback
- Help others learn and grow
- Focus on what is best for the community

Thank you for contributing to HyperNeo! 🚀
