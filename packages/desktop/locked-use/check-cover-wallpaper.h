#include <fcntl.h>
#include <stdatomic.h>
#include <sys/stat.h>

static NSData *picture, *otherPicture;
static NSMutableString *ioTrace;
static dispatch_semaphore_t slowRead, releaseRead;
static atomic_uint completedReads;
static const int imageFD = 91, directoryFD = 92, otherFD = 93;
static NSString *fileCase;

static void traceIO(NSString *call) {
    if (ioTrace) [ioTrace appendString:call];
}

static int wallpaperOpen(const char *path, int flags) {
    if (flags != (O_RDONLY | O_NOFOLLOW_ANY) || !path) exit(6);
    traceIO(@"O");
    if (!strcmp(path, "/System/Library/CoreServices/DefaultDesktop.heic")
        || !strcmp(path, "/System/Library/intermediate/default.heic")
        || !strcmp(path, "/Library/Desktop Pictures/link.heic")) {
        errno = ELOOP;
        return -1;
    }
    if (!strcmp(path, "/System/Library/Wallpapers/.default/DefaultAerial.heic")
        || !strcmp(path, "/System/Library/CoreServices/Wallpapers/default.heic")) {
        if ([fileCase isEqualToString:@"second-link"]) {
            errno = ELOOP;
            return -1;
        }
        return imageFD;
    }
    if (!strcmp(path, "/System/Library/direct.png")) return imageFD;
    if (!strcmp(path, "/Library/Desktop Pictures/direct.png")) return otherFD;
    if (!strcmp(path, "/System/Library/slow.png")) {
        dispatch_semaphore_signal(slowRead);
        if (dispatch_semaphore_wait(releaseRead, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC))) exit(6);
        return imageFD;
    }
    exit(6);
}

static int wallpaperOpenAt(int fd, const char *path, int flags) {
    traceIO(@"P");
    if (fd != AT_FDCWD || flags != (O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY)) exit(6);
    if (!strcmp(path, "/System/Library/intermediate")) {
        errno = ELOOP;
        return -1;
    }
    if (strcmp(path, "/System/Library/CoreServices") != 0) exit(6);
    return directoryFD;
}

static ssize_t wallpaperReadLink(int fd, const char *name, char *buffer, size_t size) {
    traceIO(@"L");
    if (fd != directoryFD || strcmp(name, "DefaultDesktop.heic") != 0) exit(6);
    const char *target = "/System/Library/Wallpapers/.default/DefaultAerial.heic";
    if ([fileCase isEqualToString:@"relative-link"]) target = "Wallpapers//default.heic";
    if ([fileCase isEqualToString:@"dot-link"]) target = "Wallpapers/../default.heic";
    if ([fileCase isEqualToString:@"outside-link"]) target = "/Library/Desktop Pictures/direct.png";
    if (strlen(target) >= size) exit(6);
    memcpy(buffer, target, strlen(target));
    return (ssize_t)strlen(target);
}

static int wallpaperStat(int fd, struct stat *file) {
    traceIO(@"S");
    if (fd != imageFD && fd != otherFD) exit(6);
    file->st_mode = [fileCase isEqualToString:@"directory"] ? S_IFDIR : S_IFREG;
    file->st_uid = [fileCase isEqualToString:@"non-root"] ? 501 : 0;
    file->st_size = [fileCase isEqualToString:@"oversize"] ? (64 * 1024 * 1024 + 1)
        : (off_t)(fd == imageFD ? picture.length : otherPicture.length);
    return 0;
}

static ssize_t wallpaperRead(int fd, void *buffer, size_t size) {
    traceIO(@"R");
    if (fd != imageFD && fd != otherFD) exit(6);
    NSData *data = fd == imageFD ? picture : otherPicture;
    if (size != data.length) exit(6);
    memcpy(buffer, data.bytes, size);
    atomic_fetch_add(&completedReads, 1);
    return (ssize_t)size;
}

static int wallpaperClose(int fd) {
    if (fd != imageFD && fd != otherFD && fd != directoryFD) exit(6);
    traceIO(@"C");
    return 0;
}

#define open wallpaperOpen
#define openat wallpaperOpenAt
#define readlinkat wallpaperReadLink
#define fstat wallpaperStat
#define read wallpaperRead
#define close wallpaperClose
#include "cover-wallpaper.h"
#undef open
#undef openat
#undef readlinkat
#undef fstat
#undef read
#undef close

