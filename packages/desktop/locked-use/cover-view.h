static NSColor *coverBlue(void) {
    return [NSColor colorWithRed:0.04 green:0.11 blue:0.26 alpha:1];
}

@interface CoverView : NSView
@property(nonatomic) NSImage *wallpaper, *icon;
@end

@implementation CoverView

- (void)drawRect:(NSRect)dirtyRect {
    (void)dirtyRect;
    NSRect frame = self.bounds;
    [coverBlue() setFill];
    NSRectFill(frame);
    if (self.wallpaper) {
        NSSize size = self.wallpaper.size;
        CGFloat scale = MAX(NSWidth(frame) / size.width, NSHeight(frame) / size.height);
        NSSize scaled = NSMakeSize(size.width * scale, size.height * scale);
        [self.wallpaper drawInRect:NSMakeRect(NSMidX(frame) - scaled.width / 2, NSMidY(frame) - scaled.height / 2,
                                             scaled.width, scaled.height)];
    }

    NSString *title = @"HyperNeo is using this Mac";
    NSString *hint = @"To stop, touch the keyboard, mouse or trackpad. The Mac locks again right away.";
    NSMutableParagraphStyle *paragraph = [NSMutableParagraphStyle new];
    paragraph.alignment = NSTextAlignmentCenter;
    NSShadow *shadow = [NSShadow new];
    shadow.shadowColor = [NSColor colorWithWhite:0 alpha:0.65];
    shadow.shadowBlurRadius = 4;
    shadow.shadowOffset = NSMakeSize(0, -1);
    NSDictionary *titleStyle = @{
        NSFontAttributeName: [NSFont systemFontOfSize:32 weight:NSFontWeightSemibold],
        NSForegroundColorAttributeName: NSColor.whiteColor,
        NSParagraphStyleAttributeName: paragraph,
        NSShadowAttributeName: shadow,
    };
    NSMutableDictionary *hintStyle = [titleStyle mutableCopy];
    hintStyle[NSFontAttributeName] = [NSFont systemFontOfSize:16];
    CGFloat width = MIN(NSWidth(frame) - 32, 720);
    NSStringDrawingOptions options = NSStringDrawingUsesLineFragmentOrigin | NSStringDrawingUsesFontLeading;
    NSSize limits = NSMakeSize(width, CGFLOAT_MAX);
    CGFloat titleHeight = ceil([title boundingRectWithSize:limits options:options attributes:titleStyle].size.height);
    CGFloat hintHeight = ceil([hint boundingRectWithSize:limits options:options attributes:hintStyle].size.height);
    NSImage *icon = self.icon;
    if (!icon.isValid || icon.size.width <= 0 || icon.size.height <= 0) icon = nil;
    CGFloat totalHeight = titleHeight + 10 + hintHeight + (icon ? 72 + 16 : 0);
    CGFloat left = NSMidX(frame) - width / 2;
    CGFloat bottom = NSMidY(frame) - totalHeight / 2;
    [hint drawWithRect:NSMakeRect(left, bottom, width, hintHeight) options:options attributes:hintStyle];
    bottom += hintHeight + 10;
    [title drawWithRect:NSMakeRect(left, bottom, width, titleHeight) options:options attributes:titleStyle];
    if (icon) {
        CGFloat scale = 72 / MAX(icon.size.width, icon.size.height);
        NSSize size = NSMakeSize(icon.size.width * scale, icon.size.height * scale);
        [icon drawInRect:NSMakeRect(NSMidX(frame) - size.width / 2, bottom + titleHeight + 16 + (72 - size.height) / 2,
                                    size.width, size.height)];
    }
}

@end
