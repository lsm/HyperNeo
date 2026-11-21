// Stands in for HyperNeo Desktop in the live check: starts the guardian as its child,
// forwards its own stdin to it, and exits with the guardian's status.
#include <spawn.h>
#include <stdio.h>
#include <sys/wait.h>

extern char **environ;

int main(int argc, char **argv) {
    if (argc < 2) return 2;
    pid_t child;
    if (posix_spawn(&child, argv[1], NULL, NULL, argv + 1, environ)) return 3;
    int status = 0;
    waitpid(child, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
