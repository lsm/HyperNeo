#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
bun run --cwd packages/web test \
  src/neo/__tests__/NeoArtifactTaps.test.tsx \
  src/neo/__tests__/NeoPreviewWork.test.tsx \
  src/components/artifacts/__tests__/ArtifactPreviewTabs.test.tsx \
  src/components/artifacts/__tests__/ArtifactPreviewPanel.test.tsx \
  src/components/chat/__tests__/MarkdownRenderer.references.test.tsx \
  src/lib/__tests__/artifact-reference-client.test.ts
