#!/usr/bin/env bash
set -euo pipefail
EVIDENCE=${1:?usage: ci-cleanup-mirrors.sh <absolute-evidence-directory>}
[[ "$EVIDENCE" = /* ]] || exit 2
mkdir -p "$EVIDENCE"
task_run=$(mktemp -d)
trap 'rm -rf "$task_run"' EXIT
mkdir -p "$task_run/lists/partial" "$task_run/cache/archives/partial"
printf '%s\n' https://mirrors.mit.edu/ubuntu/ https://mirrors.edge.kernel.org/ubuntu/ > "$task_run/mirrors.txt"
printf 'deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] mirror+file:%s noble main\ndeb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] mirror+file:%s noble-updates main\n' "$task_run/mirrors.txt" "$task_run/mirrors.txt" > "$task_run/sources.list"
touch "$task_run/status"
options=(
  -o "Dir::Etc::sourcelist=$task_run/sources.list"
  -o 'Dir::Etc::sourceparts=-'
  -o "Dir::State::lists=$task_run/lists"
  -o "Dir::State::status=$task_run/status"
  -o "Dir::Cache=$task_run/cache"
  -o "APT::Sandbox::User=$(id -un)"
  -o 'Acquire::Languages=none'
  -o 'Acquire::IndexTargets::deb::DEP-11::DefaultEnabled=false'
  -o 'Acquire::Retries=0'
  -o 'Acquire::https::Timeout=20'
)
apt-get "${options[@]}" update 2>&1 | tee "$EVIDENCE/apt-update.log"
for release in "$task_run"/lists/*InRelease; do
  gpgv --keyring /usr/share/keyrings/ubuntu-archive-keyring.gpg "$release" 2>&1 | tee -a "$EVIDENCE/signatures.log"
done
cd "$task_run"
apt-get "${options[@]}" download bubblewrap 2>&1 | tee "$EVIDENCE/download.log"
package=$(printf '%s\n' "$task_run"/bubblewrap_*.deb)
test "$(dpkg-deb -f "$package" Package)" = bubblewrap
dpkg-deb -f "$package" Package Version Architecture | tee "$EVIDENCE/package.txt"
dpkg-deb -x "$package" "$task_run/root"
"$task_run/root/usr/bin/bwrap" --version | tee "$EVIDENCE/version.txt"
printf 'signed_package_download_exit=0 package_count=1\n'
