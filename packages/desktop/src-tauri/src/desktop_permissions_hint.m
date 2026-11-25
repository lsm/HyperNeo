#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#include <stdbool.h>

@interface HyperNeoAppDragView : NSImageView <NSDraggingSource>
@end

@implementation HyperNeoAppDragView
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }

- (void)mouseDown:(NSEvent *)event {}

- (void)mouseDragged:(NSEvent *)event {
    NSDraggingItem *item = [[NSDraggingItem alloc]
        initWithPasteboardWriter:NSBundle.mainBundle.bundleURL];
    [item setDraggingFrame:self.bounds contents:self.image];
    [self beginDraggingSessionWithItems:@[item] event:event source:self];
}

- (NSDragOperation)draggingSession:(NSDraggingSession *)session
    sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
    return NSDragOperationCopy;
}
@end

static NSRect settings_frame(void) {
    NSRunningApplication *app = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (![app.bundleIdentifier isEqualToString:@"com.apple.systempreferences"])
        return NSZeroRect;
    NSArray<NSDictionary *> *windows = CFBridgingRelease(
        CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID));
    for (NSDictionary *window in windows) {
        if ([window[(__bridge NSString *)kCGWindowOwnerPID] intValue] != app.processIdentifier ||
            [window[(__bridge NSString *)kCGWindowLayer] intValue] != 0)
            continue;
        CGRect bounds;
        NSDictionary *encoded = window[(__bridge NSString *)kCGWindowBounds];
        if (encoded && CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)encoded, &bounds)
            && bounds.size.width >= 300 && bounds.size.height >= 200)
            return NSMakeRect(bounds.origin.x,
                NSMaxY(NSScreen.screens.firstObject.frame) - CGRectGetMaxY(bounds),
                bounds.size.width, bounds.size.height);
    }
    return NSZeroRect;
}

static void place_hint(NSPanel *panel, NSRect settings) {
    NSScreen *display = NSScreen.mainScreen;
    for (NSScreen *screen in NSScreen.screens) {
        if (NSPointInRect(NSMakePoint(NSMidX(settings), NSMidY(settings)), screen.frame)) {
            display = screen;
            break;
        }
    }
    NSRect visible = display.visibleFrame;
    NSSize size = panel.frame.size;
    CGFloat x = NSMaxX(settings) + 12;
    if (x + size.width > NSMaxX(visible)) x = NSMinX(settings) - size.width - 12;
    x = MAX(NSMinX(visible), MIN(x, NSMaxX(visible) - size.width));
    CGFloat top = MAX(NSMinY(visible) + size.height, MIN(NSMaxY(settings), NSMaxY(visible)));
    [panel setFrameTopLeftPoint:NSMakePoint(x, top)];
}

void hyperneo_show_permission_hint(bool screen_recording, bool (*ready)(bool)) {
    static NSTimer *timer;
    static NSPanel *current_panel;
    [timer invalidate];
    [current_panel orderOut:nil];

    NSPanel *panel = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, 286, 76)
        styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
        backing:NSBackingStoreBuffered defer:NO];
    current_panel = panel;
    panel.floatingPanel = YES;
    panel.hidesOnDeactivate = NO;

    HyperNeoAppDragView *icon = [[HyperNeoAppDragView alloc] initWithFrame:NSMakeRect(12, 14, 48, 48)];
    icon.image = [NSWorkspace.sharedWorkspace iconForFile:NSBundle.mainBundle.bundlePath];
    icon.imageScaling = NSImageScaleProportionallyUpOrDown;
    icon.toolTip = @"Drag HyperNeo into the list";
    [panel.contentView addSubview:icon];

    NSTextField *label = [NSTextField labelWithString:@"Turn on the switch next to HyperNeo"];
    label.frame = NSMakeRect(70, 28, 210, 20);
    [panel.contentView addSubview:label];

    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:6];
    timer = [NSTimer timerWithTimeInterval:0.25 repeats:YES block:^(NSTimer *tick) {
        NSRect settings = settings_frame();
        if (ready(screen_recording) || (NSIsEmptyRect(settings) &&
            (panel.visible || deadline.timeIntervalSinceNow <= 0))) {
            [panel orderOut:nil];
            [tick invalidate];
            if (timer == tick) {
                timer = nil;
                current_panel = nil;
            }
        } else if (!NSIsEmptyRect(settings)) {
            place_hint(panel, settings);
            if (!panel.visible) [panel orderFrontRegardless];
        }
    }];
    [NSRunLoop.mainRunLoop addTimer:timer forMode:NSRunLoopCommonModes];
}
