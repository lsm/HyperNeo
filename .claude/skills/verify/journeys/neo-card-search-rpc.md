# Neo card search answers over the operations door off the main thread

Run `card-search-rpc.ts` through `proof-run.sh` in a fresh synthetic source
daemon. No provider turn, model mock, real credential or external HTTP is
needed.

Seed asks, a todo and an answered question through the production tables so
the migration triggers index them, then call `neo.ask.search` over the
WebSocket operations door as a local caller. Title matches must rank above
report text, todo and question rows must come back with their pointer ids,
the matched field and a snippet, answers must surface through the question
pointer, and cursor paging must end with a null cursor.

During the searches, preparing card-index SQL on the main connection throws:
the query must run on the reader thread (`card-search` operation in the SDK
status worker), never on main. Evidence lands in
`evidence/card-search-rpc.json`; the wrapper removes the disposable HOME and
daemon data after owned resources close.

A title containing literal brackets must not be mistaken for a highlighted
match when only the request contains the query. The dedicated unit and actual
RPC regressions report meta rather than title; both failed on the staged head.
Run this journey with both Bun and pinned Deno through the shared wrapper.

Production statement execution belongs to the existing SDK status worker; the
query helper builds SQL and projects pointer rows. The facade always dispatches
this new API to that worker. Unit SQL fixtures supply their own in-memory reader.
The main-thread SQL ratchet must pass without increasing its baseline.
