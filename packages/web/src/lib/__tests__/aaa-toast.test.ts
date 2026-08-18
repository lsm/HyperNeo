// @ts-nocheck

import { toastsSignal, dismissToast, toast } from '../toast';

describe('toastsSignal', () => {
  beforeEach(() => {
    toastsSignal.value = [];
  });

  afterEach(() => {
    toastsSignal.value = [];
  });

  it('should start with empty array', () => {
    expect(toastsSignal.value).toEqual([]);
  });

  it('should be reactive', () => {
    const updates: number[] = [];
    const unsubscribe = toastsSignal.subscribe((toasts) => {
      updates.push(toasts.length);
    });

    toast.info('Test');

    unsubscribe();

    expect(updates.length).toBeGreaterThan(1);
  });
});

describe('toast', () => {
  beforeEach(() => {
    toastsSignal.value = [];
  });

  afterEach(() => {
    toastsSignal.value = [];
  });

  describe('toast.success', () => {
    it('should create a success toast', () => {
      toast.success('Success message');
      expect(toastsSignal.value).toHaveLength(1);
      expect(toastsSignal.value[0].type).toBe('success');
      expect(toastsSignal.value[0].message).toBe('Success message');
    });

    it('should accept custom duration', () => {
      toast.success('Success', 10000);
      expect(toastsSignal.value[0].duration).toBe(10000);
    });

    it('should return toast id', () => {
      const id = toast.success('Test');
      expect(id).toMatch(/^toast-\d+$/);
    });
  });

  describe('toast.error', () => {
    it('should create an error toast', () => {
      toast.error('Error message');
      expect(toastsSignal.value).toHaveLength(1);
      expect(toastsSignal.value[0].type).toBe('error');
      expect(toastsSignal.value[0].message).toBe('Error message');
    });

    it('should accept custom duration', () => {
      toast.error('Error', 3000);
      expect(toastsSignal.value[0].duration).toBe(3000);
    });
  });

  describe('toast.info', () => {
    it('should create an info toast', () => {
      toast.info('Info message');
      expect(toastsSignal.value).toHaveLength(1);
      expect(toastsSignal.value[0].type).toBe('info');
      expect(toastsSignal.value[0].message).toBe('Info message');
    });
  });

  describe('toast.warning', () => {
    it('should create a warning toast', () => {
      toast.warning('Warning message');
      expect(toastsSignal.value).toHaveLength(1);
      expect(toastsSignal.value[0].type).toBe('warning');
      expect(toastsSignal.value[0].message).toBe('Warning message');
    });
  });

  describe('default duration', () => {
    it('should use 5000ms as default duration', () => {
      toast.info('Default duration');
      expect(toastsSignal.value[0].duration).toBe(5000);
    });
  });

  describe('multiple toasts', () => {
    it('should add multiple toasts', () => {
      toast.success('First');
      toast.error('Second');
      toast.info('Third');

      expect(toastsSignal.value).toHaveLength(3);
      expect(toastsSignal.value[0].message).toBe('First');
      expect(toastsSignal.value[1].message).toBe('Second');
      expect(toastsSignal.value[2].message).toBe('Third');
    });

    it('should assign unique ids', () => {
      const id1 = toast.success('First');
      const id2 = toast.success('Second');
      const id3 = toast.success('Third');

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });
  });

  describe('auto-dismiss', () => {
    it('should auto-dismiss after duration', async () => {
      toast.info('Auto-dismiss', 50);

      expect(toastsSignal.value).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(toastsSignal.value).toHaveLength(0);
    });

    it('should not auto-dismiss when duration is 0', async () => {
      toast.info('No auto-dismiss', 0);

      expect(toastsSignal.value).toHaveLength(1);

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(toastsSignal.value).toHaveLength(1);
    });
  });
});

describe('dismissToast', () => {
  beforeEach(() => {
    toastsSignal.value = [];
  });

  afterEach(() => {
    toastsSignal.value = [];
  });

  it('should remove toast by id', () => {
    const id1 = toast.success('First');
    const id2 = toast.success('Second');
    const id3 = toast.success('Third');

    expect(toastsSignal.value).toHaveLength(3);

    dismissToast(id2);

    expect(toastsSignal.value).toHaveLength(2);
    expect(toastsSignal.value.find((t) => t.id === id2)).toBeUndefined();
    expect(toastsSignal.value.find((t) => t.id === id1)).toBeDefined();
    expect(toastsSignal.value.find((t) => t.id === id3)).toBeDefined();
  });

  it('should not throw for non-existent id', () => {
    toast.success('Test');
    expect(() => dismissToast('nonexistent-id')).not.toThrow();
    expect(toastsSignal.value).toHaveLength(1);
  });

  it('should handle empty toasts array', () => {
    expect(() => dismissToast('any-id')).not.toThrow();
    expect(toastsSignal.value).toHaveLength(0);
  });

  it('should allow dismissing all toasts', () => {
    const id1 = toast.success('First');
    const id2 = toast.error('Second');

    dismissToast(id1);
    dismissToast(id2);

    expect(toastsSignal.value).toHaveLength(0);
  });
});

describe('Toast interface', () => {
  beforeEach(() => {
    toastsSignal.value = [];
  });

  afterEach(() => {
    toastsSignal.value = [];
  });

  it('should have required properties', () => {
    toast.info('Test message');
    const t = toastsSignal.value[0];

    expect(t).toHaveProperty('id');
    expect(t).toHaveProperty('type');
    expect(t).toHaveProperty('message');
    expect(t).toHaveProperty('duration');
  });

  it('should have correct types for properties', () => {
    toast.warning('Warning', 8000);
    const t = toastsSignal.value[0];

    expect(typeof t.id).toBe('string');
    expect(typeof t.type).toBe('string');
    expect(typeof t.message).toBe('string');
    expect(typeof t.duration).toBe('number');
  });
});

describe('Toast ID generation', () => {
  beforeEach(() => {
    toastsSignal.value = [];
  });

  afterEach(() => {
    toastsSignal.value = [];
  });

  it('should generate incremental IDs', () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(toast.info(`Toast ${i}`));
    }

    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(5);

    ids.forEach((id) => {
      expect(id).toMatch(/^toast-\d+$/);
    });
  });
});
