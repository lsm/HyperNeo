/**
 * File utility functions for handling file uploads and conversions
 */

const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

// API limit is 5MB for base64-encoded data
// Base64 encoding increases size by ~33% (4/3 ratio)
// So we limit file size to ~3.75MB to stay under 5MB after encoding
const MAX_FILE_SIZE = 3.75 * 1024 * 1024; // 3.75MB
const MAX_BASE64_SIZE = 5 * 1024 * 1024; // 5MB (API limit)

export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

/**
 * Convert File object to base64 string (without data URL prefix)
 * Validates that the base64 result doesn't exceed API limits
 */
export async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result as string;
      // Remove data URL prefix (e.g., "data:image/png;base64,")
      const base64Data = base64.split(',')[1];

      // Validate base64 size (API limit is 5MB for base64-encoded data)
      const base64SizeBytes = base64Data.length;
      if (base64SizeBytes > MAX_BASE64_SIZE) {
        reject(
          new Error(
            `Image base64 size (${formatFileSize(base64SizeBytes)}) exceeds API limit (${formatFileSize(MAX_BASE64_SIZE)}). Please resize the image before uploading.`
          )
        );
        return;
      }

      resolve(base64Data);
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Validate if file type is a supported image format
 */
function isValidImageType(type: string): type is SupportedImageType {
  return SUPPORTED_IMAGE_TYPES.includes(type as SupportedImageType);
}

/**
 * Validate file size against maximum limit
 */
function isValidFileSize(size: number): boolean {
  return size > 0 && size <= MAX_FILE_SIZE;
}

/**
 * Format file size for display
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`;
}

/**
 * Get maximum file size in MB
 */
function getMaxFileSizeMB(): number {
  return Math.floor((MAX_FILE_SIZE / (1024 * 1024)) * 100) / 100;
}

/**
 * Validate image file and return error message if invalid
 */
export function validateImageFile(file: File): string | null {
  if (!isValidImageType(file.type)) {
    return `Only images are supported (PNG, JPEG, GIF, WebP)`;
  }

  if (!isValidFileSize(file.size)) {
    return `Image must be under ${getMaxFileSizeMB()}MB`;
  }

  return null;
}

/**
 * Extract image files from clipboard items
 */
export function extractImagesFromClipboard(items: DataTransferItemList): File[] {
  const imageFiles: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file' && SUPPORTED_IMAGE_TYPES.includes(item.type as SupportedImageType)) {
      const file = item.getAsFile();
      if (file) {
        imageFiles.push(file);
      }
    }
  }
  return imageFiles;
}
