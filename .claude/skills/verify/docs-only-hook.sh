#!/bin/bash
# Proves the installed pre-commit hook lets a docs-only commit through without
# running any code check, and still runs them when code is staged. Uses a
# throwaway repo and a bun stub that fails if called, so a real `git commit`
# is the observed surface.
set -u
src=$(git rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/repo/scripts/lib" "$work/hooks"
printf '#!/bin/bash\necho "bun $*" >> "%s/bun-calls"\nexit 1\n' "$work" > "$work/bin/bun"
chmod +x "$work/bin/bun"
cp "$src/scripts/lib/inert-docs.sh" "$work/repo/scripts/lib/"
cp "$src/scripts/git-hooks/pre-commit" "$work/hooks/pre-commit"
chmod +x "$work/hooks/pre-commit"
cd "$work/repo" || exit 1
git init -q
git config core.hooksPath "$work/hooks"
git config commit.gpgsign false
git config user.email verify@example.invalid
git config user.name verify
export PATH="$work/bin:$PATH"
fail=0

mkdir -p docs/design && echo plan > docs/design/plan.md && echo hi > README.md
git add docs/design/plan.md README.md
git commit -q -m docs; docs_exit=$?
echo "docs-only commit exit=$docs_exit bun_calls=$(cat "$work/bun-calls" 2>/dev/null | wc -l | tr -d ' ')"
[ "$docs_exit" -eq 0 ] && [ ! -f "$work/bun-calls" ] || fail=1

mkdir -p src && echo 'export {};' > src/a.ts
git add src/a.ts
git commit -q -m code; code_exit=$?
echo "code commit exit=$code_exit first_bun_call=$(head -1 "$work/bun-calls" 2>/dev/null)"
[ "$code_exit" -ne 0 ] && grep -q '^bun run lint' "$work/bun-calls" || fail=1

echo "result=$([ $fail -eq 0 ] && echo pass || echo fail)"
exit $fail
