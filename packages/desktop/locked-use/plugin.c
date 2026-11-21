#include <CoreFoundation/CoreFoundation.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <Security/AuthorizationPlugin.h>
#include <Security/Security.h>
#include <bsm/libbsm.h>
#include <os/log.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

#define GUARDIAN_REQUIREMENT \
    "anchor apple generic and identifier \"io.hyperneo.locked-use\" and " \
    "certificate leaf[subject.OU] = \"P5R65T296V\""

typedef struct {
    const AuthorizationCallbacks *callbacks;
    AuthorizationEngineRef engine;
} Mechanism;

static int signed_guardian(audit_token_t token) {
    CFDataRef audit = CFDataCreate(NULL, (const UInt8 *)&token, sizeof token);
    if (!audit) return 0;
    const void *keys[] = {kSecGuestAttributeAudit};
    const void *values[] = {audit};
    CFDictionaryRef attributes = CFDictionaryCreate(NULL, keys, values, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    CFRelease(audit);
    if (!attributes) return 0;
    SecCodeRef code = NULL;
    SecRequirementRef requirement = NULL;
    int trusted = SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &code) == errSecSuccess
        && SecRequirementCreateWithString(CFSTR(GUARDIAN_REQUIREMENT), kSecCSDefaultFlags, &requirement) == errSecSuccess
        && SecCodeCheckValidity(code, kSecCSStrictValidate, requirement) == errSecSuccess;
    if (requirement) CFRelease(requirement);
    if (code) CFRelease(code);
    CFRelease(attributes);
    return trusted;
}

static int connect_within(int channel, const struct sockaddr_un *address, int milliseconds) {
    int flags = fcntl(channel, F_GETFL);
    if (flags < 0 || fcntl(channel, F_SETFL, flags | O_NONBLOCK)) return 0;
    int connected = !connect(channel, (const struct sockaddr *)address, sizeof *address);
    if (!connected && errno == EINPROGRESS) {
        struct pollfd ready = {.fd = channel, .events = POLLOUT};
        int failure = 0;
        socklen_t size = sizeof failure;
        connected = poll(&ready, 1, milliseconds) == 1
            && !getsockopt(channel, SOL_SOCKET, SO_ERROR, &failure, &size) && !failure;
    }
    return connected && !fcntl(channel, F_SETFL, flags);
}

static int guardian_unlocks(void) {
    struct stat console;
    if (stat("/dev/console", &console) || console.st_uid == 0) return 0;
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    snprintf(address.sun_path, sizeof address.sun_path,
             "/private/tmp/io.hyperneo.locked-use.%u.sock", console.st_uid);
    int channel = socket(AF_UNIX, SOCK_STREAM, 0);
    if (channel < 0) return 0;
    struct timeval deadline = {.tv_sec = 1};
    int on = 1;
    audit_token_t token;
    socklen_t size = sizeof token;
    char reply = 0;
    int approved = !setsockopt(channel, SOL_SOCKET, SO_NOSIGPIPE, &on, sizeof on)
        && !setsockopt(channel, SOL_SOCKET, SO_RCVTIMEO, &deadline, sizeof deadline)
        && !setsockopt(channel, SOL_SOCKET, SO_SNDTIMEO, &deadline, sizeof deadline)
        && connect_within(channel, &address, 1000)
        && !getsockopt(channel, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &size)
        && audit_token_to_euid(token) == console.st_uid
        && signed_guardian(token)
        && write(channel, "?", 1) == 1
        && read(channel, &reply, 1) == 1 && reply == '1';
    close(channel);
    return approved;
}

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
    int approved = guardian_unlocks();
    os_log(os_log_create("io.hyperneo.locked-use", "plugin"), "Locked Use unlock approved=%d", approved);
    return mechanism->callbacks->SetResult(mechanism->engine,
        approved ? kAuthorizationResultAllow : kAuthorizationResultDeny);
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
