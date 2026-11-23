// Locked Use guardian. HyperNeo Desktop starts it while the screen is locked.
// It covers every display, asks the signed authorization plugin for a one-time
// unlock, keeps the display awake so the cover stays visible, and locks the screen
// again on local input, stdin EOF, "stop", or when no stdin line arrives for argv[1] seconds.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <IOKit/pwr_mgt/IOPMLib.h>
#import <Security/Security.h>
#include <dlfcn.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>

static NSString *const OwnerRequirement =
    @"anchor apple generic and identifier \"io.hyperneo.app\" and certificate leaf[subject.OU] = \"P5R65T296V\"";

static BOOL screenLocked(void) {
    NSDictionary *session = CFBridgingRelease(CGSessionCopyCurrentDictionary());
    return [session[@"CGSSessionScreenIsLocked"] boolValue];
}

static void lockScreen(void) {
    void *login = dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login", RTLD_LAZY);
    void (*lock)(void) = login ? (void (*)(void))dlsym(login, "SACLockScreenImmediate") : NULL;
    if (lock) lock();
}

static BOOL pluginInstalled(void) {
    CFDictionaryRef definition = NULL;
    if (AuthorizationRightGet("system.login.screensaver", &definition) != errAuthorizationSuccess) return NO;
    NSDictionary *rule = CFBridgingRelease(definition);
    return [rule[@"rule"] isKindOfClass:NSArray.class] && [rule[@"rule"] containsObject:@"io.hyperneo.locked-use.unlock"]
        && AuthorizationRightGet("io.hyperneo.locked-use.unlock", NULL) == errAuthorizationSuccess;
}

static BOOL ownerIsHyperNeo(pid_t pid) {
    SecCodeRef code = NULL;
    SecRequirementRef requirement = NULL;
    BOOL trusted = SecCodeCopyGuestWithAttributes(NULL, (__bridge CFDictionaryRef)@{(__bridge id)kSecGuestAttributePid : @(pid)},
                                                  kSecCSDefaultFlags, &code) == errSecSuccess
        && SecRequirementCreateWithString((__bridge CFStringRef)OwnerRequirement, kSecCSDefaultFlags, &requirement) == errSecSuccess
        && SecCodeCheckValidity(code, kSecCSStrictValidate, requirement) == errSecSuccess;
    if (requirement) CFRelease(requirement);
    if (code) CFRelease(code);
    return trusted;
}

static void say(NSString *line) {
    printf("%s\n", line.UTF8String);
    fflush(stdout);
}

static AXUIElementRef find(AXUIElementRef item, NSString *identifier, int depth, NSMutableString *trace) {
    if (depth > 12) {
        [trace appendFormat:@" depth_limit:%d", depth];
        return NULL;
    }
    CFTypeRef value = NULL;
    AXError identifierError = AXUIElementCopyAttributeValue(item, kAXIdentifierAttribute, &value);
    [trace appendFormat:@" id:%d", identifierError];
    if (identifierError == kAXErrorSuccess) {
        BOOL match = [(__bridge NSString *)value isEqualToString:identifier];
        CFRelease(value);
        if (match) return (AXUIElementRef)CFRetain(item);
    }
    CFArrayRef children = NULL;
    AXError childrenError = AXUIElementCopyAttributeValue(item, kAXChildrenAttribute, (CFTypeRef *)&children);
    [trace appendFormat:@" children:%d", childrenError];
    if (childrenError != kAXErrorSuccess) return NULL;
    CFIndex count = CFArrayGetCount(children);
    [trace appendFormat:@" child_count:%ld", (long)count];
    AXUIElementRef found = NULL;
    for (CFIndex i = 0; !found && i < count; i++) {
        found = find(CFArrayGetValueAtIndex(children, i), identifier, depth + 1, trace);
    }
    CFRelease(children);
    return found;
}

@interface Guardian : NSObject
@property(nonatomic) NSMutableArray<NSWindow *> *covers;
@property(nonatomic) BOOL armed, allowAnswered, unlocked, ending, ownerInput;
@property(nonatomic) int listener;
@property(nonatomic) dispatch_source_t listening;
@property(nonatomic, copy) NSString *socketPath;
@property(nonatomic) NSDate *started;
@property(nonatomic) NSMutableString *unlockTrace;
@property(nonatomic) BOOL pluginRequestSeen;
@end

