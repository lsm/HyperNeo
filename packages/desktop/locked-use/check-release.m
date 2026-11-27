#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <dlfcn.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>

static BOOL locked = YES;
static BOOL checkHandoff;
static BOOL failRelock;
static NSTimeInterval stopping;
static BOOL scripted;
static NSTimeInterval scriptedTime;
static NSUInteger lockRequests;

@interface FixtureClock : NSObject
+ (instancetype)processInfo;
@property(readonly) NSTimeInterval systemUptime;
@end
@implementation FixtureClock
+ (instancetype)processInfo { return [self new]; }
- (NSTimeInterval)systemUptime {
    return scripted ? 100 + scriptedTime : NSProcessInfo.processInfo.systemUptime;
}
@end

@interface FixtureTimer : NSObject
@property NSDate *fireDate;
+ (instancetype)scheduledTimerWithTimeInterval:(NSTimeInterval)interval repeats:(BOOL)repeats
                                         block:(void (^)(FixtureTimer *))block;
- (void)invalidate;
@end
static void (^tick)(FixtureTimer *);
static FixtureTimer *scriptedTimer;

@implementation FixtureTimer
+ (instancetype)scheduledTimerWithTimeInterval:(NSTimeInterval)interval repeats:(BOOL)repeats
                                         block:(void (^)(FixtureTimer *))block {
    if (!scripted) {
        return (id)[NSTimer scheduledTimerWithTimeInterval:interval repeats:repeats
                                                     block:^(NSTimer *timer) { block((id)timer); }];
    }
    tick = [block copy];
    scriptedTimer = [self new];
    return scriptedTimer;
}
- (void)invalidate {}
@end

@interface ReleaseWindow : NSObject
@property CGFloat alphaValue;
@end
@implementation ReleaseWindow
@end

static CFDictionaryRef fixtureSession(void) {
    return CFBridgingRetain(@{@"CGSSessionScreenIsLocked": @(locked)});
}

static void fixtureLock(void) {
    if (scripted) {
        lockRequests++;
        puts("lock requested");
        return;
    }
    if (locked && NSProcessInfo.processInfo.systemUptime - stopping < 4.5) exit(5);
    puts("lock requested");
    if (!locked && !failRelock) {
        [NSTimer scheduledTimerWithTimeInterval:0.25 repeats:NO block:^(NSTimer *timer) {
            (void)timer;
            locked = YES;
            puts("relock observed");
            if (checkHandoff) {
                [NSTimer scheduledTimerWithTimeInterval:0.6 repeats:NO block:^(NSTimer *handoff) {
                    (void)handoff;
                    puts("handoff interval elapsed");
                }];
            }
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
#define NSTimer FixtureTimer
#define NSProcessInfo FixtureClock
#define main guardianMain
#include "guardian.m"
#undef main
#undef NSTimer
#undef NSProcessInfo

static NSArray<ReleaseWindow *> *releaseWindows;
static CGFloat finalAlpha = 1;

static void requireAlpha(CGFloat lower, CGFloat upper) {
    CGFloat first = releaseWindows.firstObject.alphaValue;
    CGFloat second = releaseWindows.lastObject.alphaValue;
    if (first != second || first < lower || first > upper) {
        printf("unexpected cover alpha %.3f and %.3f\n", first, second);
        fflush(stdout);
        _Exit(6);
    }
}

static void verifyExitAlpha(void) {
    requireAlpha(finalAlpha, finalAlpha);
    printf("exit opacity %.0f on both displays\n", finalAlpha);
}

static void step(NSTimeInterval elapsed, BOOL lockFlag) {
    locked = lockFlag;
    scriptedTime = elapsed;
    tick(scriptedTimer);
}

static int checkFade(Guardian *guardian, const char *scenario) {
    scripted = YES;
    locked = YES;
    releaseWindows = @[ [ReleaseWindow new], [ReleaseWindow new] ];
    for (ReleaseWindow *window in releaseWindows) window.alphaValue = 1;
    guardian.covers = [NSMutableArray arrayWithArray:(NSArray<NSWindow *> *)releaseWindows];
    atexit(verifyExitAlpha);
    [guardian end:@"stopped"];
    if (strcmp(scenario, "fade-relock") == 0) {
        step(0.10, YES);
        step(0.849, YES);
        requireAlpha(1, 1);
        puts("opaque through hold");
        step(0.851, YES);
        step(0.901, YES);
        requireAlpha(0.80, 0.86);
        puts("both displays fading");
        step(0.95, NO);
        requireAlpha(1, 1);
        if (lockRequests != 1) return 7;
        puts("restored immediately on unlock");
        step(0.96, YES);
        step(1.709, YES);
        requireAlpha(1, 1);
        puts("opaque through fresh hold");
        step(1.712, YES);
        step(1.99, YES);
        requireAlpha(0.04, 0.10);
        finalAlpha = 0;
        step(2.02, YES);
    } else if (strcmp(scenario, "fade-skipped") == 0) {
        step(9.15, YES);
        step(9.91, YES);
        step(9.99, YES);
        requireAlpha(1, 1);
        puts("opaque when remaining time is less than fade duration");
        step(10.01, YES);
    } else {
        step(8.80, YES);
        step(9.60, YES);
        step(9.80, YES);
        requireAlpha(0.30, 0.36);
        puts("both displays fading before deadline");
        step(10.01, strcmp(scenario, "fade-deadline-locked") == 0);
    }
    return 7;
}

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
        const char *scenario = argc == 2 ? argv[1] : "";
        if (strncmp(scenario, "fade-", 5) == 0) {
            guardian.allowAnswered = NO;
            return checkFade(guardian, scenario);
        }
        checkHandoff = strcmp(scenario, "input") == 0;
        failRelock = strcmp(scenario, "relock_failed") == 0;
        if (checkHandoff || failRelock) {
            locked = NO;
            guardian.unlocked = YES;
        } else if (strcmp(scenario, "delayed") == 0) {
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
        if (checkHandoff) [guardian ownerDidAct];
        else [guardian end:@"stopped"];
        [NSRunLoop.currentRunLoop run];
        return 4;
    }
}
