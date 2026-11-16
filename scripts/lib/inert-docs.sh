# Inert docs: prose that no build, test, lint or formatter reads. Shared by the
# CI path filter (.github/workflows/main.yml) and the pre-commit hook so both
# skip code checks by one rule.
#
# Markdown and plain text under docs/, top-level *.md, and agent instruction
# files (AGENTS.md, CLAUDE.md) at any depth count. Other docs/ files (JSON,
# HTML, CSS) are formatted or read by tooling. Any other nested *.md outside
# docs/ can be a functional asset (packages/skills/*/SKILL.md feeds the bundled
# skill registry), so it is not inert.

is_inert_doc() {
  case "$1" in
    docs/*.md | docs/*.txt | */AGENTS.md | */CLAUDE.md) return 0 ;;
    */*) return 1 ;;
    *.md) return 0 ;;
  esac
  return 1
}

# Reads NUL-delimited paths (git diff -z) on stdin. Succeeds only when there is
# at least one path and every path is inert.
all_inert_docs() {
  local f any=false
  while IFS= read -r -d '' f; do
    is_inert_doc "$f" || return 1
    any=true
  done
  [ "$any" = true ]
}
