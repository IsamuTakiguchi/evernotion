'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { IconSpinner } from '@/components/ui/Icons';

type PreflightIssue = { level: 'warning' | 'error'; message: string; detail: string };

type SetupState = {
  phase: 'starting' | 'downloading' | 'ready' | 'error';
  message: string;
  modelsReady: boolean;
  seeded: boolean;
  error: string | null;
  issues: PreflightIssue[];
};

/**
 * First-run progress, shown at the foot of the sidebar.
 *
 * The app is fully usable while this is running — only OCR and semantic search
 * wait on the download — so this is deliberately a quiet strip rather than a
 * blocking dialog, and it disappears entirely once everything is in place.
 */
export function SetupStatus() {
  const [state, setState] = useState<SetupState | null>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const next = await api.get<SetupState>('/api/setup/status');
        if (stop) return;
        setState(next);
        // Stop polling once there is nothing left to report.
        if (next.phase === 'starting' || next.phase === 'downloading') {
          timer = setTimeout(poll, 2000);
        }
      } catch {
        if (!stop) timer = setTimeout(poll, 5000);
      }
    };
    void poll();

    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);

  const issues = state?.issues ?? [];
  // A deployment problem stays on screen even once startup is otherwise fine:
  // "your data will be lost on the next deploy" does not stop being true.
  if (!state || (state.phase === 'ready' && issues.length === 0)) return null;

  const busy = state.phase === 'starting' || state.phase === 'downloading';

  return (
    <div className="mx-2 mb-2 space-y-1.5">
      {issues.map((issue, i) => (
        <div
          key={i}
          className="ev-glass ev-anim-pop rounded-xl border px-2.5 py-2 text-[11.5px] leading-relaxed"
          style={{
            borderColor: issue.level === 'error' ? 'var(--danger)' : undefined,
            color: issue.level === 'error' ? 'var(--danger)' : 'var(--text-muted)',
          }}
          title={issue.detail}
        >
          <span className="mr-1" aria-hidden>⚠</span>
          {issue.message}
        </div>
      ))}
      {state.phase !== 'ready' && (
        <div
          className="ev-glass ev-anim-pop rounded-xl border px-2.5 py-2 text-[11.5px] leading-relaxed"
          style={{ color: 'var(--text-muted)' }}
        >
          <div className="flex items-start gap-1.5">
            {busy && <IconSpinner size={12} className="mt-0.5 shrink-0" />}
            <div className="min-w-0">
              <div style={{ color: state.phase === 'error' ? 'var(--danger)' : undefined }}>
                {state.message}
              </div>
              {busy && (
                <div className="mt-0.5" style={{ color: 'var(--text-faint)' }}>
                  ノートと検索はこの間も使えます
                </div>
              )}
              {state.phase === 'error' && (
                <div className="mt-0.5" style={{ color: 'var(--text-faint)' }}>
                  OCRと意味検索は次に使うとき再試行します
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
