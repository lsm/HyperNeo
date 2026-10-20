import _sqlite3
import ctypes as C
import json
import sqlite3
import sys
import time

path, sql, conversation = sys.argv[1:]
lib = C.CDLL(_sqlite3.__file__)
ptr = C.c_void_p
lib.sqlite3_open_v2.argtypes = [C.c_char_p, C.POINTER(ptr), C.c_int, C.c_char_p]
lib.sqlite3_prepare_v2.argtypes = [ptr, C.c_char_p, C.c_int, C.POINTER(ptr), ptr]
lib.sqlite3_bind_text.argtypes = [ptr, C.c_int, C.c_char_p, C.c_int, ptr]
lib.sqlite3_bind_int.argtypes = [ptr, C.c_int, C.c_int]
lib.sqlite3_step.argtypes = [ptr]
lib.sqlite3_stmt_status.argtypes = [ptr, C.c_int, C.c_int]
lib.sqlite3_db_status.argtypes = [ptr, C.c_int, C.POINTER(C.c_int), C.POINTER(C.c_int), C.c_int]
lib.sqlite3_exec.argtypes = [ptr, C.c_char_p, ptr, ptr, ptr]
lib.sqlite3_finalize.argtypes = [ptr]
lib.sqlite3_close.argtypes = [ptr]
lib.sqlite3_errmsg.argtypes = [ptr]
lib.sqlite3_errmsg.restype = C.c_char_p
handle, statement = ptr(), ptr()

def check(code):
    if code != 0:
        raise RuntimeError(lib.sqlite3_errmsg(handle).decode())

def counter(kind):
    current, high = C.c_int(), C.c_int()
    check(lib.sqlite3_db_status(handle, kind, C.byref(current), C.byref(high), 0))
    return current.value

check(lib.sqlite3_open_v2(path.encode(), C.byref(handle), 1, None))
try:
    check(lib.sqlite3_exec(handle, b'PRAGMA cache_size=-2000', None, None, None))
    check(lib.sqlite3_prepare_v2(handle, sql.encode(), -1, C.byref(statement), None))
    check(lib.sqlite3_bind_text(statement, 1, conversation.encode(), -1, ptr(-1)))
    check(lib.sqlite3_bind_int(statement, 2, 7))
    hits, misses = counter(7), counter(8)
    started = time.perf_counter()
    rows = 0
    while True:
        code = lib.sqlite3_step(statement)
        if code == 101:
            break
        if code != 100:
            check(code)
        rows += 1
    elapsed = (time.perf_counter() - started) * 1000
    result = dict(sqliteVersion=sqlite3.sqlite_version, rows=rows, ms=elapsed,
                  vmSteps=lib.sqlite3_stmt_status(statement, 4, 0),
                  pageReads=counter(8) - misses, cacheHits=counter(7) - hits)
finally:
    if statement:
        lib.sqlite3_finalize(statement)
    lib.sqlite3_close(handle)
with sqlite3.connect('file:' + path + '?mode=ro', uri=True) as connection:
    result['plan'] = list(connection.execute('EXPLAIN QUERY PLAN ' + sql, (conversation, 7)))
print(json.dumps(result))
