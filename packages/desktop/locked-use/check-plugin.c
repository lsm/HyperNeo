// Drives the plugin's unlock mechanism without the system authorization engine.
// check-plugin ask <bundle executable>  prints allow or deny
#include <Security/AuthorizationPlugin.h>
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

static AuthorizationResult result = 99;

static OSStatus set_result(AuthorizationEngineRef engine, AuthorizationResult value) {
    (void)engine;
    result = value;
    return errAuthorizationSuccess;
}

int main(int argc, char **argv) {
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
