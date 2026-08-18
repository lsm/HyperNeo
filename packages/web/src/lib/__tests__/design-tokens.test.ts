// @ts-nocheck

import {
  messageSpacing,
  borderRadius,
  messageColors,
  customColors,
  borderColors,
  tokens,
} from '../design-tokens';
import designTokensDefault from '../design-tokens';

describe('messageSpacing', () => {
  describe('user', () => {
    it('should have bubble spacing for mobile', () => {
      expect(messageSpacing.user.bubble.mobile).toBeDefined();
      expect(messageSpacing.user.bubble.mobile).toContain('px-');
      expect(messageSpacing.user.bubble.mobile).toContain('py-');
    });

    it('should have bubble spacing for desktop', () => {
      expect(messageSpacing.user.bubble.desktop).toBeDefined();
      expect(messageSpacing.user.bubble.desktop).toContain('md:');
    });

    it('should have combined bubble spacing', () => {
      expect(messageSpacing.user.bubble.combined).toBeDefined();
      expect(messageSpacing.user.bubble.combined).toContain('px-');
      expect(messageSpacing.user.bubble.combined).toContain('md:');
    });

    it('should have container spacing', () => {
      expect(messageSpacing.user.container.combined).toBeDefined();
      expect(messageSpacing.user.container.combined).toContain('py-');
    });
  });

  describe('assistant', () => {
    it('should have bubble spacing for mobile', () => {
      expect(messageSpacing.assistant.bubble.mobile).toBeDefined();
      expect(messageSpacing.assistant.bubble.mobile).toContain('px-');
    });

    it('should have bubble spacing for desktop', () => {
      expect(messageSpacing.assistant.bubble.desktop).toBeDefined();
    });

    it('should have combined bubble spacing', () => {
      expect(messageSpacing.assistant.bubble.combined).toBeDefined();
    });

    it('should have container spacing', () => {
      expect(messageSpacing.assistant.container.combined).toBeDefined();
    });
  });

  describe('actions', () => {
    it('should have marginTop', () => {
      expect(messageSpacing.actions.marginTop).toBe('mt-2');
    });

    it('should have gap', () => {
      expect(messageSpacing.actions.gap).toBe('gap-2');
    });

    it('should have padding', () => {
      expect(messageSpacing.actions.padding).toBe('px-1');
    });
  });
});

describe('borderRadius', () => {
  describe('message', () => {
    it('should have bubble radius for iMessage style', () => {
      expect(borderRadius.message.bubble).toBe('rounded-[20px]');
    });

    it('should have tool radius', () => {
      expect(borderRadius.message.tool).toBe('rounded-lg');
    });
  });
});

describe('messageColors', () => {
  describe('user', () => {
    it('should have blue background like iMessage', () => {
      expect(messageColors.user.background).toBe('bg-blue-500');
    });

    it('should have white text', () => {
      expect(messageColors.user.text).toBe('text-white');
    });
  });

  describe('assistant', () => {
    it('should have dark background', () => {
      expect(messageColors.assistant.background).toBe('bg-dark-800');
    });

    it('should have white text', () => {
      expect(messageColors.assistant.text).toBe('text-white');
    });
  });
});

describe('customColors', () => {
  describe('lemonYellow', () => {
    it('should have light color', () => {
      expect(customColors.lemonYellow.light).toBe('#FFF44F');
    });

    it('should have dark variant', () => {
      expect(customColors.lemonYellow.dark).toBe('#B8A837');
    });
  });

  describe('canaryYellow', () => {
    it('should have light color', () => {
      expect(customColors.canaryYellow.light).toBe('#FFEF00');
    });

    it('should have dark variant', () => {
      expect(customColors.canaryYellow.dark).toBe('#B8AA00');
    });
  });
});

