'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { api } from '@/lib/client/api';
import { Sidebar, type PageTreeNode } from './Sidebar';
import { SearchDialog } from '@/components/search/SearchDialog';
import { IconMenu, IconSearch } from '@/components/ui/Icons';
import { Logo } from './Logo';

/**
 * Holds the page tree and the command palette, so every route shares one copy
 * and a save in the editor can refresh the sidebar title without a reload.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [tree, setTree] = useState<PageTreeNode[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  // Below lg the sidebar is a drawer rather than a permanent column: a 260px
  // column leaves almost nothing for the note on a phone.
  const [navOpen, setNavOpen] = useState(false);
  // The login screen stands alone: there is no session yet, so every request
  // the sidebar would make is going to come back 401.
  const bare = pathname === '/login';

  const reloadTree = useCallback(() => {
    if (bare) return;
    api
      .get<{ tree: PageTreeNode[] }>('/api/pages')
      .then((r) => setTree(r.tree))
      .catch(() => {
        /* the sidebar simply stays as it is */
      });
  }, [bare]);

  useEffect(() => {
    reloadTree();
  }, [reloadTree]);

  // Navigating inside the drawer should close it, or the note stays hidden
  // behind the menu that was used to reach it.
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  // The editor dispatches this after a save so titles stay in sync.
  useEffect(() => {
    const handler = () => reloadTree();
    window.addEventListener('ev:pages-changed', handler);
    return () => window.removeEventListener('ev:pages-changed', handler);
  }, [reloadTree]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // isComposing guard: ⌘K while an IME candidate window is open belongs
      // to the IME, not to us.
      if (e.isComposing) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
      if (e.key === 'Escape') setSearchOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (bare) return <>{children}</>;

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Permanent column from lg up. */}
      <div className="hidden lg:flex">
        <Sidebar onOpenSearch={() => setSearchOpen(true)} tree={tree} reloadTree={reloadTree} />
      </div>

      {/* Drawer below lg. */}
      {navOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setNavOpen(false)}
            aria-hidden="true"
          />
          <div className="absolute left-0 top-0 h-full shadow-xl">
            <Sidebar
              onOpenSearch={() => {
                setNavOpen(false);
                setSearchOpen(true);
              }}
              tree={tree}
              reloadTree={reloadTree}
              onClose={() => setNavOpen(false)}
            />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar: the only way to reach navigation and search there. */}
        <header
          className="flex items-center gap-2 border-b px-3 py-2 lg:hidden"
          style={{ background: 'var(--bg-sidebar)' }}
        >
          <button
            onClick={() => setNavOpen(true)}
            className="rounded p-1.5 hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-muted)' }}
            aria-label="メニューを開く"
          >
            <IconMenu size={19} />
          </button>
          <Logo size={19} />
          <span className="text-[14px] font-semibold tracking-tight">Evernotion</span>
          <button
            onClick={() => setSearchOpen(true)}
            className="ml-auto rounded p-1.5 hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-muted)' }}
            aria-label="検索"
          >
            <IconSearch size={18} />
          </button>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      </div>

      {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} />}
    </div>
  );
}
