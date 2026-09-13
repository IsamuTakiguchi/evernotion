import { getDb } from '../db/client';
import { createPage, updatePage } from '../db/queries';
import type { JSONContent } from '../editor/doc';

/**
 * Content created the first time the app starts on an empty database.
 *
 * A note app that opens to nothing gives the user no way to discover that
 * `/`, `[[` and `#` do anything, so the welcome note demonstrates each of them
 * using real blocks rather than describing them in prose. The linked child
 * notes also give the graph and backlink panels something to show immediately.
 */

const p = (text: string): JSONContent => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : undefined,
});

const h = (level: 1 | 2 | 3, text: string): JSONContent => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});

const bullets = (items: string[]): JSONContent => ({
  type: 'bulletList',
  content: items.map((text) => ({
    type: 'listItem',
    content: [p(text)],
  })),
});

/** `code` + plain-text runs. Syntax examples must be code-marked, or the
    extractor would treat them as real links and tags on first run. */
const codeBullets = (items: [code: string, rest: string][]): JSONContent => ({
  type: 'bulletList',
  content: items.map(([code, rest]) => ({
    type: 'listItem',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', marks: [{ type: 'code' }], text: code },
          { type: 'text', text: ` ${rest}` },
        ],
      },
    ],
  })),
});

const todo = (items: [string, boolean][]): JSONContent => ({
  type: 'taskList',
  content: items.map(([text, checked]) => ({
    type: 'taskItem',
    attrs: { checked },
    content: [p(text)],
  })),
});

const link = (title: string, pageId: string | null): JSONContent => ({
  type: 'wikiLink',
  attrs: { title, pageId },
});

function welcomeDoc(usageId: string, japaneseId: string): JSONContent {
  return {
    type: 'doc',
    content: [
      p('Evernotian へようこそ。ノート・PDF全文検索・第2の脳をひとつにしたローカルアプリです。'),
      p('このノートは自動で作成されました。読み終えたら自由に書き換えたり、削除したりして構いません。'),

      h(2, 'まず試してみる'),
      todo([
        ['空の行で「/」を押してブロックメニューを開く', false],
        ['「[[」と入力して別のノートにリンクする', false],
        ['PDFをこのページにドラッグ&ドロップする（中の文字まで検索できます）', false],
        ['⌘K（Windowsは Ctrl+K）で検索する', false],
      ]),

      h(2, '書き方'),
      codeBullets([
        ['/', '… 見出し、リスト、ToDo、トグル、引用、コード、テーブル、PDF添付'],
        ['[[ノート名]]', '… 相互リンク。存在しない名前ならその場で新規作成できます'],
        ['#タグ', '… 本文に書くだけで「タグ」画面に集まります'],
      ]),
      bullets(['ブロック左のハンドルをドラッグすると並べ替えられます']),

      h(2, '続きはこちら'),
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: '使い方の詳細は ' },
          link('使い方のヒント', usageId),
          { type: 'text', text: ' に、日本語検索の仕組みは ' },
          link('日本語検索について', japaneseId),
          { type: 'text', text: ' にまとめてあります。' },
        ],
      },
      p('#はじめに'),
    ],
  };
}

const usageDoc: JSONContent = {
  type: 'doc',
  content: [
    p('Evernotian の各機能の使い方です。'),

    h(2, 'PDFを検索できるようにする'),
    p('PDFをノートにドラッグ&ドロップすると、バックグラウンドで解析が始まります。進捗は添付ブロックに表示されます。'),
    bullets([
      'テキストが埋め込まれたPDFは、そのまま抽出します',
      'スキャンした画像だけのページは、自動でOCR（日本語＋英語）にかけます',
      '解析が終わったページから順に検索できるようになります',
      '検索結果をクリックすると、該当ページを開いて一致箇所を光らせます',
    ]),
    p('OCRは1ページ数秒かかります。長い資料は時間がかかりますが、待っている間も他の作業はできます。'),

    h(2, '第2の脳として使う'),
    codeBullets([['[[リンク]]', 'を張ると、リンク先には「バックリンク」が自動で表示されます']]),
    bullets([
      'まだ無いノートにもリンクできます。グラフでは破線の丸で表示されます',
      '右側の「AI」タブには、意味の近いノートが自動で並びます',
      'AIチャットは、保存したノートとPDFだけを根拠に答え、出典を示します',
    ]),

    h(2, 'AI機能について'),
    p('チャット・自動タグ・要約には Claude APIキーが必要です。設定画面から登録できます。'),
    p('キーが無くても、ノート・PDF全文検索・OCR・リンク・グラフ・関連ノートはすべて動きます。意味の近さの計算はこの端末の中で行っているためです。'),
    p('#使い方'),
  ],
};

const japaneseDoc: JSONContent = {
  type: 'doc',
  content: [
    p('日本語は単語が空白で区切られないため、ふつうの全文検索では「予算」のような2文字の語が引けません。'),

    h(2, '何が問題か'),
    bullets([
      'SQLite FTS5 の unicode61 は、漢字の連なりを丸ごと1語として扱います',
      'trigram は3文字単位で索引するため、2文字の検索語に構造的に答えられません',
      'ところが 予算・契約・会議 のような2文字語は、日本語で最もよく検索される形です',
    ]),

    h(2, 'どうしているか'),
    p('本文を重なり合う2文字（バイグラム）に分解して索引し、検索語も同じ方法で分解してフレーズとして問い合わせています。並びの隣接が保証されるので、結果として部分一致と同じ意味になります。'),
    {
      type: 'codeBlock',
      content: [
        {
          type: 'text',
          text: '索引:  機械学習のモデルを東京で訓練した\n    →  機械 械学 学習 習の のモ モデ デル ルを を東 東京 京で ...\n\n検索:  東京     → "東京"\n       機械学習 → "機械 械学 学習"',
        },
      ],
    },
    p('全角と半角、大文字と小文字も揃えているので、ＴＯＫＹＯ で tokyo が見つかります。'),
    p('なお、この方式では「京都」が「東京都」に一致することがあります。形態素解析を使えば防げますが、辞書にない固有名詞や専門用語が検索できなくなる副作用のほうが困るため、この設計を選んでいます。'),
    p('#使い方'),
  ],
};

/** True when this owner has never had a page. */
function isEmpty(ownerId: string): boolean {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM pages WHERE owner_id = ?')
    .get(ownerId) as { n: number };
  return row.n === 0;
}

/**
 * Give one account its starting notes.
 *
 * Per account rather than per instance: the second person to sign in opens to
 * an empty sidebar otherwise, with no hint that `/`, `[[` or `#` do anything.
 */
export function seedWelcomeNotes(ownerId: string): boolean {
  if (!isEmpty(ownerId)) return false;

  // Children first, so the welcome note's links resolve on its very first save
  // rather than sitting unresolved until something touches them again.
  const welcome = createPage(ownerId, { title: 'はじめに', icon: '👋' });
  const usage = createPage(ownerId, { title: '使い方のヒント', icon: '💡', parentId: welcome.id });
  const japanese = createPage(ownerId, { title: '日本語検索について', icon: '🔍', parentId: welcome.id });

  updatePage(ownerId, usage.id, { doc: usageDoc });
  updatePage(ownerId, japanese.id, { doc: japaneseDoc });
  updatePage(ownerId, welcome.id, { doc: welcomeDoc(usage.id, japanese.id) });

  return true;
}
