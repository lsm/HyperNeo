// Stands in for HyperNeo Desktop in the checks: starts the guardian as its child, forwards
// its own stdin to it, and exits with the guardian's status. With --disclaim the guardian
// answers for its own privacy grants instead of inheriting the launcher's.
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>

extern char **environ;
int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);

int main(int argc, char **argv) {
    int disclaim = argc > 1 && !strcmp(argv[1], "--disclaim");
    char **guardian = argv + 1 + disclaim;
    if (!*guardian) return 2;
    posix_spawnattr_t attributes;
    if (posix_spawnattr_init(&attributes) || responsibility_spawnattrs_setdisclaim(&attributes, disclaim)) return 3;
    pid_t child;
    if (posix_spawn(&child, guardian[0], NULL, &attributes, guardian, environ)) return 3;
    int status = 0;
    waitpid(child, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
