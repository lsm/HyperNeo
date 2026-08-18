import { ChevronUp } from 'lucide-preact';

export interface NavItem {
  id: string;
  label: string;
}

export interface NavCategory {
  id: string;
  label: string;
  sections: NavItem[];
}

export const headlessNavItems: NavItem[] = [
  { id: 'hc-button', label: 'Button' },
  { id: 'hc-icon-button', label: 'IconButton' },
  { id: 'hc-checkbox', label: 'Checkbox' },
  { id: 'hc-switch', label: 'Switch' },
  { id: 'hc-radio-group', label: 'RadioGroup' },
  { id: 'hc-input', label: 'Input' },
  { id: 'hc-field', label: 'Field' },
  { id: 'hc-dialog', label: 'Dialog' },
  { id: 'hc-command-palette', label: 'Command Palette' },
  { id: 'hc-drawer', label: 'Drawer' },
  { id: 'hc-menu', label: 'Menu' },
  { id: 'hc-disclosure', label: 'Disclosure' },
  { id: 'hc-popover', label: 'Popover' },
  { id: 'hc-tooltip', label: 'Tooltip' },
  { id: 'hc-toast', label: 'Toast' },
  { id: 'hc-notification', label: 'Notification' },
  { id: 'hc-tabs', label: 'Tabs' },
  { id: 'hc-listbox', label: 'Listbox' },
  { id: 'hc-combobox', label: 'Combobox' },
  { id: 'hc-transition', label: 'Transition' },
  { id: 'hc-spinner', label: 'Spinner' },
  { id: 'hc-skeleton', label: 'Skeleton' },
];

export const appUiCategories: NavCategory[] = [
  {
    id: 'application-shells',
    label: 'Application Shells',
    sections: [
      { id: 'ui-appshells-multi-column', label: 'Multi-column' },
      { id: 'ui-appshells-multi-column-shells', label: 'Multi-column (Headless)' },
      { id: 'ui-appshells-sidebar', label: 'Sidebar' },
      { id: 'ui-appshells-stacked', label: 'Stacked' },
    ],
  },
  {
    id: 'data-display',
    label: 'Data Display',
    sections: [
      { id: 'ui-data-display-stats', label: 'Stats' },
      { id: 'ui-data-display-calendars', label: 'Calendars' },
      { id: 'ui-data-display-calendars-hl', label: 'Calendars (Headless)' },
      { id: 'ui-data-display-description-lists', label: 'Description Lists' },
    ],
  },
  {
    id: 'elements',
    label: 'Elements',
    sections: [
      { id: 'ui-elements-avatars', label: 'Avatars' },
      { id: 'ui-elements-badges', label: 'Badges' },
      { id: 'ui-elements-buttons', label: 'Buttons' },
      { id: 'ui-elements-button-groups', label: 'Button Groups' },
      { id: 'ui-elements-dropdowns', label: 'Dropdowns' },
    ],
  },
  {
    id: 'feedback',
    label: 'Feedback',
    sections: [
      { id: 'ui-feedback-alerts', label: 'Alerts' },
      { id: 'ui-feedback-empty-states', label: 'Empty States' },
    ],
  },
  {
    id: 'forms',
    label: 'Forms',
    sections: [
      { id: 'ui-forms-form-layouts', label: 'Form Layouts' },
      { id: 'ui-forms-input-groups', label: 'Input Groups' },
      { id: 'ui-forms-radio-groups', label: 'Radio Groups' },
      { id: 'ui-forms-select-menus', label: 'Select Menus' },
      { id: 'ui-forms-select-menus-hl', label: 'Select Menus (Headless)' },
      { id: 'ui-forms-comboboxes', label: 'Comboboxes' },
      { id: 'ui-forms-action-panels', label: 'Action Panels' },
      { id: 'ui-forms-checkboxes', label: 'Checkboxes' },
      { id: 'ui-forms-sign-in-forms', label: 'Sign-in Forms' },
      { id: 'ui-forms-textareas', label: 'Textareas' },
      { id: 'ui-forms-toggles', label: 'Toggles' },
    ],
  },
  {
    id: 'headings',
    label: 'Headings',
    sections: [
      { id: 'ui-headings-card-headings', label: 'Card Headings' },
      { id: 'ui-headings-page-headings', label: 'Page Headings' },
      { id: 'ui-headings-section-headings', label: 'Section Headings' },
    ],
  },
  {
    id: 'layout',
    label: 'Layout',
    sections: [
      { id: 'ui-layout-cards', label: 'Cards' },
      { id: 'ui-layout-containers', label: 'Containers' },
      { id: 'ui-layout-dividers', label: 'Dividers' },
      { id: 'ui-layout-list-containers', label: 'List Containers' },
      { id: 'ui-layout-media-objects', label: 'Media Objects' },
    ],
  },
  {
    id: 'lists',
    label: 'Lists',
    sections: [
      { id: 'ui-lists-feeds', label: 'Feeds' },
      { id: 'ui-lists-grid-lists', label: 'Grid Lists' },
      { id: 'ui-lists-stacked-lists', label: 'Stacked Lists' },
      { id: 'ui-lists-tables', label: 'Tables' },
    ],
  },
  {
    id: 'navigation',
    label: 'Navigation',
    sections: [
      { id: 'ui-nav-breadcrumbs', label: 'Breadcrumbs' },
      { id: 'ui-nav-command-palettes', label: 'Command Palettes' },
      { id: 'ui-nav-navbars', label: 'Navbars' },
      { id: 'ui-nav-pagination', label: 'Pagination' },
      { id: 'ui-nav-progress-bars', label: 'Progress Bars' },
      { id: 'ui-nav-sidebar-navigation', label: 'Sidebar Navigation' },
      { id: 'ui-nav-vertical-navigation', label: 'Vertical Navigation' },
    ],
  },
  {
    id: 'overlays',
    label: 'Overlays',
    sections: [
      { id: 'ui-overlays-drawers', label: 'Drawers' },
      { id: 'ui-overlays-modal-dialogs', label: 'Modal Dialogs' },
      { id: 'ui-overlays-notifications', label: 'Notifications' },
    ],
  },
  {
    id: 'page-examples',
    label: 'Page Examples',
    sections: [
      { id: 'ui-pages-detail-screens', label: 'Detail Screens' },
      { id: 'ui-pages-home-screens', label: 'Home Screens' },
      { id: 'ui-pages-settings-screens', label: 'Settings Screens' },
    ],
  },
];

