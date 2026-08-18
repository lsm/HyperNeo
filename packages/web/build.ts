#!/usr/bin/env bun

import { $ } from 'bun';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const DIST_DIR = join(import.meta.dir, 'dist');

console.log('🏗️  Building HyperNeo Web UI for production...\n');

console.log('🧹 Cleaning dist directory...');
await $`rm -rf ${DIST_DIR}`;
mkdirSync(DIST_DIR, { recursive: true });

console.log('🎨 Building CSS with Tailwind...');
await $`tailwindcss --input src/styles.css --output ${join(DIST_DIR, 'styles.css')} --minify`;

console.log('📦 Building JavaScript with content hashing...');
const buildResult = await Bun.build({
  entrypoints: ['./src/client.tsx'],
  outdir: DIST_DIR,
  minify: true,
  splitting: true,
  naming: {
    entry: '[dir]/[name]-[hash].[ext]',
    chunk: '[dir]/[name]-[hash].[ext]',
    asset: '[dir]/[name]-[hash].[ext]',
  },
  sourcemap: 'external',
});

if (!buildResult.success) {
  console.error('❌ Build failed:');
  for (const log of buildResult.logs) {
    console.error(log);
  }
  process.exit(1);
}

const mainBundle = buildResult.outputs.find(
  (output) => output.path.includes('client') && output.path.endsWith('.js')
);

if (!mainBundle) {
  console.error('❌ Could not find main bundle output');
  process.exit(1);
}

const mainBundleName = mainBundle.path.split('/').pop();
console.log(`✅ Main bundle: ${mainBundleName}`);

console.log('📄 Generating index.html...');
const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>HyperNeo - Claude Agent Wrapper</title>
    <link rel="stylesheet" href="/styles.css" />
    <script>
      // Prevent errors from browser extensions trying to access window.ethereum
      if (typeof window.ethereum === 'undefined') {
        window.ethereum = {};
      }
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/${mainBundleName}"></script>
  </body>
</html>`;

writeFileSync(join(DIST_DIR, 'index.html'), indexHtml);

console.log('\n✨ Build complete!');
console.log(`📂 Output: ${DIST_DIR}`);
console.log(`📊 Bundle size: ${(mainBundle.size / 1024).toFixed(2)} KB`);
console.log("\n🚀 Run 'bun run start' to serve the production build");
