#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <ImageIO/ImageIO.h>
#include <dlfcn.h>
#include <string.h>
#include "check-cover-wallpaper.h"

@interface FixtureScreen : NSObject
@property NSRect frame;
@property NSURL *wallpaperURL;
- (NSRect)convertRectToBacking:(NSRect)rect;
+ (NSArray<FixtureScreen *> *)screens;
@end

static NSArray<FixtureScreen *> *screens;
static BOOL locked = YES;
static BOOL truncateCover;

@implementation FixtureScreen
+ (NSArray<FixtureScreen *> *)screens { return screens; }
- (NSRect)convertRectToBacking:(NSRect)rect { return rect; }
@end

@interface FixtureWindow : NSObject
@property BOOL releasedWhenClosed, opaque, ignoresMouseEvents, canHide;
@property NSColor *backgroundColor;
@property NSInteger level;
@property NSWindowCollectionBehavior collectionBehavior;
@property NSWindowSharingType sharingType;
@property NSView *contentView;
@property CGFloat alphaValue;
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
        _alphaValue = 1;
    }
    return self;
}
- (void)orderFrontRegardless {
    if (truncateCover && self.frame.size.width == screens.lastObject.frame.size.width) {
        self.frame = NSInsetRect(self.frame, 1, 1);
    }
    [visibleWindows addObject:self];
}
- (void)orderOut:(id)sender { [visibleWindows removeObjectIdenticalTo:self]; }
@end

@interface FixtureWorkspace : NSObject
@property NSNotificationCenter *notificationCenter;
+ (instancetype)sharedWorkspace;
- (NSURL *)desktopImageURLForScreen:(FixtureScreen *)screen;
@end

@implementation FixtureWorkspace
+ (instancetype)sharedWorkspace { return [self new]; }
- (NSURL *)desktopImageURLForScreen:(FixtureScreen *)screen {
    if (!NSThread.isMainThread || visibleWindows.count != screens.count) exit(5);
    for (NSUInteger index = 0; index < screens.count; index++) {
        FixtureWindow *window = visibleWindows[index];
        if (!window.opaque || window.backgroundColor.alphaComponent != 1 || window.alphaValue != 1
            || !NSEqualRects(window.frame, screens[index].frame)) exit(5);
    }
    return screen.wallpaperURL;
}
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

static dispatch_group_t wallpaperWork;

static void fixtureDispatch(dispatch_queue_t queue, dispatch_block_t block) {
    if (wallpaperWork) dispatch_group_async(wallpaperWork, queue, block);
    else dispatch_async(queue, block);
}

#define NSScreen FixtureScreen
#define NSWindow FixtureWindow
#define NSWorkspace FixtureWorkspace
#define CGSessionCopyCurrentDictionary fixtureSession
#define dispatch_async fixtureDispatch
#define dlopen fixtureOpen
#define dlsym fixtureSymbol
#define main guardianMain
#include "guardian.m"
#undef main
#undef dispatch_async

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

static void runFor(NSTimeInterval seconds) {
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:seconds]];
}

static BOOL wallpaperFinished(void) {
    __block BOOL finished = NO;
    dispatch_group_notify(wallpaperWork, dispatch_get_main_queue(), ^{ finished = YES; });
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:1];
    while (!finished && deadline.timeIntervalSinceNow > 0) {
        [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:deadline];
    }
    return finished;
}

static BOOL bothBlue(void) {
    for (FixtureWindow *window in visibleWindows) {
        if (((CoverView *)window.contentView).wallpaper || !window.opaque || window.alphaValue != 1) return NO;
    }
    return YES;
}

