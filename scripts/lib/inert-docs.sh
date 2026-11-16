# Inert docs: files that no build, test or lint reads. Shared by the CI path
# filter (.github/workflows/main.yml) and the pre-commit hook so both skip code
# checks by one rule.
#
# Only docs/ trees and top-level *.md count. A nested *.md can be a functional
# asset (packages/skills/*/SKILL.md feeds the bundled skill registry), so it
# must not be treated as inert.

is_inert_doc() {
  case "$1" in
    docs/*) return 0 ;;
    */*) return 1 ;;
    *.md) return 0 ;;
  esac
  return 1
}

# Reads one path per line on stdin. Succeeds only when there is at least one
# path and every path is inert.
all_inert_docs() {
  local f any=false
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    is_inert_doc "$f" || return 1
    any=true
  done
  [ "$any" = true ]
}
