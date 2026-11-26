#!/usr/bin/env bash
set -euo pipefail

desktop=$(cd "$(dirname "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
cd "$fixture"
mkdir -p packages/desktop/src-tauri scripts bin
cp "$desktop"/build-sidecar.* "$desktop/package.json" packages/desktop/
cp "$desktop/src-tauri/tauri.conf.json" packages/desktop/src-tauri/
cat > bin/rustc <<'FIXTURE'
#!/usr/bin/env bash
printf '%s\n' x86_64-pc-windows-msvc
FIXTURE
chmod +x bin/rustc
cat > scripts/build-binary.ts <<'FIXTURE'
if (process.argv.slice(2).join(' ') !== '--target bun-windows-x64') process.exit(1);
await Bun.write('dist/bin/hyperneo-windows-x64.exe', 'windows sidecar fixture\n');
FIXTURE
export PATH="$fixture/bin:$PATH"
cd packages/desktop
hook=$(bun -e "console.log((await Bun.file('src-tauri/tauri.conf.json').json()).build.beforeDevCommand.script)")
unset CARGO_TARGET_DIR
bash -c "$hook"
cmp "$fixture/dist/bin/hyperneo-windows-x64.exe" src-tauri/target/debug/hyperneo.exe
CARGO_TARGET_DIR="$fixture/custom target" bash -c "$hook"
cmp "$fixture/dist/bin/hyperneo-windows-x64.exe" "$fixture/custom target/debug/hyperneo.exe"
printf '%s\n' 'Windows sidecar layout: 2/2 copies matched'