@implementation Guardian

- (void)cover {
    for (NSWindow *window in self.covers) [window orderOut:nil];
    self.covers = [NSMutableArray array];
    for (NSScreen *screen in NSScreen.screens) {
        NSWindow *window = [[NSWindow alloc] initWithContentRect:screen.frame styleMask:NSWindowStyleMaskBorderless
                                                         backing:NSBackingStoreBuffered defer:NO screen:screen];
        window.releasedWhenClosed = NO;
        window.backgroundColor = [NSColor colorWithRed:0.04 green:0.11 blue:0.26 alpha:0.999];
        window.opaque = NO;
        window.level = CGShieldingWindowLevel() + 1;
        window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorStationary
            | NSWindowCollectionBehaviorFullScreenAuxiliary;
        window.ignoresMouseEvents = YES;
        window.canHide = NO;
        window.sharingType = NSWindowSharingNone;
        NSTextField *title = [NSTextField labelWithString:@"HyperNeo is using this Mac"];
        title.font = [NSFont systemFontOfSize:44 weight:NSFontWeightBold];
        title.textColor = NSColor.whiteColor;
        NSTextField *since = [NSTextField labelWithString:[NSString stringWithFormat:@"Working since %@",
            [NSDateFormatter localizedStringFromDate:self.started dateStyle:NSDateFormatterNoStyle timeStyle:NSDateFormatterShortStyle]]];
        since.font = [NSFont systemFontOfSize:20 weight:NSFontWeightMedium];
        since.textColor = [NSColor colorWithRed:0.55 green:0.78 blue:1 alpha:1];
        NSTextField *hint = [NSTextField labelWithString:@"To stop, touch the keyboard, mouse or trackpad. The Mac locks again right away."];
        hint.font = [NSFont systemFontOfSize:20];
        hint.textColor = [NSColor colorWithWhite:0.85 alpha:1];
        NSStackView *stack = [NSStackView stackViewWithViews:@[ title, since, hint ]];
        stack.orientation = NSUserInterfaceLayoutOrientationVertical;
        stack.spacing = 18;
        stack.translatesAutoresizingMaskIntoConstraints = NO;
        [window.contentView addSubview:stack];
        [stack.centerXAnchor constraintEqualToAnchor:window.contentView.centerXAnchor].active = YES;
        [stack.centerYAnchor constraintEqualToAnchor:window.contentView.centerYAnchor].active = YES;
        [window orderFrontRegardless];
        [self.covers addObject:window];
    }
    say([NSString stringWithFormat:@"covered %lu", (unsigned long)self.covers.count]);
}

- (BOOL)listen {
    self.socketPath = [NSString stringWithFormat:@"/private/tmp/io.hyperneo.locked-use.%u.sock", getuid()];
    unlink(self.socketPath.fileSystemRepresentation);
    struct sockaddr_un address = {.sun_family = AF_UNIX};
    strlcpy(address.sun_path, self.socketPath.fileSystemRepresentation, sizeof address.sun_path);
    self.listener = socket(AF_UNIX, SOCK_STREAM, 0);
    if (self.listener < 0 || bind(self.listener, (struct sockaddr *)&address, sizeof address)
        || chmod(address.sun_path, 0600) || listen(self.listener, 4)) return NO;
    dispatch_source_t source = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, self.listener, 0, dispatch_get_main_queue());
    dispatch_source_set_event_handler(source, ^{
        int client = accept(self.listener, NULL, NULL);
        if (client < 0) return;
        char request = 0;
        struct timeval deadline = {.tv_sec = 1};
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &deadline, sizeof deadline);
        BOOL requested = read(client, &request, 1) == 1 && request == '?';
        BOOL grant = requested && self.armed && !self.ending && !self.allowAnswered;
        if (requested) self.pluginRequestSeen = YES;
        self.armed = NO;
        if (grant) self.allowAnswered = YES;
        if (write(client, grant ? "1" : "0", 1) == 1 && grant) say(@"allow_answered");
        close(client);
    });
    dispatch_resume(source);
    self.listening = source;
    return YES;
}

- (void)reportUnlockDiagnostics {
    if (!self.unlockTrace) return;
    say([NSString stringWithFormat:@"%@ plugin_request_seen=%d", self.unlockTrace, self.pluginRequestSeen]);
    self.unlockTrace = nil;
}

