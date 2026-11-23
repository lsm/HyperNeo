// Headless fixture for the guardian's lock-screen lookup. It replaces the loginwindow
// Accessibility tree with one that hides the password field behind the Touch ID prompt,
// as macOS does while Touch ID can unlock, and shows it once the prompt label below the
// focused user is clicked at its screen point through the HID tap, the way a physical
// click reaches the lock screen. Modes: reveal (the guardian clicks the label and
// submits the field), ambiguous (two candidate labels, nothing is clicked), ignored
// (the click shows nothing, the unlock fails) and input (owner input during the lookup
// stops the click). It never touches the real lock screen.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#include <dlfcn.h>
#include <string.h>

static const pid_t LoginPID = 4242;
static NSMutableArray *window;
static NSDictionary *field;
static const char *mode = "reveal";
static void (^ownerActs)(void);

static NSMutableDictionary *node(NSString *identifier, NSString *role, CGRect frame) {
    NSMutableDictionary *item = [NSMutableDictionary dictionary];
    if (identifier) item[(__bridge NSString *)kAXIdentifierAttribute] = identifier;
    if (role) item[(__bridge NSString *)kAXRoleAttribute] = role;
    item[(__bridge NSString *)kAXPositionAttribute] = CFBridgingRelease(AXValueCreate(kAXValueCGPointType, &frame.origin));
    item[(__bridge NSString *)kAXSizeAttribute] = CFBridgingRelease(AXValueCreate(kAXValueCGSizeType, &frame.size));
    return item;
}

static CFDictionaryRef fixtureSession(void) {
    return CFBridgingRetain(@{@"CGSSessionScreenIsLocked": @YES});
}

static void *fixtureFramework(const char *path, int mode) {
    (void)path;
    (void)mode;
    return NULL;
}

static IOReturn fixtureActivity(CFStringRef name, IOPMUserActiveType type, IOPMAssertionID *assertion) {
    (void)name;
    (void)type;
    *assertion = 1;
    return kIOReturnSuccess;
}

static AXUIElementRef fixtureApplication(pid_t pid) {
    if (pid != LoginPID) exit(6);
    NSDictionary *root = @{(__bridge NSString *)kAXChildrenAttribute: window};
    return (AXUIElementRef)CFBridgingRetain(root);
}

static AXError fixtureTimeout(AXUIElementRef item, float seconds) {
    (void)item;
    (void)seconds;
    return kAXErrorSuccess;
}

static AXError fixtureCopy(AXUIElementRef item, CFStringRef attribute, CFTypeRef *value) {
    if (strcmp(mode, "input") == 0 && CFEqual(attribute, kAXSubroleAttribute) && ownerActs) {
        dispatch_sync(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ownerActs);
        ownerActs = nil;
    }
    id found = ((__bridge NSDictionary *)item)[(__bridge NSString *)attribute];
    if (!found) return kAXErrorNoValue;
    *value = CFBridgingRetain(found);
    return kAXErrorSuccess;
}

static AXError fixtureSet(AXUIElementRef item, CFStringRef attribute, CFTypeRef value) {
    (void)value;
    return (__bridge NSDictionary *)item == field && CFEqual(attribute, kAXValueAttribute) ? kAXErrorSuccess : kAXErrorFailure;
}

static AXError fixtureAction(AXUIElementRef item, CFStringRef action) {
    (void)item;
    (void)action;
    puts("submitted");
    exit(0);
}

__attribute__((unused)) static void fixturePost(CGEventTapLocation tap, CGEventRef event) {
    if (tap != kCGHIDEventTap || CGEventGetType(event) != kCGEventLeftMouseUp) return;
    if (CGEventGetIntegerValueField(event, kCGEventSourceUnixProcessID) == 0) {
        puts("click carries source 0, would read as owner input");
        exit(7);
    }
    CGPoint point = CGEventGetLocation(event);
    printf("click hid %.0f,%.0f\n", point.x, point.y);
    if (strcmp(mode, "reveal") == 0 && CGRectContainsPoint(CGRectMake(620, 520, 200, 20), point) && !field) {
        field = node(@"UserPasswordTextField", (__bridge NSString *)kAXTextFieldRole, CGRectMake(620, 560, 200, 24));
        [window replaceObjectAtIndex:2 withObject:field];
    }
}

@interface FixtureLogin : NSObject
@property(nonatomic, readonly) pid_t processIdentifier;
@end

@implementation FixtureLogin
+ (NSArray *)runningApplicationsWithBundleIdentifier:(NSString *)identifier {
    return [identifier isEqualToString:@"com.apple.loginwindow"] ? @[ [FixtureLogin new] ] : @[];
}
- (pid_t)processIdentifier {
    return LoginPID;
}
@end

#define CGSessionCopyCurrentDictionary fixtureSession
#define dlopen fixtureFramework
#define IOPMAssertionDeclareUserActivity fixtureActivity
#define AXUIElementCreateApplication fixtureApplication
#define AXUIElementSetMessagingTimeout fixtureTimeout
#define AXUIElementCopyAttributeValue fixtureCopy
#define AXUIElementSetAttributeValue fixtureSet
#define AXUIElementPerformAction fixtureAction
#define CGEventPost fixturePost
#define NSRunningApplication FixtureLogin
#define main guardianMain
#include "guardian.m"
#undef main

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc > 1) mode = argv[1];
        window = [NSMutableArray arrayWithArray:@[
            node(@"FocusedUser", (__bridge NSString *)kAXGroupRole, CGRectMake(620, 300, 200, 200)),
            node(@"UserName", (__bridge NSString *)kAXStaticTextRole, CGRectMake(620, 505, 200, 12)),
            node(nil, (__bridge NSString *)kAXStaticTextRole, CGRectMake(620, 520, 200, 20)),
            node(nil, (__bridge NSString *)kAXStaticTextRole, CGRectMake(620, 800, 200, 20)),
        ]];
        if (strcmp(mode, "ambiguous") == 0) [window addObject:node(nil, (__bridge NSString *)kAXStaticTextRole, CGRectMake(620, 560, 200, 20))];
        Guardian *guardian = [Guardian new];
        guardian.axTrusted = YES;
        ownerActs = ^{ [guardian ownerDidAct]; };
        guardian.socketPath = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
        [guardian unlock];
        [NSTimer scheduledTimerWithTimeInterval:20 repeats:NO block:^(NSTimer *timer) {
            (void)timer;
            exit(4);
        }];
        [NSRunLoop.currentRunLoop run];
        return 4;
    }
}
