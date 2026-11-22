// Drives the plugin's unlock mechanism without the system authorization engine.
// check-plugin ask <bundle executable>  prints allow or deny
// check-plugin serve [answer|silent|hangup]  answers like an armed guardian, never replies, or hangs up
#include <Security/AuthorizationPlugin.h>
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static AuthorizationResult result = 99;

static OSStatus set_result(AuthorizationEngineRef engine, AuthorizationResult value) {
    (void)engine;
    result = value;
    return errAuthorizationSuccess;
}

int main(int argc, char **argv) {
    if (argc >= 2 && !strcmp(argv[1], "serve")) {
        const char *mode = argc > 2 ? argv[2] : "answer";
        struct sockaddr_un address = {.sun_family = AF_UNIX};
        snprintf(address.sun_path, sizeof address.sun_path, "/private/tmp/io.hyperneo.locked-use.%u.sock", getuid());
        unlink(address.sun_path);
        int listener = socket(AF_UNIX, SOCK_STREAM, 0);
        if (bind(listener, (struct sockaddr *)&address, sizeof address) || listen(listener, 1)) return 1;
        puts("serving");
        fflush(stdout);
        int client = accept(listener, NULL, NULL);
        char request = 0;
        if (!strcmp(mode, "silent")) sleep(5);
        else if (!strcmp(mode, "answer") && read(client, &request, 1) == 1 && request == '?') (void)write(client, "1", 1);
        close(client);
        unlink(address.sun_path);
        return 0;
    }
    if (argc != 3 || strcmp(argv[1], "ask")) return 2;
    void *plugin = dlopen(argv[2], RTLD_NOW);
    OSStatus (*create)(const AuthorizationCallbacks *, AuthorizationPluginRef *, const AuthorizationPluginInterface **) =
        plugin ? dlsym(plugin, "AuthorizationPluginCreate") : NULL;
    if (!create) return 3;
    AuthorizationCallbacks callbacks = {.version = kAuthorizationCallbacksVersion, .SetResult = set_result};
    AuthorizationPluginRef ref;
    const AuthorizationPluginInterface *interface;
    AuthorizationMechanismRef mechanism;
    if (create(&callbacks, &ref, &interface) || interface->MechanismCreate(ref, (AuthorizationEngineRef)&result, "unlock", &mechanism)) return 4;
    interface->MechanismInvoke(mechanism);
    puts(result == kAuthorizationResultAllow ? "allow" : result == kAuthorizationResultDeny ? "deny" : "none");
    return 0;
}