describe('borderColors', () => {
  describe('ui', () => {
    it('should have default border color', () => {
      expect(borderColors.ui.default).toBe('border-dark-700');
    });

    it('should have secondary border color', () => {
      expect(borderColors.ui.secondary).toBe('border-dark-600');
    });

    it('should have input border color', () => {
      expect(borderColors.ui.input).toBe('border-dark-600');
    });

    it('should have emphasis border color', () => {
      expect(borderColors.ui.emphasis).toBe('border-dark-800');
    });

    it('should have disabled border color', () => {
      expect(borderColors.ui.disabled).toBe('border-dark-700/30');
    });
  });

  describe('tool', () => {
    it('should have file border color', () => {
      expect(borderColors.tool.file).toContain('border-blue');
    });

    it('should have search border color', () => {
      expect(borderColors.tool.search).toContain('border-purple');
    });

    it('should have terminal border color', () => {
      expect(borderColors.tool.terminal).toContain('border-gray');
    });

    it('should have agent border color', () => {
      expect(borderColors.tool.agent).toContain('border-indigo');
    });

    it('should have web border color', () => {
      expect(borderColors.tool.web).toContain('border-green');
    });

    it('should have todo border color', () => {
      expect(borderColors.tool.todo).toContain('border-amber');
    });

    it('should have mcp border color', () => {
      expect(borderColors.tool.mcp).toContain('border-pink');
    });

    it('should have system border color', () => {
      expect(borderColors.tool.system).toContain('border-cyan');
    });

    const toolCategories = [
      'file',
      'search',
      'terminal',
      'agent',
      'web',
      'todo',
      'mcp',
      'system',
    ] as const;

    toolCategories.forEach((category) => {
      it(`should have dark mode variant for ${category}`, () => {
        expect(borderColors.tool[category]).toContain('dark:border-');
      });
    });
  });

  describe('semantic', () => {
    it('should have success color', () => {
      expect(borderColors.semantic.success).toContain('border-green');
    });

    it('should have error color', () => {
      expect(borderColors.semantic.error).toContain('border-red');
    });

    it('should have warning color', () => {
      expect(borderColors.semantic.warning).toContain('border-amber');
    });

    it('should have warning yellow variant', () => {
      expect(borderColors.semantic.warningYellow).toContain('border-yellow');
    });

    it('should have info color', () => {
      expect(borderColors.semantic.info).toContain('border-blue');
    });

    it('should have neutral color', () => {
      expect(borderColors.semantic.neutral).toContain('border-gray');
    });
  });

  describe('interactive', () => {
    it('should have focus state', () => {
      expect(borderColors.interactive.focus).toContain('focus-within:');
    });

    it('should have hover state', () => {
      expect(borderColors.interactive.hover).toContain('hover:');
    });

    it('should have active state', () => {
      expect(borderColors.interactive.active).toContain('border-blue');
    });
  });

  describe('special', () => {
    describe('toast', () => {
      it('should have success toast color', () => {
        expect(borderColors.special.toast.success).toContain('border-green');
      });

      it('should have error toast color', () => {
        expect(borderColors.special.toast.error).toContain('border-red');
      });

      it('should have warning toast color', () => {
        expect(borderColors.special.toast.warning).toContain('border-amber');
      });

      it('should have info toast color', () => {
        expect(borderColors.special.toast.info).toContain('border-blue');
      });

      const toastTypes = ['success', 'error', 'warning', 'info'] as const;
      toastTypes.forEach((type) => {
        it(`should use opacity for ${type} toast`, () => {
          expect(borderColors.special.toast[type]).toContain('/20');
        });
      });
    });

    describe('indicator', () => {
      it('should have purple indicator', () => {
        expect(borderColors.special.indicator.purple).toContain('border-purple');
      });

      it('should have indigo indicator', () => {
        expect(borderColors.special.indicator.indigo).toContain('border-indigo');
      });
    });
  });
});

