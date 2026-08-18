// @ts-nocheck

import { render, cleanup, waitFor } from '@testing-library/preact';
import { describe, it, expect } from 'vitest';
import { Portal } from '../Portal';

describe('Portal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  describe('Rendering', () => {
    it('should render children into body by default', async () => {
      render(
        <Portal>
          <div class="portal-content">Portal Content</div>
        </Portal>
      );

      await waitFor(() => {
        const content = document.body.querySelector('.portal-content');
        expect(content).toBeTruthy();
        expect(content?.textContent).toBe('Portal Content');
      });
    });

    it('should not render anything in original location', () => {
      const { container } = render(
        <Portal>
          <div class="portal-content">Content</div>
        </Portal>
      );

      expect(container.innerHTML).toBe('');
    });

    it('should render multiple children', async () => {
      render(
        <Portal>
          <div class="child-1">Child 1</div>
          <div class="child-2">Child 2</div>
        </Portal>
      );

      await waitFor(() => {
        const child1 = document.body.querySelector('.child-1');
        const child2 = document.body.querySelector('.child-2');
        expect(child1).toBeTruthy();
        expect(child2).toBeTruthy();
      });
    });

    it('should render text content', async () => {
      render(<Portal>Plain text content</Portal>);

      await waitFor(() => {
        const portalContainer = document.body.querySelector('[data-portal="true"]');
        expect(portalContainer?.textContent).toBe('Plain text content');
      });
    });
  });

  describe('Target Selection', () => {
    it('should render into body by default', async () => {
      render(
        <Portal>
          <div class="default-portal">Content</div>
        </Portal>
      );

      await waitFor(() => {
        const portalContainer = document.body.querySelector('[data-portal="true"]');
        expect(portalContainer?.parentElement).toBe(document.body);
      });
    });

    it('should render into specified selector', async () => {
      const targetDiv = document.createElement('div');
      targetDiv.id = 'portal-target';
      document.body.appendChild(targetDiv);

      render(
        <Portal into="#portal-target">
          <div class="custom-target-content">Content</div>
        </Portal>
      );

      await waitFor(() => {
        const content = targetDiv.querySelector('.custom-target-content');
        expect(content).toBeTruthy();
      });
    });

    it('should render into HTMLElement reference', async () => {
      const targetDiv = document.createElement('div');
      targetDiv.id = 'element-target';
      document.body.appendChild(targetDiv);

      render(
        <Portal into={targetDiv}>
          <div class="element-target-content">Content</div>
        </Portal>
      );

      await waitFor(() => {
        const content = targetDiv.querySelector('.element-target-content');
        expect(content).toBeTruthy();
      });
    });
  });

  describe('Data Attributes', () => {
    it('should have data-portal attribute', async () => {
      render(
        <Portal>
          <div>Content</div>
        </Portal>
      );

      await waitFor(() => {
        const portalContainer = document.body.querySelector('[data-portal="true"]');
        expect(portalContainer).toBeTruthy();
      });
    });

    it('should have data-portal set to "true"', async () => {
      render(
        <Portal>
          <div>Content</div>
        </Portal>
      );

      await waitFor(() => {
        const portalContainer = document.body.querySelector('[data-portal]');
        expect(portalContainer?.getAttribute('data-portal')).toBe('true');
      });
    });
  });

  describe('Cleanup on Unmount', () => {
    it('should remove portal container on unmount', async () => {
      const { unmount } = render(
        <Portal>
          <div class="cleanup-test">Content</div>
        </Portal>
      );

      await waitFor(() => {
        const portalContainer = document.body.querySelector('[data-portal="true"]');
        expect(portalContainer).toBeTruthy();
      });

      unmount();

      await waitFor(() => {
        const portalContainer = document.body.querySelector('[data-portal="true"]');
        expect(portalContainer).toBeNull();
      });
    });

    it('should remove children on unmount', async () => {
      const { unmount } = render(
        <Portal>
          <div class="unmount-child">Child</div>
        </Portal>
      );

      await waitFor(() => {
        const child = document.body.querySelector('.unmount-child');
        expect(child).toBeTruthy();
      });

      unmount();

      await waitFor(() => {
        const child = document.body.querySelector('.unmount-child');
        expect(child).toBeNull();
      });
    });

    it('should handle multiple portals cleanup correctly', async () => {
      const { unmount: unmount1 } = render(
        <Portal>
          <div class="portal-1">Portal 1</div>
        </Portal>
      );

      const { unmount: unmount2 } = render(
        <Portal>
          <div class="portal-2">Portal 2</div>
        </Portal>
      );

      await waitFor(() => {
        expect(document.body.querySelector('.portal-1')).toBeTruthy();
        expect(document.body.querySelector('.portal-2')).toBeTruthy();
      });

      unmount1();

      await waitFor(() => {
        expect(document.body.querySelector('.portal-1')).toBeNull();
        expect(document.body.querySelector('.portal-2')).toBeTruthy();
      });

      unmount2();

      await waitFor(() => {
        expect(document.body.querySelector('.portal-2')).toBeNull();
      });
    });
  });

  describe('Re-rendering', () => {
    it('should update children when props change', async () => {
      const { rerender } = render(
        <Portal>
          <div class="rerender-test">Initial Content</div>
        </Portal>
      );

      await waitFor(() => {
        const content = document.body.querySelector('.rerender-test');
        expect(content?.textContent).toBe('Initial Content');
      });

      rerender(
        <Portal>
          <div class="rerender-test">Updated Content</div>
        </Portal>
      );

      await waitFor(() => {
        const content = document.body.querySelector('.rerender-test');
        expect(content?.textContent).toBe('Updated Content');
      });
    });

    it('should update when target changes', async () => {
      const target1 = document.createElement('div');
      target1.id = 'target-1';
      document.body.appendChild(target1);

      const target2 = document.createElement('div');
      target2.id = 'target-2';
      document.body.appendChild(target2);

      const { unmount } = render(
        <Portal into="#target-1">
          <div class="moving-content">Content</div>
        </Portal>
      );

      await waitFor(() => {
        const content = target1.querySelector('.moving-content');
        expect(content).toBeTruthy();
      });

      unmount();

      render(
        <Portal into="#target-2">
          <div class="moving-content">Content</div>
        </Portal>
      );

      await waitFor(() => {
        const content = target2.querySelector('.moving-content');
        expect(content).toBeTruthy();
      });
    });
  });

  describe('Portal Container', () => {
    it('should create a div container', async () => {
      render(
        <Portal>
          <span>Content</span>
        </Portal>
      );

      await waitFor(() => {
        const portalContainer = document.body.querySelector('[data-portal="true"]');
        expect(portalContainer?.tagName.toLowerCase()).toBe('div');
      });
    });

    it('should be appended as last child of target', async () => {
      const existingDiv = document.createElement('div');
      existingDiv.className = 'existing-content';
      document.body.appendChild(existingDiv);

      render(
        <Portal>
          <div class="portal-content">Content</div>
        </Portal>
      );

      await waitFor(() => {
        const children = Array.from(document.body.children);
        const portalContainer = document.body.querySelector('[data-portal="true"]');
        const portalIndex = children.indexOf(portalContainer!);

        expect(portalIndex).toBeGreaterThan(0);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle undefined children', async () => {
      render(<Portal>{undefined}</Portal>);

      await waitFor(() => {
        const portalContainer = document.body.querySelector('[data-portal="true"]');
        expect(portalContainer).toBeTruthy();
        expect(portalContainer?.innerHTML).toBe('');
      });
    });

    it('should handle null children', async () => {
      render(<Portal>{null}</Portal>);

      await waitFor(() => {
        const portalContainer = document.body.querySelector('[data-portal="true"]');
        expect(portalContainer).toBeTruthy();
      });
    });

    it('should handle empty fragment', async () => {
      render(
        <Portal>
          <></>
        </Portal>
      );

      await waitFor(() => {
        const portalContainer = document.body.querySelector('[data-portal="true"]');
        expect(portalContainer).toBeTruthy();
      });
    });

    it('should handle conditional children', async () => {
      const showContent = true;
      render(<Portal>{showContent && <div class="conditional">Show</div>}</Portal>);

      await waitFor(() => {
        const content = document.body.querySelector('.conditional');
        expect(content).toBeTruthy();
      });
    });

    it('should not mount if target does not exist', async () => {
      render(
        <Portal into="#non-existent-target">
          <div class="orphan-content">Content</div>
        </Portal>
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      const content = document.body.querySelector('.orphan-content');
      expect(content).toBeNull();
    });
  });
});
