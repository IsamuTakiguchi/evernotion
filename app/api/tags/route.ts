import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const tags = getDb()
    .prepare(
      `SELECT t.name, COUNT(pt.page_id) AS count
         FROM tags t
         LEFT JOIN page_tags pt ON pt.tag_id = t.id
         LEFT JOIN pages p ON p.id = pt.page_id AND p.archived_at IS NULL
        GROUP BY t.id HAVING count > 0
        ORDER BY count DESC, t.name`,
    )
    .all() as { name: string; count: number }[];
  return NextResponse.json({ tags });
}