static NSData *fixturePicture(size_t width, size_t height, BOOL alternate) {
    CGColorSpaceRef colors = CGColorSpaceCreateDeviceRGB();
    CGContextRef context = CGBitmapContextCreate(NULL, width, height, 8, width * 4, colors,
                                                 (CGBitmapInfo)kCGImageAlphaPremultipliedLast);
    CGColorSpaceRelease(colors);
    CGContextSetRGBFillColor(context, alternate ? 0.68 : 0.13, 0.32, alternate ? 0.20 : 0.62, 1);
    CGContextFillRect(context, CGRectMake(0, 0, width, height));
    CGContextSetRGBFillColor(context, 0.05, alternate ? 0.16 : 0.28, 0.32, 1);
    CGContextFillEllipseInRect(context, CGRectMake(width / 3.0, -0.35 * height, width, height * 0.85));
    CGImageRef image = CGBitmapContextCreateImage(context);
    CGContextRelease(context);
    NSMutableData *data = [NSMutableData data];
    CGImageDestinationRef destination = CGImageDestinationCreateWithData((__bridge CFMutableDataRef)data,
                                                                          CFSTR("public.png"), 1, NULL);
    CGImageDestinationAddImage(destination, image, NULL);
    BOOL written = CGImageDestinationFinalize(destination);
    CFRelease(destination);
    CGImageRelease(image);
    if (!written) exit(6);
    return data;
}

static BOOL checkFile(NSString *name, NSURL *url, NSString *expectedIO, BOOL expectedImage) {
    fileCase = name;
    ioTrace = [NSMutableString string];
    CGImageRef image = decodeWallpaper(url, CGSizeMake(90, 60));
    BOOL pass = (image != NULL) == expectedImage && [ioTrace isEqualToString:expectedIO];
    if (image) {
        size_t width = CGImageGetWidth(image), height = CGImageGetHeight(image);
        pass &= width >= 90 && height >= 60 && (width == 90 || height == 60);
        CGImageRelease(image);
    }
    printf("wallpaper %s %s\n", name.UTF8String, pass ? "PASS" : "FAIL");
    ioTrace = nil;
    fileCase = nil;
    return pass;
}

static BOOL checkDecodedSize(NSString *name, NSURL *url, CGSize display, CGSize expected) {
    CGImageRef image = decodeWallpaper(url, display);
    size_t width = image ? CGImageGetWidth(image) : 0;
    size_t height = image ? CGImageGetHeight(image) : 0;
    BOOL pass = width == expected.width && height == expected.height;
    if (image) CGImageRelease(image);
    printf("wallpaper %s %s (%zux%zu)\n", name.UTF8String, pass ? "PASS" : "FAIL", width, height);
    return pass;
}

static int checkPaths(void) {
    NSURL *system = [NSURL URLWithString:@"file:///System/Library/direct.png"];
    NSURL *library = [NSURL URLWithString:@"file:///Library/Desktop%20Pictures/direct.png"];
    NSURL *aerial = [NSURL URLWithString:@"file:///System/Library/CoreServices/DefaultDesktop.heic"];
    BOOL pass = checkFile(@"system", system, @"OSRC", YES);
    pass &= checkDecodedSize(@"landscape source on portrait display", system, CGSizeMake(64, 72), CGSizeMake(128, 72));
    pass &= checkDecodedSize(@"native source smaller than display", system, CGSizeMake(240, 180), CGSizeMake(192, 108));
    pass &= checkDecodedSize(@"extreme crop falls back", system, CGSizeMake(4, 72), CGSizeZero);
    pass &= checkFile(@"library", library, @"OSRC", YES);
    pass &= checkFile(@"aerial", aerial, @"OPLCOSRC", YES);
    pass &= checkFile(@"relative-link", aerial, @"OPLCOSRC", YES);
    pass &= checkFile(@"dot-link", aerial, @"OPLC", NO);
    pass &= checkFile(@"outside-link", aerial, @"OPLC", NO);
    pass &= checkFile(@"second-link", aerial, @"OPLCO", NO);
    pass &= checkFile(@"intermediate-link", [NSURL URLWithString:@"file:///System/Library/intermediate/default.heic"], @"OP", NO);
    pass &= checkFile(@"library-link", [NSURL URLWithString:@"file:///Library/Desktop%20Pictures/link.heic"], @"O", NO);
    pass &= checkFile(@"directory", system, @"OSC", NO);
    pass &= checkFile(@"non-root", system, @"OSC", NO);
    pass &= checkFile(@"oversize", system, @"OSC", NO);
    pass &= checkFile(@"relative", [NSURL URLWithString:@"direct.png" relativeToURL:system], @"", NO);
    pass &= checkFile(@"dot-component", [NSURL URLWithString:@"file:///System/Library/./direct.png"], @"", NO);
    pass &= checkFile(@"dot-dot-component", [NSURL URLWithString:@"file:///System/Library/../direct.png"], @"", NO);
    pass &= checkFile(@"encoded-dot-component", [NSURL URLWithString:@"file:///System/Library/%2e/direct.png"], @"", NO);
    pass &= checkFile(@"custom-photo", [NSURL URLWithString:@"file:///Users/example/Pictures/photo.png"], @"", NO);
    pass &= checkFile(@"remote", [NSURL URLWithString:@"file://example.invalid/System/Library/direct.png"], @"", NO);
    pass &= checkFile(@"prefix-lookalike", [NSURL URLWithString:@"file:///System/Library-not-allowed/direct.png"], @"", NO);
    NSData *validPicture = picture;
    picture = [@"invalid image" dataUsingEncoding:NSUTF8StringEncoding];
    pass &= checkFile(@"decode-failure", system, @"OSRC", NO);
    picture = validPicture;
    return pass ? 0 : 1;
}
