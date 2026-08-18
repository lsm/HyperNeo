export function ImageDropOverlay() {
  return (
    <div class="absolute inset-0 z-50 flex items-center justify-center bg-dark-900/90 backdrop-blur-sm border-2 border-dashed border-blue-500 rounded-2xl pointer-events-none">
      <div class="text-center">
        <svg
          class="w-16 h-16 mx-auto mb-4 text-blue-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width={2}
            d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
          />
        </svg>
        <p class="text-lg font-medium text-white">Drop images here</p>
        <p class="text-sm text-gray-400 mt-1">PNG, JPG, GIF, or WebP</p>
      </div>
    </div>
  );
}
