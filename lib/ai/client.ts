import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { getSetting } from '../db/queries';

/**
 * Claude models used by the app.
 *
 * Chat defaults to Sonnet; the short structured calls (tagging, summaries) go
 * to Haiku, where latency matters more than depth.
 */
export const MODELS = {
  chat: 'claude-sonnet-5',
  deep: 'claude-opus-5',
  fast: 'claude-haiku-4-5-20251001',
} as const;

export type ModelKey = keyof typeof MODELS;

/**
 * The key may come from the environment or from the in-app Settings screen.
 * The environment wins, so a deliberately configured deployment is not
 * silently overridden by a stale stored value.
 */
export function getApiKey(): string | null {
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const stored = getSetting('anthropic_api_key');
  return stored?.trim() || null;
}

export function isAiEnabled(): boolean {
  return getApiKey() !== null;
}

export class NoApiKeyError extends Error {
  readonly code = 'NO_API_KEY';
  constructor() {
    super('Claude APIキーが設定されていません');
  }
}

export function getClient(): Anthropic {
  const apiKey = getApiKey();
  if (!apiKey) throw new NoApiKeyError();
  return new Anthropic({ apiKey });
}

/** Standard 503 body, so every AI route reports a missing key the same way. */
export function noKeyResponse(): Response {
  return Response.json(
    {
      error: 'Claude APIキーが設定されていません',
      code: 'NO_API_KEY',
      hint: '設定画面からAPIキーを登録すると、AIチャットと自動タグが使えるようになります。検索・PDF・グラフはキーなしでも動作します。',
    },
    { status: 503 },
  );
}
