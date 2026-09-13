import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';
import { requireSession } from '@/lib/auth/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type GraphNode = {
  id: string;
  title: string;
  icon: string | null;
  degree: number;
  tag: string | null;
  /** A link target no page exists for yet — drawn as a ghost node. */
  ghost: boolean;
};

export type GraphLink = { source: string; target: string; unresolved: boolean };

export async function GET(req: Request) {
  const session = await requireSession(req);
  if (session instanceof Response) return session;

  const db = getDb();

  const pages = db
    .prepare(
      `SELECT p.id, p.title, p.icon,
              (SELECT t.name FROM page_tags pt JOIN tags t ON t.id = pt.tag_id
                WHERE pt.page_id = p.id ORDER BY t.name LIMIT 1) AS tag
         FROM pages p WHERE p.owner_id = ? AND p.archived_at IS NULL`,
    )
    .all(session.userId) as
    { id: string; title: string; icon: string | null; tag: string | null }[];

  const edges = db
    .prepare(
      `SELECT l.source_page_id, l.target_page_id, l.target_title
         FROM links l JOIN pages p ON p.id = l.source_page_id
        WHERE p.owner_id = ? AND p.archived_at IS NULL`,
    )
    .all(session.userId) as
    { source_page_id: string; target_page_id: string | null; target_title: string }[];

  const nodes = new Map<string, GraphNode>();
  for (const p of pages) {
    nodes.set(p.id, { id: p.id, title: p.title || '無題', icon: p.icon, degree: 0, tag: p.tag, ghost: false });
  }

  const links: GraphLink[] = [];
  for (const e of edges) {
    // An unresolved link still belongs on the graph: Obsidian shows these, and
    // they are how you notice a note you meant to write.
    const targetId = e.target_page_id ?? `ghost:${e.target_title}`;
    if (!nodes.has(targetId)) {
      nodes.set(targetId, {
        id: targetId, title: e.target_title, icon: null, degree: 0, tag: null, ghost: true,
      });
    }
    if (!nodes.has(e.source_page_id)) continue;
    links.push({ source: e.source_page_id, target: targetId, unresolved: !e.target_page_id });
    nodes.get(targetId)!.degree++;
    nodes.get(e.source_page_id)!.degree++;
  }

  return NextResponse.json({ nodes: [...nodes.values()], links });
}
