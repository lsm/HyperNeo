#pragma once
// Compiled into the guardian and its headless fixture.
#import <ImageIO/ImageIO.h>
#include <fcntl.h>
#include <sys/stat.h>

static NSString *const SystemWallpaperRoot = @"/System/Library/";
static NSString *const LibraryWallpaperRoot = @"/Library/Desktop Pictures/";
static const off_t WallpaperByteLimit = 64 * 1024 * 1024;

static NSString *wallpaperPath(NSString *path) {
    if (![path hasPrefix:@"/"]) return nil;
    NSMutableArray<NSString *> *parts = [NSMutableArray array];
    for (NSString *part in [path componentsSeparatedByString:@"/"]) {
        if ([part isEqualToString:@"."] || [part isEqualToString:@".."]) return nil;
        if (part.length) [parts addObject:part];
    }
    return [@"/" stringByAppendingString:[parts componentsJoinedByString:@"/"]];
}

static int openWallpaper(NSURL *url) {
    NSString *path = url.isFileURL && !url.baseURL && !url.host.length ? wallpaperPath(url.path) : nil;
    BOOL system = [path hasPrefix:SystemWallpaperRoot];
    if (!system && ![path hasPrefix:LibraryWallpaperRoot]) return -1;

    int fd = open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW_ANY);
    if (fd >= 0 || errno != ELOOP || !system) return fd;

    NSString *parent = path.stringByDeletingLastPathComponent;
    int directory = openat(AT_FDCWD, parent.fileSystemRepresentation, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY);
    if (directory < 0) return -1;
    char link[PATH_MAX];
    ssize_t length = readlinkat(directory, path.lastPathComponent.fileSystemRepresentation, link, sizeof link);
    close(directory);
    if (length <= 0 || length == sizeof link) return -1;
    NSString *target = [[NSString alloc] initWithBytes:link length:(NSUInteger)length encoding:NSUTF8StringEncoding];
    if (!target) return -1;
    if (![target hasPrefix:@"/"]) target = [NSString stringWithFormat:@"%@/%@", parent, target];
    target = wallpaperPath(target);
    return [target hasPrefix:SystemWallpaperRoot] ? open(target.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW_ANY) : -1;
}

static NSData *wallpaperData(NSURL *url) {
    int fd = openWallpaper(url);
    if (fd < 0) return nil;
    struct stat file;
    NSMutableData *data = nil;
    if (fstat(fd, &file) == 0 && S_ISREG(file.st_mode) && file.st_uid == 0
        && file.st_size > 0 && file.st_size <= WallpaperByteLimit) {
        data = [NSMutableData dataWithLength:(NSUInteger)file.st_size];
        unsigned char *bytes = data.mutableBytes;
        ssize_t remaining = (ssize_t)data.length;
        while (remaining > 0) {
            ssize_t count = read(fd, bytes, (size_t)remaining);
            if (count <= 0) {
                data = nil;
                break;
            }
            bytes += count;
            remaining -= count;
        }
    }
    close(fd);
    return data;
}

static CGImageRef decodeWallpaper(NSURL *url, CGSize pixels) CF_RETURNS_RETAINED {
    NSData *data = wallpaperData(url);
    if (!data) return NULL;
    CGImageSourceRef source = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
    if (!source) return NULL;
    NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(source, 0, NULL));
    double width = [properties[(__bridge NSString *)kCGImagePropertyPixelWidth] doubleValue];
    double height = [properties[(__bridge NSString *)kCGImagePropertyPixelHeight] doubleValue];
    if ([properties[(__bridge NSString *)kCGImagePropertyOrientation] integerValue] >= 5) {
        double swap = width;
        width = height;
        height = swap;
    }
    CGImageRef image = NULL;
    if (width > 0 && height > 0) {
        double scale = MIN(pixels.width / width, pixels.height / height);
        double maxEdge = MAX(1, floor(MAX(width, height) * MIN(1, scale)));
        NSDictionary *options = @{
            (__bridge NSString *)kCGImageSourceCreateThumbnailFromImageAlways: @YES,
            (__bridge NSString *)kCGImageSourceCreateThumbnailWithTransform: @YES,
            (__bridge NSString *)kCGImageSourceShouldCacheImmediately: @YES,
            (__bridge NSString *)kCGImageSourceThumbnailMaxPixelSize: @(maxEdge),
        };
        image = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)options);
    }
    CFRelease(source);
    if (image && (CGImageGetWidth(image) > pixels.width || CGImageGetHeight(image) > pixels.height)) {
        CGImageRelease(image);
        return NULL;
    }
    return image;
}