static int checkWallpaper(Guardian *guardian, const char *mode) {
    wallpaperWork = dispatch_group_create();
    FixtureScreen *first = screens.firstObject;
    FixtureScreen *second = screens.lastObject;
    if (strcmp(mode, "displays") == 0) {
        first.wallpaperURL = [NSURL URLWithString:@"file:///System/Library/direct.png"];
        second.wallpaperURL = [NSURL URLWithString:@"file:///Library/Desktop%20Pictures/direct.png"];
        [guardian cover];
        if (!bothBlue()) return 1;
        if (!wallpaperFinished()) return 1;
        NSImage *firstImage = ((CoverView *)visibleWindows.firstObject.contentView).wallpaper;
        NSImage *secondImage = ((CoverView *)visibleWindows.lastObject.contentView).wallpaper;
        if (firstImage.size.width != 192 || secondImage.size.width != 128) return 1;
        second.wallpaperURL = [NSURL URLWithString:@"file:///Users/example/Pictures/photo.png"];
        [guardian cover];
        if (!wallpaperFinished()) return 1;
        if (!((CoverView *)visibleWindows.firstObject.contentView).wallpaper
            || ((CoverView *)visibleWindows.lastObject.contentView).wallpaper || atomic_load(&completedReads) != 3) return 1;
        puts("distinct display wallpapers and independent custom-photo fallback");
        return 0;
    }

    slowRead = dispatch_semaphore_create(0);
    releaseRead = dispatch_semaphore_create(0);
    first.wallpaperURL = [NSURL URLWithString:@"file:///System/Library/slow.png"];
    [guardian cover];
    CoverView *initialView = (CoverView *)visibleWindows.firstObject.contentView;
    if (!bothBlue() || dispatch_semaphore_wait(slowRead, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC))) return 1;
    if (strcmp(mode, "late") == 0) {
        runFor(2.05);
    } else if (strcmp(mode, "replaced") == 0) {
        first.wallpaperURL = nil;
        [guardian cover];
    } else {
        locked = NO;
        [guardian end:@"stopped"];
        if (!locked || !bothBlue()) return 1;
        puts("pending wallpaper read did not delay relock");
    }
    dispatch_semaphore_signal(releaseRead);
    if (!wallpaperFinished() || atomic_load(&completedReads) != 1 || initialView.wallpaper || !bothBlue()) return 1;
    printf("%s wallpaper result discarded\n", mode);
    if (!guardian.ending) return 0;
    runFor(2);
    return 1;
}

static BOOL renderCover(NSString *directory, NSString *name, NSSize size, NSData *wallpaper, NSImage *icon) {
    NSInteger width = (NSInteger)size.width, height = (NSInteger)size.height;
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL
        pixelsWide:width pixelsHigh:height bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
        colorSpaceName:NSDeviceRGBColorSpace bytesPerRow:width * 4 bitsPerPixel:32];
    CoverView *view = [[CoverView alloc] initWithFrame:NSMakeRect(0, 0, width, height)];
    view.wallpaper = wallpaper ? [[NSImage alloc] initWithData:wallpaper] : nil;
    view.icon = icon;
    [NSGraphicsContext saveGraphicsState];
    NSGraphicsContext.currentContext = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
    [view drawRect:view.bounds];
    [NSGraphicsContext restoreGraphicsState];
    NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    if (!png || ![png writeToFile:[directory stringByAppendingPathComponent:name] atomically:YES]) return NO;
    printf("preview %s %ldx%ld\n", name.UTF8String, (long)width, (long)height);
    return YES;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc == 4 && strcmp(argv[1], "render") == 0) {
            NSString *directory = @(argv[2]);
            NSImage *icon = [[NSImage alloc] initWithContentsOfFile:@(argv[3])];
            if (!icon.isValid) return 7;
            BOOL rendered = renderCover(directory, @"display-one.png", NSMakeSize(1440, 900),
                                        fixturePicture(1600, 900, NO), icon);
            rendered &= renderCover(directory, @"display-two.png", NSMakeSize(1920, 1080),
                                    fixturePicture(1440, 1080, YES), icon);
            rendered &= renderCover(directory, @"blue-fallback.png", NSMakeSize(1440, 900), nil, icon);
            rendered &= renderCover(directory, @"text-only.png", NSMakeSize(520, 360), nil, [NSImage new]);
            return rendered ? 0 : 7;
        }
        BOOL mismatch = argc > 1 && strcmp(argv[1], "mismatch") == 0;
        FixtureScreen *internal = [FixtureScreen new];
        internal.frame = NSMakeRect(0, 0, 1440, 900);
        FixtureScreen *external = [FixtureScreen new];
        external.frame = NSMakeRect(1440, -240, 2560, 1440);
        screens = @[ internal, external ];
        visibleWindows = [NSMutableArray array];
        Guardian *guardian = [Guardian new];
        guardian.socketPath = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
        if (argc > 1 && !mismatch && strcmp(argv[1], "frames") != 0) {
            picture = fixturePicture(192, 108, NO);
            otherPicture = fixturePicture(128, 96, YES);
            return strcmp(argv[1], "paths") == 0 ? checkPaths() : checkWallpaper(guardian, argv[1]);
        }
        [guardian cover];
        BOOL initial = fullFrames("initial");
        locked = NO;
        guardian.unlocked = YES;
        external.frame = NSMakeRect(-2304, -160, 2304, 1296);
        truncateCover = mismatch;
        [guardian cover];
        if (!mismatch) return fullFrames("resized") && initial ? 0 : 1;
        if (!initial || !locked) return 1;
        [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:2]];
        return 1;
    }
}
