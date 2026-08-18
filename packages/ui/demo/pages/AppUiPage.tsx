import { useEffect } from 'preact/hooks';
import { memo } from 'preact/compat';
import type { ComponentType } from 'preact';

import { MultiColumnDemo } from '../sections/MultiColumnDemo.tsx';
import { MultiColumnShellsDemo } from '../sections/application-shells/multi-column/MultiColumnShellsDemo.tsx';
import { SidebarShellsDemo } from '../sections/application-shells/sidebar/SidebarShellsDemo.tsx';
import { StackedShellsDemo } from '../sections/application-shells/stacked/StackedShellsDemo.tsx';

import { StatsDemo } from '../sections/StatsDemo.tsx';
import { CalendarsDemo } from '../sections/CalendarsDemo.tsx';
import { CalendarsHeadlessDemo } from '../sections/data-display/calendars/CalendarsHeadlessDemo.tsx';
import { DescriptionListsDemo } from '../sections/DescriptionListsDemo.tsx';

import { AvatarsDemo } from '../sections/elements/avatars/AvatarsDemo.tsx';
import { BadgesDemo } from '../sections/elements/badges/BadgesDemo.tsx';
import { ButtonsDemo } from '../sections/elements/buttons/ButtonsDemo.tsx';
import { ButtonGroupsDemo } from '../sections/elements/button-groups/ButtonGroupsDemo.tsx';
import { DropdownsDemo } from '../sections/elements/dropdowns/DropdownsDemo.tsx';

import { AlertsDemo } from '../sections/feedback/alerts/AlertsDemo.tsx';
import { EmptyStatesDemo } from '../sections/EmptyStatesDemo.tsx';

import { FormLayoutsDemo } from '../sections/forms/form-layouts/FormLayoutsDemo.tsx';
import { InputGroupsDemo } from '../sections/forms/input-groups/InputGroupsDemo.tsx';
import { RadioGroupsDemo } from '../sections/forms/radio-groups/RadioGroupsDemo.tsx';
import { SelectMenusDemo } from '../sections/forms/select-menus/SelectMenusDemo.tsx';
import { CustomSelectMenusDemo } from '../sections/forms/select-menus/CustomSelectMenusDemo.tsx';
import { ComboboxesDemo } from '../sections/forms/comboboxes/ComboboxesDemo.tsx';
import { ActionPanelsDemo } from '../sections/ActionPanelsDemo.tsx';
import { CheckboxesDemo } from '../sections/CheckboxesDemo.tsx';
import { SignInFormsDemo } from '../sections/SignInFormsDemo.tsx';
import { TextareasDemo } from '../sections/TextareasDemo.tsx';
import { TogglesDemo } from '../sections/TogglesDemo.tsx';

import { CardHeadingsDemo } from '../sections/headings/card-headings/CardHeadingsDemo.tsx';
import { PageHeadingsDemo } from '../sections/headings/page-headings/PageHeadingsDemo.tsx';
import { SectionHeadingsDemo } from '../sections/headings/section-headings/SectionHeadingsDemo.tsx';

import { CardsDemo } from '../sections/layout/cards/CardsDemo.tsx';
import { ContainersDemo } from '../sections/layout/containers/ContainersDemo.tsx';
import { DividersDemo } from '../sections/layout/dividers/DividersDemo.tsx';
import { ListContainersDemo } from '../sections/layout/list-containers/ListContainersDemo.tsx';
import { MediaObjectsDemo } from '../sections/layout/media-objects/MediaObjectsDemo.tsx';

import { FeedsDemo } from '../sections/FeedsDemo.tsx';
import { GridListsDemo } from '../sections/GridListsDemo.tsx';
import { StackedListsDemo } from '../sections/StackedListsDemo.tsx';
import { TablesDemo } from '../sections/TablesDemo.tsx';

