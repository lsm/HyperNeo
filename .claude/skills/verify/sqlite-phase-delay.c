#include <sqlite3.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
static void delay(const char *path, const char *sql) {
  const char *target=getenv("HN_PHASE_DB"), *phase=getenv("HN_PHASE");
  if(!target||!phase||!path||strcmp(path,target))return;
  if((!strcmp(phase,"open")&&!sql)||(!strcmp(phase,"prepare")&&sql&&strstr(sql,"phase_prepare_probe"))) {
    struct timespec ts={1,400000000}; nanosleep(&ts,0);
  }
}
static int open_delay(const char *path, sqlite3 **db, int flags, const char *vfs) { delay(path,0);return sqlite3_open_v2(path,db,flags,vfs); }
static int prepare3_delay(sqlite3 *db,const char *sql,int n,unsigned int flags,sqlite3_stmt **s,const char **tail) { delay(sqlite3_db_filename(db,"main"),sql);return sqlite3_prepare_v3(db,sql,n,flags,s,tail); }
static int prepare2_delay(sqlite3 *db,const char *sql,int n,sqlite3_stmt **s,const char **tail) { delay(sqlite3_db_filename(db,"main"),sql);return sqlite3_prepare_v2(db,sql,n,s,tail); }
__attribute__((used)) static struct{const void *r,*o;} io __attribute__((section("__DATA,__interpose")))={(void*)open_delay,(void*)sqlite3_open_v2};
__attribute__((used)) static struct{const void *r,*o;} i3 __attribute__((section("__DATA,__interpose")))={(void*)prepare3_delay,(void*)sqlite3_prepare_v3};
__attribute__((used)) static struct{const void *r,*o;} i2 __attribute__((section("__DATA,__interpose")))={(void*)prepare2_delay,(void*)sqlite3_prepare_v2};