- (void)unlock:(BOOL)axTrusted {
    IOPMAssertionID wake = 0;
    IOReturn wakeResult = IOPMAssertionDeclareUserActivity(CFSTR("HyperNeo Locked Use"), kIOPMUserActiveLocal, &wake);
    NSRunningApplication *login = [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.apple.loginwindow"].firstObject;
    pid_t loginPID = login.processIdentifier;
    NSMutableString *trace = [NSMutableString stringWithFormat:@"unlock_diagnostics ax_trusted=%d loginwindow_pid=%d wake=%d",
                              axTrusted, loginPID, wakeResult];
    self.unlockTrace = trace;
    if (!login) return [self end:@"no_login_window"];
    AXUIElementRef app = AXUIElementCreateApplication(loginPID);
    AXError timeoutError = AXUIElementSetMessagingTimeout(app, 0.5);
    [trace appendFormat:@" messaging_timeout=%d", timeoutError];
    __block int tries = 0;
    [NSTimer scheduledTimerWithTimeInterval:0.2 repeats:YES block:^(NSTimer *timer) {
        if (self.ending || self.ownerInput) {
            [timer invalidate];
            CFRelease(app);
            return;
        }
        if (!screenLocked()) {
            [timer invalidate];
            CFRelease(app);
            self.unlocked = YES;
            [self reportUnlockDiagnostics];
            return say(@"unlocked");
        }
        if (++tries > 40) {
            [timer invalidate];
            CFRelease(app);
            return [self end:@"unlock_failed"];
        }
        if (self.allowAnswered || tries % 10 != 1) return;
        [trace appendFormat:@" try=%d field=[", tries];
        AXUIElementRef field = find(app, @"UserPasswordTextField", 0, trace);
        [trace appendFormat:@"] field_found=%d", field != NULL];
        if (field) {
            AXError setError = AXUIElementSetAttributeValue(field, kAXValueAttribute, CFSTR("hyperneo-locked-use"));
            [trace appendFormat:@" set=%d", setError];
            if (setError == kAXErrorSuccess) {
                self.armed = YES;
                [trace appendString:@" go=["];
                AXUIElementRef go = find(app, @"LUIBUTTON_GO", 0, trace);
                AXError actionError = AXUIElementPerformAction(go ?: field, go ? kAXPressAction : kAXConfirmAction);
                [trace appendFormat:@"] %@=%d", go ? @"press" : @"confirm", actionError];
                if (go) CFRelease(go);
            }
            CFRelease(field);
        }
    }];
}

- (void)end:(NSString *)reason {
    if (self.ending) return;
    self.ending = YES;
    self.armed = NO;
    unlink(self.socketPath.fileSystemRepresentation);
    BOOL locked = screenLocked();
    __block BOOL awaitingUnlock = self.allowAnswered && !self.unlocked && locked;
    NSTimeInterval started = NSProcessInfo.processInfo.systemUptime;
    if (!locked) lockScreen();
    [NSTimer scheduledTimerWithTimeInterval:0.1 repeats:YES block:^(NSTimer *timer) {
        NSTimeInterval elapsed = NSProcessInfo.processInfo.systemUptime - started;
        BOOL locked = screenLocked();
        if (awaitingUnlock) {
            if (locked && elapsed < 5) return;
            lockScreen();
            awaitingUnlock = NO;
            return;
        }
        if (locked || elapsed >= 10) {
            [timer invalidate];
            [self reportUnlockDiagnostics];
            say([NSString stringWithFormat:@"ended %@%@", reason, locked ? @"" : @" relock_failed"]);
            exit(locked ? 0 : 3);
        }
    }];
}

- (void)ownerDidAct {
    if (self.ownerInput) return;
    self.ownerInput = YES;
    self.armed = NO;
    say(@"owner_input");
    dispatch_async(dispatch_get_main_queue(), ^{ [self end:@"local_input"]; });
}

@end

static CGEventRef onInput(CGEventTapProxy proxy, CGEventType type, CGEventRef event, void *context) {
    (void)proxy;
    Guardian *guardian = (__bridge Guardian *)context;
    if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput
        || CGEventGetIntegerValueField(event, kCGEventSourceUnixProcessID) == 0) {
        [guardian ownerDidAct];
    }
    return event;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        double seconds = argc > 1 ? atof(argv[1]) : 0;
        if (seconds <= 0) seconds = 60;
        if (!ownerIsHyperNeo(getppid())) return say(@"ended untrusted_owner"), 2;
        NSMutableArray<NSString *> *refused = [NSMutableArray array];
        if (!pluginInstalled()) [refused addObject:@"not_installed"];
        if (!screenLocked()) [refused addObject:@"not_locked"];
        BOOL axTrusted = AXIsProcessTrusted();
        if (!axTrusted) [refused addObject:@"accessibility_required"];
        if (!CGPreflightListenEventAccess()) [refused addObject:@"input_monitoring_required"];
        if (refused.count) {
            say([NSString stringWithFormat:@"unlock_diagnostics ax_trusted=%d", axTrusted]);
            return say([@"ended " stringByAppendingString:[refused componentsJoinedByString:@" "]]), 2;
        }
        [NSApplication sharedApplication].activationPolicy = NSApplicationActivationPolicyAccessory;
        Guardian *guardian = [Guardian new];
        guardian.started = NSDate.date;
        IOPMAssertionID awake = 0;
        IOPMAssertionCreateWithName(kIOPMAssertPreventUserIdleDisplaySleep, kIOPMAssertionLevelOn,
                                    CFSTR("HyperNeo Locked Use cover"), &awake);
        CGEventMask mask = CGEventMaskBit(kCGEventKeyDown) | CGEventMaskBit(kCGEventKeyUp) | CGEventMaskBit(kCGEventFlagsChanged)
            | CGEventMaskBit(kCGEventLeftMouseDown) | CGEventMaskBit(kCGEventRightMouseDown)
            | CGEventMaskBit(kCGEventOtherMouseDown) | CGEventMaskBit(kCGEventMouseMoved)
            | CGEventMaskBit(kCGEventLeftMouseUp) | CGEventMaskBit(kCGEventRightMouseUp) | CGEventMaskBit(kCGEventOtherMouseUp)
            | CGEventMaskBit(kCGEventLeftMouseDragged) | CGEventMaskBit(kCGEventRightMouseDragged)
            | CGEventMaskBit(kCGEventOtherMouseDragged) | CGEventMaskBit(kCGEventScrollWheel);
        CFMachPortRef tap = CGEventTapCreate(kCGHIDEventTap, kCGHeadInsertEventTap, kCGEventTapOptionListenOnly,
                                             mask, onInput, (__bridge void *)guardian);
        if (!tap) return say(@"ended input_monitoring_required"), 2;
        CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(NULL, tap, 0), kCFRunLoopCommonModes);
        if (![guardian listen]) return say(@"ended socket_failed"), 2;
        [guardian cover];
        [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidChangeScreenParametersNotification object:nil
                                                         queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            (void)note;
            if (!guardian.ending) [guardian cover];
        }];
        [NSWorkspace.sharedWorkspace.notificationCenter addObserverForName:NSWorkspaceSessionDidResignActiveNotification object:nil
                                                                     queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *note) {
            (void)note;
            [guardian end:@"session_switched"];
        }];
        __block NSTimeInterval active = NSProcessInfo.processInfo.systemUptime;
        [NSTimer scheduledTimerWithTimeInterval:0.5 repeats:YES block:^(NSTimer *timer) {
            if (guardian.unlocked && !guardian.ending && screenLocked()) [guardian end:@"locked_elsewhere"];
            if (NSProcessInfo.processInfo.systemUptime - active > seconds) [guardian end:@"idle"];
            if (guardian.ending) [timer invalidate];
        }];
        dispatch_source_t input = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, STDIN_FILENO, 0, dispatch_get_main_queue());
        dispatch_source_set_event_handler(input, ^{
            char buffer[64];
            ssize_t count = read(STDIN_FILENO, buffer, sizeof buffer);
            if (count <= 0 || memmem(buffer, (size_t)count, "stop", 4)) [guardian end:count <= 0 ? @"owner_gone" : @"stopped"];
            else active = NSProcessInfo.processInfo.systemUptime;
        });
        dispatch_resume(input);
        [guardian unlock:axTrusted];
        [NSApp run];
    }
    return 0;
}