import { BreadcrumbsDemo } from '../sections/BreadcrumbsDemo.tsx';
import { CommandPalettesDemo } from '../sections/navigation/CommandPalettesDemo.tsx';
import { NavbarsDemo } from '../sections/navigation/NavbarsDemo.tsx';
import { PaginationDemo } from '../sections/PaginationDemo.tsx';
import { ProgressBarsDemo } from '../sections/ProgressBarsDemo.tsx';
import { SidebarNavigationDemo } from '../sections/SidebarNavigationDemo.tsx';
import { VerticalNavigationDemo } from '../sections/VerticalNavigationDemo.tsx';

import { DrawersDemo } from '../sections/overlays/DrawersDemo.tsx';
import { ModalDialogsDemo } from '../sections/overlays/ModalDialogsDemo.tsx';
import { NotificationDemo } from '../sections/NotificationDemo.tsx';

import { DetailScreensDemo } from '../sections/DetailScreensDemo.tsx';
import { HomeScreensDemo } from '../sections/HomeScreensDemo.tsx';
import { SettingsScreensDemo } from '../sections/SettingsScreensDemo.tsx';

interface SectionDef {
  id: string;
  title: string;
  Component: ComponentType;
}

const categoryMap: Record<string, SectionDef[]> = {
  'application-shells': [
    { id: 'ui-appshells-multi-column', title: 'Multi-column', Component: MultiColumnDemo },
    {
      id: 'ui-appshells-multi-column-shells',
      title: 'Multi-column (Headless)',
      Component: MultiColumnShellsDemo,
    },
    { id: 'ui-appshells-sidebar', title: 'Sidebar (Headless)', Component: SidebarShellsDemo },
    { id: 'ui-appshells-stacked', title: 'Stacked (Headless)', Component: StackedShellsDemo },
  ],
  'data-display': [
    { id: 'ui-data-display-stats', title: 'Stats', Component: StatsDemo },
    { id: 'ui-data-display-calendars', title: 'Calendars', Component: CalendarsDemo },
    {
      id: 'ui-data-display-calendars-hl',
      title: 'Calendars (Headless)',
      Component: CalendarsHeadlessDemo,
    },
    {
      id: 'ui-data-display-description-lists',
      title: 'Description Lists',
      Component: DescriptionListsDemo,
    },
  ],
  elements: [
    { id: 'ui-elements-avatars', title: 'Avatars', Component: AvatarsDemo },
    { id: 'ui-elements-badges', title: 'Badges', Component: BadgesDemo },
    { id: 'ui-elements-buttons', title: 'Buttons', Component: ButtonsDemo },
    { id: 'ui-elements-button-groups', title: 'Button Groups', Component: ButtonGroupsDemo },
    { id: 'ui-elements-dropdowns', title: 'Dropdowns', Component: DropdownsDemo },
  ],
  feedback: [
    { id: 'ui-feedback-alerts', title: 'Alerts', Component: AlertsDemo },
    { id: 'ui-feedback-empty-states', title: 'Empty States', Component: EmptyStatesDemo },
  ],
  forms: [
    { id: 'ui-forms-form-layouts', title: 'Form Layouts', Component: FormLayoutsDemo },
    { id: 'ui-forms-input-groups', title: 'Input Groups', Component: InputGroupsDemo },
    { id: 'ui-forms-radio-groups', title: 'Radio Groups', Component: RadioGroupsDemo },
    { id: 'ui-forms-select-menus', title: 'Select Menus', Component: SelectMenusDemo },
    {
      id: 'ui-forms-select-menus-hl',
      title: 'Select Menus (Headless)',
      Component: CustomSelectMenusDemo,
    },
    { id: 'ui-forms-comboboxes', title: 'Comboboxes', Component: ComboboxesDemo },
    { id: 'ui-forms-action-panels', title: 'Action Panels', Component: ActionPanelsDemo },
    { id: 'ui-forms-checkboxes', title: 'Checkboxes', Component: CheckboxesDemo },
    { id: 'ui-forms-sign-in-forms', title: 'Sign-in Forms', Component: SignInFormsDemo },
    { id: 'ui-forms-textareas', title: 'Textareas', Component: TextareasDemo },
    { id: 'ui-forms-toggles', title: 'Toggles', Component: TogglesDemo },
  ],
  headings: [
    { id: 'ui-headings-card-headings', title: 'Card Headings', Component: CardHeadingsDemo },
    { id: 'ui-headings-page-headings', title: 'Page Headings', Component: PageHeadingsDemo },
    {
      id: 'ui-headings-section-headings',
      title: 'Section Headings',
      Component: SectionHeadingsDemo,
    },
  ],
  layout: [
    { id: 'ui-layout-cards', title: 'Cards', Component: CardsDemo },
    { id: 'ui-layout-containers', title: 'Containers', Component: ContainersDemo },
    { id: 'ui-layout-dividers', title: 'Dividers', Component: DividersDemo },
    { id: 'ui-layout-list-containers', title: 'List Containers', Component: ListContainersDemo },
    { id: 'ui-layout-media-objects', title: 'Media Objects', Component: MediaObjectsDemo },
  ],
  lists: [
    { id: 'ui-lists-feeds', title: 'Feeds', Component: FeedsDemo },
    { id: 'ui-lists-grid-lists', title: 'Grid Lists', Component: GridListsDemo },
    { id: 'ui-lists-stacked-lists', title: 'Stacked Lists', Component: StackedListsDemo },
    { id: 'ui-lists-tables', title: 'Tables', Component: TablesDemo },
  ],
  navigation: [
    { id: 'ui-nav-breadcrumbs', title: 'Breadcrumbs', Component: BreadcrumbsDemo },
    { id: 'ui-nav-command-palettes', title: 'Command Palettes', Component: CommandPalettesDemo },
    { id: 'ui-nav-navbars', title: 'Navbars', Component: NavbarsDemo },
    { id: 'ui-nav-pagination', title: 'Pagination', Component: PaginationDemo },
    { id: 'ui-nav-progress-bars', title: 'Progress Bars', Component: ProgressBarsDemo },
    {
      id: 'ui-nav-sidebar-navigation',
      title: 'Sidebar Navigation',
      Component: SidebarNavigationDemo,
    },
    {
      id: 'ui-nav-vertical-navigation',
      title: 'Vertical Navigation',
      Component: VerticalNavigationDemo,
    },
  ],
  overlays: [
    { id: 'ui-overlays-drawers', title: 'Drawers', Component: DrawersDemo },
    { id: 'ui-overlays-modal-dialogs', title: 'Modal Dialogs', Component: ModalDialogsDemo },
    { id: 'ui-overlays-notifications', title: 'Notifications', Component: NotificationDemo },
  ],
  'page-examples': [
    { id: 'ui-pages-detail-screens', title: 'Detail Screens', Component: DetailScreensDemo },
    { id: 'ui-pages-home-screens', title: 'Home Screens', Component: HomeScreensDemo },
    {
      id: 'ui-pages-settings-screens',
      title: 'Settings Screens',
      Component: SettingsScreensDemo,
    },
  ],
};

interface AppUiPageProps {
  categoryId: string;
  setActiveSection: (id: string) => void;
}

function AppUiPageInner({ categoryId, setActiveSection }: AppUiPageProps) {
  const sections = categoryMap[categoryId];

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [categoryId]);

  useEffect(() => {
    if (!sections) return;

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
  }, [categoryId, sections]);

  if (!sections) {
    return (
      <main class="px-8 py-12">
        <p class="text-text-tertiary">Page not found: {categoryId}</p>
      </main>
    );
  }

  return (
    <main class="px-8 max-w-6xl">
      {sections.map(({ id, title, Component }) => (
        <section key={id} id={id} class="py-12 border-b border-surface-border">
          <h2 class="text-2xl font-bold mb-6">{title}</h2>
          <Component />
        </section>
      ))}
    </main>
  );
}

export const AppUiPage = memo(AppUiPageInner);
