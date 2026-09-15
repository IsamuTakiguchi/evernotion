import { NextResponse } from 'next/server';
import { createMcpHandler } from '@modelcontextprotocol/server';

import { baseUrl } from '@/lib/auth/google';
import { isHostedDeployment } from '@/lib/setup/preflight';
import { bearerToken, ownerForToken } from '@/lib/mcp/tokens';
import { buildMcpServer } from '@/lib/mcp/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * The MCP endpoint — how Claude reaches these notes.
 *
 * Authentication is a bearer token rather than the session cookie, because the
 * caller is Claude Code or a bridge, not a browser. proxy.ts therefore does not
 * gate this route; it authenticates itself, below, and that check is the only
 * thing standing in front of the notes.
 *
 * The protocol itself is the library's job. Header/body agreement, the
 * `-32020` mismatch error, version negotiation, 405 on GET and DELETE, and
 * serving clients that still speak the 2025 handshake are all handled by
 * createMcpHandler. Hand-rolling that would work until a client updated.
 */
const handler = createMcpHandler(({ authInfo }) => {
  const ownerId = authInfo?.clientId;
  if (!ownerId) {
    // Unreachable: POST below refuses before calling in. Thrown rather than
    // defaulted, so a future refactor cannot quietly serve an empty owner.
    throw new Error('MCP handler reached without an authenticated owner');
  }
  return buildMcpServer(ownerId, publicOrigin());
});

/**
 * The app's own public URL, or nothing.
 *
 * `hosted` is passed as true whatever this deployment is, which makes baseUrl
 * use only its configured sources and throw rather than fall back to the
 * origin of the request. There is no real request here to take an origin from,
 * and a link to `http://localhost` handed to Claude is worse than no link.
 */
function publicOrigin(): string | undefined {
  try {
    return baseUrl(new Request('http://unused.invalid/'), true);
  } catch {
    return undefined;
  }
}

/**
 * Reject a browser-originated call.
 *
 * Required by the transport spec to stop a web page in someone's browser from
 * driving a local MCP server through DNS rebinding. Claude Code sends no
 * Origin at all; a browser always does, and none of them should be here.
 */
function badOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  const allowed = publicOrigin();
  return !allowed || origin !== allowed;
}

export async function POST(req: Request) {
  if (badOrigin(req)) {
    return NextResponse.json({ error: 'origin not allowed' }, { status: 403 });
  }

  const ownerId = ownerForToken(bearerToken(req));
  if (!ownerId) {
    return NextResponse.json(
      { error: 'アクセストークンが必要です', code: 'UNAUTHORIZED' },
      {
        status: 401,
        // Names the scheme, so a client knows what kind of credential to send.
        headers: { 'WWW-Authenticate': 'Bearer realm="Evernotian"' },
      },
    );
  }

  return handler.fetch(req, {
    authInfo: { token: '', clientId: ownerId, scopes: [] },
  });
}

/**
 * This revision of the transport is POST-only; GET and DELETE were the 2025
 * session operations. Answering 405 is what tells an older client to stop
 * asking rather than to keep retrying.
 */
export function GET() {
  return new NextResponse('Method not allowed.', { status: 405, headers: { Allow: 'POST' } });
}

export const DELETE = GET;
