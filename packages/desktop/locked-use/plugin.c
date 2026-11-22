#include <Security/AuthorizationPlugin.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    const AuthorizationCallbacks *callbacks;
    AuthorizationEngineRef engine;
} Mechanism;

static OSStatus plugin_destroy(AuthorizationPluginRef plugin) {
    (void)plugin;
    return errAuthorizationSuccess;
}

static OSStatus mechanism_create(AuthorizationPluginRef plugin, AuthorizationEngineRef engine,
                                 AuthorizationMechanismId id, AuthorizationMechanismRef *out) {
    if (strcmp(id, "unlock") != 0) return errAuthorizationInvalidTag;
    Mechanism *mechanism = calloc(1, sizeof *mechanism);
    if (!mechanism) return errAuthorizationInternal;
    mechanism->callbacks = (const AuthorizationCallbacks *)plugin;
    mechanism->engine = engine;
    *out = mechanism;
    return errAuthorizationSuccess;
}

static OSStatus mechanism_invoke(AuthorizationMechanismRef ref) {
    Mechanism *mechanism = ref;
    return mechanism->callbacks->SetResult(mechanism->engine, kAuthorizationResultDeny);
}

static OSStatus mechanism_deactivate(AuthorizationMechanismRef ref) {
    Mechanism *mechanism = ref;
    return mechanism->callbacks->DidDeactivate(mechanism->engine);
}

static OSStatus mechanism_destroy(AuthorizationMechanismRef ref) {
    free(ref);
    return errAuthorizationSuccess;
}

static const AuthorizationPluginInterface interface = {
    .version = kAuthorizationPluginInterfaceVersion,
    .PluginDestroy = plugin_destroy,
    .MechanismCreate = mechanism_create,
    .MechanismInvoke = mechanism_invoke,
    .MechanismDeactivate = mechanism_deactivate,
    .MechanismDestroy = mechanism_destroy,
};

OSStatus AuthorizationPluginCreate(const AuthorizationCallbacks *callbacks, AuthorizationPluginRef *plugin,
                                   const AuthorizationPluginInterface **out) {
    *plugin = (AuthorizationPluginRef)callbacks;
    *out = &interface;
    return errAuthorizationSuccess;
}
