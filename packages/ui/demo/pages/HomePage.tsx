import { useEffect } from 'preact/hooks';
import { memo } from 'preact/compat';
import type { ComponentType } from 'preact';

import { ButtonDemo } from '../sections/ButtonDemo.tsx';
import { IconButtonDemo } from '../sections/IconButtonDemo.tsx';
import { CheckboxDemo } from '../sections/CheckboxDemo.tsx';
import { SwitchDemo } from '../sections/SwitchDemo.tsx';
import { RadioGroupDemo } from '../sections/RadioGroupDemo.tsx';
import { InputDemo } from '../sections/InputDemo.tsx';
import { FieldDemo } from '../sections/FieldDemo.tsx';
import { DialogDemo } from '../sections/DialogDemo.tsx';
import { CommandPaletteDemo } from '../sections/CommandPaletteDemo.tsx';
import { DrawerDemo } from '../sections/DrawerDemo.tsx';
import { MenuDemo } from '../sections/MenuDemo.tsx';
import { DisclosureDemo } from '../sections/DisclosureDemo.tsx';
import { PopoverDemo } from '../sections/PopoverDemo.tsx';
import { TooltipDemo } from '../sections/TooltipDemo.tsx';
import { ToastDemo } from '../sections/ToastDemo.tsx';
import { NotificationDemo } from '../sections/NotificationDemo.tsx';
import { TabsDemo } from '../sections/TabsDemo.tsx';
import { ListboxDemo } from '../sections/ListboxDemo.tsx';
import { ComboboxDemo } from '../sections/ComboboxDemo.tsx';
import { TransitionDemo } from '../sections/TransitionDemo.tsx';
import { SpinnerDemo } from '../sections/SpinnerDemo.tsx';
import { SkeletonDemo } from '../sections/SkeletonDemo.tsx';

interface SectionDef {
  id: string;
  title: string;
  Component: ComponentType;
}

const headlessSections: SectionDef[] = [
  { id: 'hc-button', title: 'Button', Component: ButtonDemo },
  { id: 'hc-icon-button', title: 'IconButton', Component: IconButtonDemo },
  { id: 'hc-checkbox', title: 'Checkbox', Component: CheckboxDemo },
  { id: 'hc-switch', title: 'Switch', Component: SwitchDemo },
  { id: 'hc-radio-group', title: 'RadioGroup', Component: RadioGroupDemo },
  { id: 'hc-input', title: 'Input', Component: InputDemo },
  { id: 'hc-field', title: 'Field', Component: FieldDemo },
  { id: 'hc-dialog', title: 'Dialog', Component: DialogDemo },
  {
    id: 'hc-command-palette',
    title: 'Command Palette (Dialog + Combobox)',
    Component: CommandPaletteDemo,
  },
  { id: 'hc-drawer', title: 'Drawer', Component: DrawerDemo },
  { id: 'hc-menu', title: 'Menu', Component: MenuDemo },
  { id: 'hc-disclosure', title: 'Disclosure', Component: DisclosureDemo },
  { id: 'hc-popover', title: 'Popover', Component: PopoverDemo },
  { id: 'hc-tooltip', title: 'Tooltip', Component: TooltipDemo },
  { id: 'hc-toast', title: 'Toast', Component: ToastDemo },
  { id: 'hc-notification', title: 'Notification (Toast Variants)', Component: NotificationDemo },
  { id: 'hc-tabs', title: 'Tabs', Component: TabsDemo },
  { id: 'hc-listbox', title: 'Listbox', Component: ListboxDemo },
  { id: 'hc-combobox', title: 'Combobox', Component: ComboboxDemo },
  { id: 'hc-transition', title: 'Transition', Component: TransitionDemo },
  { id: 'hc-spinner', title: 'Spinner', Component: SpinnerDemo },
  { id: 'hc-skeleton', title: 'Skeleton', Component: SkeletonDemo },
];

interface HomePageProps {
  setActiveSection: (id: string) => void;
}

function HomePageInner({ setActiveSection }: HomePageProps) {
  useEffect(() => {
    const hash = window.location.hash;
    if (hash && !hash.startsWith('#/')) {
      const el = document.getElementById(hash.slice(1));
      if (el) {
        el.scrollIntoView({ behavior: 'smooth' });
      }
    } else {
      window.scrollTo(0, 0);
    }
  }, []);

  useEffect(() => {
    const visibleSections = new Map<string, number>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visibleSections.set(entry.target.id, entry.intersectionRatio);
          } else {
            visibleSections.delete(entry.target.id);
          }
        }

        let bestId = '';
        let bestRatio = 0;
        for (const [id, ratio] of visibleSections) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestId = id;
          }
        }
        setActiveSection(bestId);
      },
      { rootMargin: '-20% 0px -70% 0px', threshold: [0, 0.1, 0.5, 1.0] }
    );

    const sectionEls = document.querySelectorAll('section[id]');
    for (const el of sectionEls) observer.observe(el);

    return () => observer.disconnect();
  }, []);

  return (
    <main class="px-8 max-w-6xl">
      {headlessSections.map(({ id, title, Component }) => (
        <section key={id} id={id} class="py-12 border-b border-surface-border">
          <h2 class="text-2xl font-bold mb-6">{title}</h2>
          <Component />
        </section>
      ))}
    </main>
  );
}

export const HomePage = memo(HomePageInner);
