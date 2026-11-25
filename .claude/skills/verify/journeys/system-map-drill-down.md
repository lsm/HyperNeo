# Drill-down system map

From the repository root with pinned Bun and `jq` on PATH, run

```bash
bash .claude/skills/verify/system-map-drill-down.sh "$RUN/evidence" 275c7b4576
```

The base immediately precedes the publication operation change. Open both
Markdown files in the evidence directory. The index opens each component's
section. Route links show paths relative to the repository root. The package-root
entry opens the section containing `space.list`, whose definition also appears in
`where.txt`. The diff marks the Neo component and the changed publication
routes, while `neo.project.save` carries no route mark.

The script compares both maps with the strict report, checks each section
anchor is unique, and prints the component counts. It exits nonzero if a
comparison fails.
