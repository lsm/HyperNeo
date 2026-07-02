#!/bin/sh
set -e

echo "🔧 Installing dependencies..."
bun install

echo "📦 Building web production bundle..."
cd packages/web && bun run build && cd ../..

echo "🚀 Starting HyperNeo in self-hosting mode..."
exec bun run packages/cli/main.ts --port 9983 --db-path /data/daemon.db
