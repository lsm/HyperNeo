#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <dlfcn.h>
#include <string.h>

static BOOL locked = YES;

static CFDictionaryRef fixtureSession(void) {
    return CFBridgingRetain(@{@"CGSSessionScreenIsLocked": @(locked)});
}

static void fixtureLock(void) {
    puts("lock requested");
    locked = YES;
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
#define main guardianMain
#include "guardian.m"
#undef main

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        Guardian *guardian = [Guardian new];
        guardian.socketPath = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
        if ([guardian respondsToSelector:@selector(setAllowAnswered:)]) {
            [guardian setValue:@YES forKey:@"allowAnswered"];
        }
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
        [guardian end:@"stopped"];
        [NSRunLoop.currentRunLoop run];
        return 4;
    }
}
