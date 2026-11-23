#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <dlfcn.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>

static BOOL locked = YES;
static NSTimeInterval stopping;

static CFDictionaryRef fixtureSession(void) {
    return CFBridgingRetain(@{@"CGSSessionScreenIsLocked": @(locked)});
}

static void fixtureLock(void) {
    if (locked && NSProcessInfo.processInfo.systemUptime - stopping < 4.5) exit(5);
    puts("lock requested");
    if (!locked) {
        [NSTimer scheduledTimerWithTimeInterval:0.25 repeats:NO block:^(NSTimer *timer) {
            (void)timer;
            locked = YES;
            puts("relock observed");
        }];
    }
}

static void *fixtureFramework(const char *path, int mode) {
    (void)path;
    (void)mode;
    return (void *)1;
}

static void *fixtureSymbol(void *handle, const char *name) {
    (void)handle;
    return strcmp(name, "SACLockScreenImmediate") == 0 ? (void *)fixtureLock : NULL;
}

#define CGSessionCopyCurrentDictionary fixtureSession
#define dlopen fixtureFramework
#define dlsym fixtureSymbol
#define getuid() 4242
#define main guardianMain
#include "guardian.m"
#undef main

static char askGrant(void) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    strlcpy(address.sun_path, "/private/tmp/io.hyperneo.locked-use.4242.sock", sizeof address.sun_path);
    char reply = 0;
    if (fd < 0 || connect(fd, (struct sockaddr *)&address, sizeof address) != 0) {
        if (fd >= 0) close(fd);
        return -1;
    }
    char request = '?';
    if (write(fd, &request, 1) != 1 || read(fd, &reply, 1) != 1) reply = -1;
    close(fd);
    return reply;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        Guardian *guardian = [Guardian new];
        guardian.socketPath = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
        if (argc == 2 && strcmp(argv[1], "grant") == 0) {
            guardian.allowAnswered = NO;
            guardian.armed = YES;
            if (![guardian listen]) {
                puts("listen failed");
                return 8;
            }
            [NSThread detachNewThreadWithBlock:^{
                [NSThread sleepForTimeInterval:0.2];
                int failures = 0;
                char first = askGrant();
                printf("grant %s\n", first == '1' ? "allowed" : "FAILED");
                failures += first != '1';
                [NSThread sleepForTimeInterval:0.2];
                guardian.armed = YES;
                char second = askGrant();
                printf("grant %s\n", second == '0' ? "refused after allow" : "FAILED");
                failures += second != '0';
                [NSThread sleepForTimeInterval:0.2];
                guardian.allowAnswered = NO;
                guardian.ownerInput = YES;
                guardian.armed = YES;
                char third = askGrant();
                printf("grant %s\n", third == '0' ? "refused after owner input" : "FAILED");
                failures += third != '0';
                fflush(stdout);
                exit(failures ? 9 : 0);
            }];
            [NSTimer scheduledTimerWithTimeInterval:12 repeats:NO block:^(NSTimer *timer) {
                (void)timer;
                exit(4);
            }];
            [NSRunLoop.currentRunLoop run];
            return 4;
        }
        guardian.allowAnswered = YES;
        if (argc == 2 && strcmp(argv[1], "delayed") == 0) {
            [NSTimer scheduledTimerWithTimeInterval:0.25 repeats:NO block:^(NSTimer *timer) {
                (void)timer;
                locked = NO;
                puts("unlock observed");
            }];
        }
        [NSTimer scheduledTimerWithTimeInterval:12 repeats:NO block:^(NSTimer *timer) {
            (void)timer;
            exit(4);
        }];
        stopping = NSProcessInfo.processInfo.systemUptime;
        [guardian end:@"stopped"];
        [NSRunLoop.currentRunLoop run];
        return 4;
    }
}
