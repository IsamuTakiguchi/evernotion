import { ChatPanel } from '@/components/ai/ChatPanel';
import { PageTransition } from '@/components/layout/PageTransition';

export const dynamic = 'force-dynamic';

export default function ChatPage() {
  return (
    <PageTransition>
      <ChatPanel />
    </PageTransition>
  );
}
