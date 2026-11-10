---
id: neo.ask.doneTodos
---
Read the done todos of an ask, a page at a time, in list order. An ask with more than 3 done todos (20 for RPC clients) lists none of them in neo.snapshot and carries only doneCount; read them here when you need to check finished work. Pass offset from nextOffset for the next page; nextOffset is null on the last page.
