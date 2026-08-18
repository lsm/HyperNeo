// @ts-nocheck

import { render, fireEvent, cleanup } from '@testing-library/preact';
import type { MessageImage } from '@hyperneo/shared/types';
import { AttachmentPreview } from '../AttachmentPreview';

type AttachmentWithMeta = MessageImage & { name: string; size: number };

describe('AttachmentPreview', () => {
  const mockOnRemove = vi.fn(() => {});

  const minimalPngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  const mockAttachments: AttachmentWithMeta[] = [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: minimalPngBase64,
      },
      media_type: 'image/png',
      data: minimalPngBase64,
      name: 'screenshot.png',
      size: 1024,
    },
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: minimalPngBase64,
      },
      media_type: 'image/jpeg',
      data: minimalPngBase64,
      name: 'photo.jpg',
      size: 2048000,
    },
  ];

  beforeEach(() => {
    cleanup();
    mockOnRemove.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  describe('Basic Rendering', () => {
    it('should render nothing when attachments array is empty', () => {
      const { container } = render(<AttachmentPreview attachments={[]} onRemove={mockOnRemove} />);

      expect(container.children.length).toBe(0);
    });

    it('should render attachment thumbnails', () => {
      const { container } = render(
        <AttachmentPreview attachments={mockAttachments} onRemove={mockOnRemove} />
      );

      const images = container.querySelectorAll('img');
      expect(images.length).toBe(2);
    });

    it('should render correct number of attachment items', () => {
      const { container } = render(
        <AttachmentPreview attachments={mockAttachments} onRemove={mockOnRemove} />
      );

      const attachmentItems = container.querySelectorAll('.group');
      expect(attachmentItems.length).toBe(2);
    });
  });

  describe('Image Display', () => {
    it('should set correct src with base64 data URI', () => {
      const { container } = render(
        <AttachmentPreview attachments={[mockAttachments[0]]} onRemove={mockOnRemove} />
      );

      const img = container.querySelector('img');
      expect(img?.src).toBe(`data:image/png;base64,${minimalPngBase64}`);
    });

    it('should set alt attribute from file name', () => {
      const { container } = render(
        <AttachmentPreview attachments={[mockAttachments[0]]} onRemove={mockOnRemove} />
      );

      const img = container.querySelector('img');
      expect(img?.alt).toBe('screenshot.png');
    });

    it('should apply object-cover for proper image fitting', () => {
      const { container } = render(
        <AttachmentPreview attachments={[mockAttachments[0]]} onRemove={mockOnRemove} />
      );

      const img = container.querySelector('img');
      expect(img?.className).toContain('object-cover');
    });
  });

  describe('File Info Overlay', () => {
    it('should display file name', () => {
      const { container } = render(
        <AttachmentPreview attachments={[mockAttachments[0]]} onRemove={mockOnRemove} />
      );

      expect(container.textContent).toContain('screenshot.png');
    });

    it('should display formatted file size for small files', () => {
      const { container } = render(
        <AttachmentPreview attachments={[mockAttachments[0]]} onRemove={mockOnRemove} />
      );

      expect(container.textContent).toContain('1');
    });

    it('should display formatted file size for large files', () => {
      const { container } = render(
        <AttachmentPreview attachments={[mockAttachments[1]]} onRemove={mockOnRemove} />
      );

      expect(container.textContent).toContain('MB');
    });

    it('should have hover opacity transition on overlay', () => {
      const { container } = render(
        <AttachmentPreview attachments={[mockAttachments[0]]} onRemove={mockOnRemove} />
      );

      const overlay = container.querySelector('.group-hover\\:opacity-100');
      expect(overlay).toBeTruthy();
    });
  });

  describe('Remove Button', () => {
    it('should render remove button for each attachment', () => {
      const { container } = render(
        <AttachmentPreview attachments={mockAttachments} onRemove={mockOnRemove} />
      );

      const removeButtons = container.querySelectorAll('[aria-label="Remove attachment"]');
      expect(removeButtons.length).toBe(2);
    });

    it('should call onRemove with correct index when clicked', () => {
      const { container } = render(
        <AttachmentPreview attachments={mockAttachments} onRemove={mockOnRemove} />
      );

      const removeButtons = container.querySelectorAll('[aria-label="Remove attachment"]');

      fireEvent.click(removeButtons[0]);
      expect(mockOnRemove).toHaveBeenCalledWith(0);

      fireEvent.click(removeButtons[1]);
      expect(mockOnRemove).toHaveBeenCalledWith(1);
    });

    it('should have remove button with red background', () => {
      const { container } = render(
        <AttachmentPreview attachments={[mockAttachments[0]]} onRemove={mockOnRemove} />
      );

      const removeButton = container.querySelector('[aria-label="Remove attachment"]')!;
      expect(removeButton.className).toContain('bg-red-600');
    });

    it('should have hover effect on remove button', () => {
      const { container } = render(
        <AttachmentPreview attachments={[mockAttachments[0]]} onRemove={mockOnRemove} />
      );

      const removeButton = container.querySelector('[aria-label="Remove attachment"]')!;
      expect(removeButton.className).toContain('hover:bg-red-700');
    });

    it('should have title attribute for accessibility', () => {
      const { container } = render(
        <AttachmentPreview attachments={[mockAttachments[0]]} onRemove={mockOnRemove} />
      );

      const removeButton = container.querySelector('[title="Remove attachment"]');
      expect(removeButton).toBeTruthy();
    });

    it('should have type="button" to prevent form submission', () => {
      const { container } = render(
        <AttachmentPreview attachments={[mockAttachments[0]]} onRemove={mockOnRemove} />
      );

      const removeButton = container.querySelector(
        '[aria-label="Remove attachment"]'
      ) as HTMLButtonElement;
      expect(removeButton.type).toBe('button');
    });
  });

  describe('Styling', () => {
    it('should have container with flex wrap layout', () => {
      const { container } = render(
        <AttachmentPreview attachments={mockAttachments} onRemove={mockOnRemove} />
      );

      const wrapper = container.firstElementChild;
      expect(wrapper?.className).toContain('flex');
      expect(wrapper?.className).toContain('flex-wrap');
    });

    it('should have gap between items', () => {
      const { container } = render(
        <AttachmentPreview attachments={mockAttachments} onRemove={mockOnRemove} />
      );

      const wrapper = container.firstElementChild;
      expect(wrapper?.className).toContain('gap-2');
    });

    it('should have fixed thumbnail size', () => {
      const { container } = render(
        <AttachmentPreview attachments={[mockAttachments[0]]} onRemove={mockOnRemove} />
      );

      const thumbnail = container.querySelector('.group');
      expect(thumbnail?.className).toContain('w-20');
      expect(thumbnail?.className).toContain('h-20');
    });

    it('should have rounded corners on thumbnails', () => {
      const { container } = render(
        <AttachmentPreview attachments={[mockAttachments[0]]} onRemove={mockOnRemove} />
      );

      const thumbnail = container.querySelector('.group');
      expect(thumbnail?.className).toContain('rounded');
    });

    it('should have border on thumbnails', () => {
      const { container } = render(
        <AttachmentPreview attachments={[mockAttachments[0]]} onRemove={mockOnRemove} />
      );

      const thumbnail = container.querySelector('.group');
      expect(thumbnail?.className).toContain('border');
      expect(thumbnail?.className).toContain('border-gray-600');
    });

    it('should have hover border effect', () => {
      const { container } = render(
        <AttachmentPreview attachments={[mockAttachments[0]]} onRemove={mockOnRemove} />
      );

      const thumbnail = container.querySelector('.group');
      expect(thumbnail?.className).toContain('hover:border-gray-500');
    });
  });

  describe('Multiple Attachments', () => {
    it('should render all attachments', () => {
      const threeAttachments: AttachmentWithMeta[] = [
        ...mockAttachments,
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/gif',
            data: minimalPngBase64,
          },
          media_type: 'image/gif',
          data: minimalPngBase64,
          name: 'animation.gif',
          size: 512000,
        },
      ];

      const { container } = render(
        <AttachmentPreview attachments={threeAttachments} onRemove={mockOnRemove} />
      );

      expect(container.textContent).toContain('screenshot.png');
      expect(container.textContent).toContain('photo.jpg');
      expect(container.textContent).toContain('animation.gif');
    });

    it('should maintain correct indices when removing', () => {
      const { container } = render(
        <AttachmentPreview attachments={mockAttachments} onRemove={mockOnRemove} />
      );

      const removeButtons = container.querySelectorAll('[aria-label="Remove attachment"]');

      fireEvent.click(removeButtons[1]);
      expect(mockOnRemove).toHaveBeenLastCalledWith(1);

      fireEvent.click(removeButtons[0]);
      expect(mockOnRemove).toHaveBeenLastCalledWith(0);
    });
  });

  describe('Different Media Types', () => {
    it('should handle PNG images', () => {
      const pngAttachment: AttachmentWithMeta = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: minimalPngBase64,
        },
        media_type: 'image/png',
        data: minimalPngBase64,
        name: 'image.png',
        size: 1000,
      };

      const { container } = render(
        <AttachmentPreview attachments={[pngAttachment]} onRemove={mockOnRemove} />
      );

      const img = container.querySelector('img');
      expect(img?.src).toContain('image/png');
    });

    it('should handle JPEG images', () => {
      const jpegAttachment: AttachmentWithMeta = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/jpeg',
          data: minimalPngBase64,
        },
        media_type: 'image/jpeg',
        data: minimalPngBase64,
        name: 'photo.jpg',
        size: 1000,
      };

      const { container } = render(
        <AttachmentPreview attachments={[jpegAttachment]} onRemove={mockOnRemove} />
      );

      const img = container.querySelector('img');
      expect(img?.src).toContain('image/jpeg');
    });

    it('should handle GIF images', () => {
      const gifAttachment: AttachmentWithMeta = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/gif',
          data: minimalPngBase64,
        },
        media_type: 'image/gif',
        data: minimalPngBase64,
        name: 'animation.gif',
        size: 1000,
      };

      const { container } = render(
        <AttachmentPreview attachments={[gifAttachment]} onRemove={mockOnRemove} />
      );

      const img = container.querySelector('img');
      expect(img?.src).toContain('image/gif');
    });

    it('should handle WebP images', () => {
      const webpAttachment: AttachmentWithMeta = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/webp',
          data: minimalPngBase64,
        },
        media_type: 'image/webp',
        data: minimalPngBase64,
        name: 'image.webp',
        size: 1000,
      };

      const { container } = render(
        <AttachmentPreview attachments={[webpAttachment]} onRemove={mockOnRemove} />
      );

      const img = container.querySelector('img');
      expect(img?.src).toContain('image/webp');
    });
  });
});
