# System-map route inventory

Run the independent inventory from the repository root:

```bash
bun scripts/pipeline-route-inventory.ts > "$RUN/inventory.json"
bun -e 'const rows = await Bun.file(process.argv[1]).json(); if (!rows.length) process.exit(1); console.log(`routes: ${rows.length}; variants: ${rows.filter((row) => row.variant).length}`)' "$RUN/inventory.json"
```

The command exits zero and prints a nonzero route count. Each item identifies a
source file and operation name, with a schema variant for duplicate names. The
zero-unresolved and timing assertions belong to the later analyzer coverage step.
