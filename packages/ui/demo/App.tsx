import { useState, useEffect } from 'preact/hooks';
import { Sun, Moon } from 'lucide-preact';
import { Sidebar } from './Sidebar.tsx';
import { HomePage } from './pages/HomePage.tsx';
import { AppUiPage } from './pages/AppUiPage.tsx';

function getCurrentPage(): string {
  const hash = window.location.hash;
  return hash.startsWith('#/') ? hash.slice(2) : '';
}

export function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [page, setPage] = useState<string>(getCurrentPage);
  const [activeSection, setActiveSection] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState<string>('');

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    if (next === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }

  useEffect(() => {
    function onHashChange() {
      const hash = window.location.hash;
      if (hash.startsWith('#/')) {
        setPage(hash.slice(2));
        setActiveSection('');
      } else if (hash.startsWith('#hc-')) {
        setPage('');
        setActiveSection('');
      }
    }

    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return (
    <div class="min-h-screen bg-surface-0 text-text-primary">
      <Sidebar
        currentPage={page}
        activeSection={activeSection}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
      />

      <div class="ml-64">
        <header class="px-8 pt-10 pb-4 border-b border-surface-border flex items-start justify-between">
          <div>
            <h1 class="text-3xl font-bold text-text-primary">
              @hyperneo/ui — Component Library & Application UI Reference
            </h1>
            <p class="mt-2 text-text-tertiary">
              364+ Tailwind Application UI examples · headless primitives · design tokens
            </p>
          </div>
          <div class="flex items-center gap-2 mt-2">
            <a
              href="https://github.com/lsm/neokai"
              target="_blank"
              rel="noopener noreferrer"
              class="py-2 px-3 rounded-lg border border-surface-border text-text-tertiary hover:text-text-primary hover:bg-surface-2 transition-colors text-sm"
            >
              GitHub
            </a>
            <button
              type="button"
              onClick={toggleTheme}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              class="p-2 rounded-lg border border-surface-border text-text-tertiary hover:text-text-primary hover:bg-surface-2 transition-colors cursor-pointer"
            >
              {theme === 'dark' ? <Sun class="w-5 h-5" /> : <Moon class="w-5 h-5" />}
            </button>
          </div>
        </header>

        {page === '' ? (
          <HomePage setActiveSection={setActiveSection} />
        ) : (
          <AppUiPage categoryId={page} setActiveSection={setActiveSection} />
        )}
      </div>
    </div>
  );
}
