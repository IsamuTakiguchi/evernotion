'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { api } from '@/lib/client/api';
import { Sidebar, type PageTreeNode } from './Sidebar';
import { SearchDialog } from '@/components/search/SearchDialog';

/**
 * Holds the page tree and the command palette, so every route shares one copy
 * and a save in the editor can refresh the sidebar title without a reload.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [tree, setTree] = useState<PageTreeNode[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
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
      <Sidebar onOpenSearch={() => setSearchOpen(true)} tree={tree} reloadTree={reloadTree} />
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} />}
    </div>
  );
}
