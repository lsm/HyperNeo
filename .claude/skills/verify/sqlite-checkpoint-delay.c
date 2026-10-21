#include <sqlite3.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>

static atomic_int delayed;
static void marker(const char *path) {
    if (!path) return;
    int fd = open(path, O_CREAT | O_WRONLY, 0600);
    if (fd >= 0) { write(fd, "checkpoint", 10); close(fd); }
}
static int delayed_checkpoint(sqlite3 *db, const char *schema, int mode, int *log, int *done) {
    const char *target = getenv("HN_CHECKPOINT_DB");
    const char *actual = sqlite3_db_filename(db, "main");
    if (!pthread_main_np() && target && actual && !strcmp(target, actual) && !atomic_exchange(&delayed, 1)) {
        marker(getenv("HN_CHECKPOINT_MARKER"));
        marker(getenv("HN_PROBE_GO"));
        usleep(1800000);
    }
    return sqlite3_wal_checkpoint_v2(db, schema, mode, log, done);
}
__attribute__((used)) static struct { const void *replacement; const void *original; } interpose
    __attribute__((section("__DATA,__interpose"))) = { (const void*)delayed_checkpoint, (const void*)sqlite3_wal_checkpoint_v2 };
