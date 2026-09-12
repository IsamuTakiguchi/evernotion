'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';
import { Logo } from './Logo';
import {
  IconChevron, IconFile, IconGraph, IconMoon, IconPlus, IconSearch,
  IconSettings, IconSparkles, IconSun, IconTag, IconTrash,
} from '@/components/ui/Icons';

export type PageTreeNode = {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  isFavorite: boolean;
  updatedAt: string;
  children: PageTreeNode[];
};

type Props = {
  onOpenSearch: () => void;
  tree: PageTreeNode[];
  reloadTree: () => void;
};

export function Sidebar({ onOpenSearch, tree, reloadTree }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [dark, setDark] = useState(false);

  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
  }, []);

  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('ev-theme', next ? 'dark' : 'light');
    } catch {
      // Private-browsing or blocked storage: the toggle still works this session.
    }
  };

  const createPage = useCallback(
    async (parentId: string | null) => {
      const { page } = await api.post<{ page: { id: string } }>('/api/pages', { parentId });
      reloadTree();
      if (parentId) setExpanded((e) => ({ ...e, [parentId]: true }));
      router.push(`/p/${page.id}`);
    },
    [reloadTree, router],
  );

  return (
    <aside
      className="flex h-full w-[260px] shrink-0 flex-col border-r text-[14px]"
      style={{ background: 'var(--bg-sidebar)' }}
    >
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <Logo size={22} />
        <span className="font-semibold tracking-tight">Evernotion</span>
        <button
          onClick={toggleTheme}
          className="ml-auto rounded p-1.5 hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--text-muted)' }}
          aria-label={dark ? 'ライトモードに切り替え' : 'ダークモードに切り替え'}
          title={dark ? 'ライトモード' : 'ダークモード'}
        >
          {dark ? <IconSun size={15} /> : <IconMoon size={15} />}
        </button>
      </div>

      <nav className="px-2 pb-2">
        <button
          onClick={onOpenSearch}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--text-muted)' }}
        >
          <IconSearch size={16} />
          <span>検索</span>
          <kbd
            className="ml-auto rounded border px-1.5 py-0.5 text-[11px]"
            style={{ color: 'var(--text-faint)' }}
          >
            ⌘K
          </kbd>
        </button>
        <NavLink href="/chat" active={pathname === '/chat'} icon={<IconSparkles size={16} />} label="AIチャット" />
        <NavLink href="/graph" active={pathname === '/graph'} icon={<IconGraph size={16} />} label="グラフ" />
        <NavLink href="/tags" active={pathname.startsWith('/tags')} icon={<IconTag size={16} />} label="タグ" />
        <NavLink href="/settings" active={pathname === '/settings'} icon={<IconSettings size={16} />} label="設定" />
      </nav>

      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-faint)' }}>
          ノート
        </span>
        <button
          onClick={() => createPage(null)}
          className="rounded p-1 hover:bg-[var(--bg-hover)]"
          style={{ color: 'var(--text-muted)' }}
          title="新しいノート"
          aria-label="新しいノート"
        >
          <IconPlus size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {tree.length === 0 ? (
          <button
            onClick={() => createPage(null)}
            className="w-full rounded px-2 py-2 text-left text-[13px] hover:bg-[var(--bg-hover)]"
            style={{ color: 'var(--text-faint)' }}
          >
            最初のノートを作成…
          </button>
        ) : (
          tree.map((node) => (
            <TreeItem
              key={node.id}
              node={node}
              depth={0}
              expanded={expanded}
              setExpanded={setExpanded}
              onCreateChild={createPage}
              reloadTree={reloadTree}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function NavLink({
  href, active, icon, label,
}: { href: string; active: boolean; icon: React.ReactNode; label: string }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-[var(--bg-hover)]"
      style={{
        color: active ? 'var(--text)' : 'var(--text-muted)',
        background: active ? 'var(--bg-hover)' : undefined,
      }}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}

function TreeItem({
  node, depth, expanded, setExpanded, onCreateChild, reloadTree,
}: {
  node: PageTreeNode;
  depth: number;
  expanded: Record<string, boolean>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onCreateChild: (parentId: string | null) => void;
  reloadTree: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const isOpen = expanded[node.id] ?? false;
  const active = pathname === `/p/${node.id}`;
  const hasChildren = node.children.length > 0;

  const remove = async () => {
    if (!confirm(`「${node.title || '無題'}」を削除しますか？ 子ページも削除されます。`)) return;
    await api.del(`/api/pages/${node.id}`);
    reloadTree();
    if (active) router.push('/');
  };

  return (
    <div>
      <div
        className="group flex items-center gap-1 rounded pr-1 hover:bg-[var(--bg-hover)]"
        style={{
          paddingLeft: depth * 12,
          background: active ? 'var(--bg-active)' : undefined,
        }}
      >
        <button
          onClick={() => setExpanded((e) => ({ ...e, [node.id]: !isOpen }))}
          className="rounded p-0.5 hover:bg-[var(--bg-active)]"
          style={{ color: 'var(--text-faint)', visibility: hasChildren ? 'visible' : 'hidden' }}
          aria-label={isOpen ? '折りたたむ' : '展開する'}
        >
          <IconChevron size={13} className={isOpen ? 'rotate-90 transition-transform' : 'transition-transform'} />
        </button>

        <Link href={`/p/${node.id}`} className="flex min-w-0 flex-1 items-center gap-1.5 py-1">
          {node.icon ? (
            <span className="text-[14px] leading-none">{node.icon}</span>
          ) : (
            <IconFile size={14} className="shrink-0" />
          )}
          <span className="truncate">{node.title || '無題'}</span>
        </Link>

        <button
          onClick={() => onCreateChild(node.id)}
          className="rounded p-1 opacity-0 group-hover:opacity-100 hover:bg-[var(--bg-active)]"
          style={{ color: 'var(--text-muted)' }}
          title="子ページを追加"
          aria-label="子ページを追加"
        >
          <IconPlus size={13} />
        </button>
        <button
          onClick={remove}
          className="rounded p-1 opacity-0 group-hover:opacity-100 hover:bg-[var(--bg-active)]"
          style={{ color: 'var(--text-muted)' }}
          title="削除"
          aria-label="削除"
        >
          <IconTrash size={13} />
        </button>
      </div>

      {isOpen &&
        node.children.map((child) => (
          <TreeItem
            key={child.id}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            setExpanded={setExpanded}
            onCreateChild={onCreateChild}
            reloadTree={reloadTree}
          />
        ))}
    </div>
  );
}
