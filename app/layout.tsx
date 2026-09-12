import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AppShell } from '@/components/layout/AppShell';

export const metadata: Metadata = {
  title: 'Evernotion',
  description: 'ノート・PDF全文検索・第2の脳を1つにしたローカルノートアプリ',
  manifest: '/manifest.webmanifest',
  applicationName: 'Evernotion',
};

export const viewport: Viewport = {
  themeColor: '#6366f1',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        {/*
          Applied before paint so a dark-mode reload never flashes white.
          Inline because it must run ahead of React hydration.
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('ev-theme');
              var d=t?t==='dark':matchMedia('(prefers-color-scheme: dark)').matches;
              if(d)document.documentElement.classList.add('dark');}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
