#!/usr/bin/env node
/**
 * Pre-fetch the OCR and embedding models.
 *
 * Optional: the server downloads these by itself on first start, and fetches
 * them on demand if that fails. Run this to front-load the wait, or to prepare
 * a machine that will be offline.
 */
import { ensureModels, resolveDataDir } from '../lib/setup/models.mjs';

console.log(`data directory: ${resolveDataDir()}`);

try {
  await ensureModels({ onProgress: (message) => console.log(`  ${message}`) });
  console.log('\nすべてのモデルの準備が完了しました。オフラインでも動作します。');
} catch (err) {
  console.error(`\nモデルの取得に失敗しました: ${err.message}`);
  console.error('アプリ自体は動作します（ノート・検索・テキスト層のあるPDF）。');
  console.error('OCRと意味検索は、次に使うときに再度ダウンロードを試みます。');
  process.exit(1);
}