interface SidebarProps {
  currentPage: string;
  activeSection: string;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
}

export function Sidebar({ currentPage, activeSection, searchQuery, setSearchQuery }: SidebarProps) {
  const q = searchQuery.toLowerCase();

  const filteredHeadless =
    q === '' ? headlessNavItems : headlessNavItems.filter((s) => s.label.toLowerCase().includes(q));

  const filteredCategories =
    q === ''
      ? appUiCategories
      : appUiCategories.filter(
          (cat) =>
            cat.label.toLowerCase().includes(q) ||
            cat.sections.some((s) => s.label.toLowerCase().includes(q))
        );

  return (
    <nav class="fixed left-0 top-0 w-64 h-screen overflow-y-auto bg-surface-1 border-r border-surface-border z-10 flex flex-col">
      <div class="p-4 flex-1">
        <div class="mb-4">
          <input
            type="search"
            placeholder="Filter..."
            value={searchQuery}
            onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
            class="w-full px-3 py-1.5 text-sm bg-surface-2 border border-surface-border rounded text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-surface-border"
          />
        </div>

        {filteredHeadless.length > 0 && (
          <div class="mb-6">
            <p class="px-3 text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">
              Headless Components
            </p>
            <ul class="space-y-0.5">
              {filteredHeadless.map((s) => {
                const isActive = currentPage === '' && s.id === activeSection;
                return (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      class={`block px-3 py-1.5 text-sm rounded transition-colors ${
                        isActive
                          ? 'text-text-primary bg-surface-2 font-medium'
                          : 'text-text-secondary hover:text-text-primary hover:bg-surface-2'
                      }`}
                    >
                      {s.label}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {filteredCategories.length > 0 && (
          <div>
            <p class="px-3 text-xs font-semibold uppercase tracking-wider text-text-tertiary mb-2">
              Application UI
            </p>
            <ul class="space-y-0.5">
              {filteredCategories.map((category) => {
                const isCategoryActive = currentPage === category.id;
                const filteredSections =
                  q === ''
                    ? category.sections
                    : category.sections.filter((s) => s.label.toLowerCase().includes(q));

                return (
                  <li key={category.id}>
                    <a
                      href={`#/${category.id}`}
                      class={`flex items-center px-3 py-2 text-sm rounded transition-colors ${
                        isCategoryActive
                          ? 'text-text-primary bg-surface-2 font-medium'
                          : 'text-text-secondary hover:text-text-primary hover:bg-surface-2'
                      }`}
                    >
                      {category.label}
                    </a>
                    {isCategoryActive && (
                      <ul class="ml-4 mt-1 space-y-0.5 border-l border-surface-border pl-2">
                        {filteredSections.map((section) => {
                          const isActive = section.id === activeSection;
                          return (
                            <li key={section.id}>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  const el = document.getElementById(section.id);
                                  if (el) {
                                    el.scrollIntoView({
                                      behavior: 'smooth',
                                    });
                                  }
                                }}
                                class={`block w-full text-left px-3 py-1.5 text-xs rounded transition-colors cursor-pointer ${
                                  isActive
                                    ? 'text-text-primary bg-surface-2 font-medium'
                                    : 'text-text-tertiary hover:text-text-primary hover:bg-surface-2'
                                }`}
                              >
                                {section.label}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                    {!isCategoryActive && q !== '' && filteredSections.length > 0 && (
                      <ul class="ml-4 mt-1 space-y-0.5 border-l border-surface-border pl-2">
                        {filteredSections.map((section) => (
                          <li key={section.id}>
                            <a
                              href={`#/${category.id}`}
                              class="block px-3 py-1.5 text-xs rounded transition-colors text-text-tertiary hover:text-text-primary hover:bg-surface-2"
                            >
                              {section.label}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      <div class="p-2 border-t border-surface-border">
        <button
          type="button"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          class="w-full flex items-center justify-center gap-1 px-3 py-2 text-xs text-text-tertiary hover:text-text-primary hover:bg-surface-2 rounded transition-colors cursor-pointer"
        >
          <ChevronUp class="w-3 h-3" />
          Scroll to top
        </button>
      </div>
    </nav>
  );
}
