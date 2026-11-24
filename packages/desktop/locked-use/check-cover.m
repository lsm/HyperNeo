#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#include <dlfcn.h>
#include <string.h>

@interface FixtureScreen : NSObject
@property NSRect frame;
+ (NSArray<FixtureScreen *> *)screens;
@end

static NSArray<FixtureScreen *> *screens;
static BOOL locked = YES;
static BOOL truncateCover;

@implementation FixtureScreen
+ (NSArray<FixtureScreen *> *)screens { return screens; }
@end

@interface FixtureFont : NSObject
+ (id)systemFontOfSize:(CGFloat)size;
+ (id)systemFontOfSize:(CGFloat)size weight:(NSFontWeight)weight;
@end

@implementation FixtureFont
+ (id)systemFontOfSize:(CGFloat)size { return nil; }
+ (id)systemFontOfSize:(CGFloat)size weight:(NSFontWeight)weight { return nil; }
@end

@interface FixtureDecoration : NSObject
@property id font, textColor;
@property NSUserInterfaceLayoutOrientation orientation;
@property CGFloat spacing;
@property BOOL translatesAutoresizingMaskIntoConstraints;
@property(readonly) NSLayoutXAxisAnchor *centerXAnchor;
@property(readonly) NSLayoutYAxisAnchor *centerYAnchor;
+ (instancetype)labelWithString:(NSString *)text;
+ (instancetype)stackViewWithViews:(NSArray *)views;
- (void)addSubview:(FixtureDecoration *)view;
@end

@implementation FixtureDecoration
+ (instancetype)labelWithString:(NSString *)text { return [self new]; }
+ (instancetype)stackViewWithViews:(NSArray *)views { return [self new]; }
- (void)addSubview:(FixtureDecoration *)view {}
- (NSLayoutXAxisAnchor *)centerXAnchor { return nil; }
- (NSLayoutYAxisAnchor *)centerYAnchor { return nil; }
@end

@interface FixtureWindow : NSObject
@property BOOL releasedWhenClosed, opaque, ignoresMouseEvents, canHide;
@property NSColor *backgroundColor;
@property NSInteger level;
@property NSWindowCollectionBehavior collectionBehavior;
@property NSWindowSharingType sharingType;
@property(readonly) FixtureDecoration *contentView;
@property NSRect frame;
- (instancetype)initWithContentRect:(NSRect)rect styleMask:(NSWindowStyleMask)style
                           backing:(NSBackingStoreType)backing defer:(BOOL)defer screen:(FixtureScreen *)screen;
- (void)orderFrontRegardless;
- (void)orderOut:(id)sender;
@end

static NSMutableArray<FixtureWindow *> *visibleWindows;

@implementation FixtureWindow
- (instancetype)initWithContentRect:(NSRect)rect styleMask:(NSWindowStyleMask)style
                           backing:(NSBackingStoreType)backing defer:(BOOL)defer screen:(FixtureScreen *)screen {
    self = [super init];
    if (self) {
        // AppKit interprets the initializer's origin relative to the supplied screen.
        NSRect screenFrame = screen.frame;
        rect.origin.x += screenFrame.origin.x;
        rect.origin.y += screenFrame.origin.y;
        _frame = rect;
    }
    return self;
}
- (FixtureDecoration *)contentView { return nil; }
- (void)orderFrontRegardless {
    if (truncateCover && self.frame.size.width == screens.lastObject.frame.size.width) {
        self.frame = NSInsetRect(self.frame, 1, 1);
    }
    [visibleWindows addObject:self];
}
- (void)orderOut:(id)sender { [visibleWindows removeObjectIdenticalTo:self]; }
@end

static CFDictionaryRef fixtureSession(void) {
    return CFBridgingRetain(@{@"CGSSessionScreenIsLocked": @(locked)});
}

static void fixtureLock(void) {
    locked = YES;
    puts("relocked");
}

static void *fixtureOpen(const char *path, int mode) { return (void *)1; }
static void *fixtureSymbol(void *handle, const char *symbol) {
    return strcmp(symbol, "SACLockScreenImmediate") == 0 ? (void *)fixtureLock : NULL;
}

#define NSScreen FixtureScreen
#define NSWindow FixtureWindow
#define NSFont FixtureFont
#define NSTextField FixtureDecoration
#define NSStackView FixtureDecoration
#define CGSessionCopyCurrentDictionary fixtureSession
#define dlopen fixtureOpen
#define dlsym fixtureSymbol
#define main guardianMain
#include "guardian.m"
#undef main

static BOOL fullFrames(const char *phase) {
    if (visibleWindows.count != screens.count) {
        printf("%s visible covers=%lu expected=%lu\n", phase, (unsigned long)visibleWindows.count,
               (unsigned long)screens.count);
        return NO;
    }
    BOOL full = YES;
    for (NSUInteger i = 0; i < screens.count; i++) {
        NSRect actual = visibleWindows[i].frame;
        NSRect expected = screens[i].frame;
        printf("%s display %lu frame %.0f,%.0f %.0fx%.0f expected %.0f,%.0f %.0fx%.0f\n", phase,
               (unsigned long)(i + 1), actual.origin.x, actual.origin.y, actual.size.width, actual.size.height,
               expected.origin.x, expected.origin.y, expected.size.width, expected.size.height);
        BOOL opaque = visibleWindows[i].opaque && visibleWindows[i].backgroundColor.alphaComponent == 1;
        if (!opaque) printf("%s display %lu is not opaque\n", phase, (unsigned long)(i + 1));
        full &= NSEqualRects(actual, expected) && opaque;
    }
    return full;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        BOOL mismatch = argc > 1 && strcmp(argv[1], "mismatch") == 0;
        FixtureScreen *internal = [FixtureScreen new];
        internal.frame = NSMakeRect(0, 0, 1440, 900);
        FixtureScreen *external = [FixtureScreen new];
        external.frame = NSMakeRect(1440, -240, 2560, 1440);
        screens = @[ internal, external ];
        visibleWindows = [NSMutableArray array];
        Guardian *guardian = [Guardian new];
        guardian.started = NSDate.date;
        guardian.socketPath = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
        [guardian cover];
        BOOL initial = fullFrames("initial");
        locked = NO;
        guardian.unlocked = YES;
        external.frame = NSMakeRect(-2304, -160, 2304, 1296);
        truncateCover = mismatch;
        [guardian cover];
        if (!mismatch) return fullFrames("resized") && initial ? 0 : 1;
        if (!initial || !locked) return 1;
        [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:1]];
        return 1;
    }
}