describe('Token consistency', () => {
  it('should use consistent Tailwind class format', () => {
    const checkBorderFormat = (obj: Record<string, unknown>, path = ''): void => {
      for (const [key, value] of Object.entries(obj)) {
        const currentPath = path ? `${path}.${key}` : key;
        if (typeof value === 'string') {
          expect(value).toMatch(/border-/);
        } else if (typeof value === 'object' && value !== null) {
          checkBorderFormat(value as Record<string, unknown>, currentPath);
        }
      }
    };

    checkBorderFormat(borderColors);
  });

  it('should use consistent color naming', () => {
    const tailwindColors = [
      'dark',
      'blue',
      'purple',
      'gray',
      'indigo',
      'green',
      'amber',
      'pink',
      'cyan',
      'red',
      'yellow',
    ];

    const extractColors = (str: string): string[] => {
      const matches = str.match(/border-([a-z]+)/g) || [];
      return matches.map((m) => m.replace('border-', ''));
    };

    const checkColors = (obj: Record<string, unknown>): void => {
      for (const value of Object.values(obj)) {
        if (typeof value === 'string') {
          const colors = extractColors(value);
          colors.forEach((color) => {
            expect(tailwindColors).toContain(color);
          });
        } else if (typeof value === 'object' && value !== null) {
          checkColors(value as Record<string, unknown>);
        }
      }
    };

    checkColors(borderColors);
  });
});

describe('Type safety', () => {
  it('should be readonly (const assertion)', () => {
    expect(typeof messageSpacing).toBe('object');
    expect(typeof borderRadius).toBe('object');
    expect(typeof messageColors).toBe('object');
    expect(typeof customColors).toBe('object');
    expect(typeof borderColors).toBe('object');
  });

  it('should export all expected tokens', () => {
    expect(messageSpacing).toBeDefined();
    expect(borderRadius).toBeDefined();
    expect(messageColors).toBeDefined();
    expect(customColors).toBeDefined();
    expect(borderColors).toBeDefined();
  });
});

describe('tokens (unified namespace)', () => {
  it('should be exported as named export', () => {
    expect(tokens).toBeDefined();
    expect(typeof tokens).toBe('object');
  });

  it('should be exported as default export', () => {
    expect(designTokensDefault).toBeDefined();
    expect(designTokensDefault).toBe(tokens);
  });

  describe('tokens.color', () => {
    it('should have accent color', () => {
      expect(tokens.color.accent).toBe('bg-indigo-500');
    });

    it('should have surface tokens', () => {
      expect(tokens.color.surface.app).toBe('bg-dark-950');
      expect(tokens.color.surface.panel).toBe('bg-dark-900');
      expect(tokens.color.surface.card).toBe('bg-dark-800');
    });

    it('should have text tokens', () => {
      expect(tokens.color.text.primary).toBe('text-gray-100');
      expect(tokens.color.text.secondary).toBe('text-gray-400');
      expect(tokens.color.text.muted).toBe('text-gray-500');
    });

    it('should have border tokens derived from borderColors.ui', () => {
      expect(tokens.color.border.default).toBe(borderColors.ui.default);
      expect(tokens.color.border.subtle).toBe(borderColors.ui.secondary);
    });

    it('should have status tokens', () => {
      expect(tokens.color.status.success).toBe('text-green-400');
      expect(tokens.color.status.warning).toBe('text-amber-400');
      expect(tokens.color.status.error).toBe('text-red-400');
      expect(tokens.color.status.info).toBe('text-indigo-400');
    });
  });

  describe('tokens.spacing', () => {
    it('should have chatMaxWidth', () => {
      expect(tokens.spacing.chatMaxWidth).toBe('max-w-4xl');
    });
  });

  describe('tokens.radius', () => {
    it('should consolidate borderRadius entries', () => {
      expect(tokens.radius.message.bubble).toBe(borderRadius.message.bubble);
      expect(tokens.radius.message.tool).toBe(borderRadius.message.tool);
    });

    it('should add panel radius', () => {
      expect(tokens.radius.panel).toBe('rounded-xl');
    });
  });

  describe('tokens.transition', () => {
    it('should have quick transition', () => {
      expect(tokens.transition.quick).toBe('transition-all duration-150 ease-out');
    });

    it('should have smooth transition', () => {
      expect(tokens.transition.smooth).toBe('transition-all duration-250 ease-out');
    });
  });
});
