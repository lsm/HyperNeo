#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <dlfcn.h>
#include <string.h>

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

static AXError fixtureAttribute(AXUIElementRef item, CFStringRef attribute, CFTypeRef *value) {
    if (!CFEqual(attribute, kAXChildrenAttribute)) return kAXErrorNoValue;
    *value = CFRetain(item);
    return kAXErrorSuccess;
}

#define CGSessionCopyCurrentDictionary fixtureSession
#define AXUIElementCopyAttributeValue fixtureAttribute
#define dlopen fixtureFramework
#define dlsym fixtureSymbol
#define main guardianMain
#include "guardian.m"
#undef main

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "ax-trace") == 0) {
            NSArray *chain = @[];
            for (int i = 0; i < 13; i++) chain = @[chain];
            NSMutableString *trace = [NSMutableString string];
            if (find((__bridge AXUIElementRef)@[@[], chain], @"fixture", 0, trace)) return 5;
            say(trace);
            return 0;
        }
        Guardian *guardian = [Guardian new];
        guardian.socketPath = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
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
