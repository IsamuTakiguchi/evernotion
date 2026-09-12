'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { Sidebar, type PageTreeNode } from './Sidebar';
import { SearchDialog } from '@/components/search/SearchDialog';

/**
 * Holds the page tree and the command palette, so every route shares one copy
 * and a save in the editor can refresh the sidebar title without a reload.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const [tree, setTree] = useState<PageTreeNode[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);

  const reloadTree = useCallback(() => {
    api
      .get<{ tree: PageTreeNode[] }>('/api/pages')
      .then((r) => setTree(r.tree))
      .catch(() => {
        /* the sidebar simply stays as it is */
      });
  }, []);

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

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar onOpenSearch={() => setSearchOpen(true)} tree={tree} reloadTree={reloadTree} />
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      {searchOpen && <SearchDialog onClose={() => setSearchOpen(false)} />}
    </div>
  );
}
