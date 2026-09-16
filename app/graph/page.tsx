import { GraphCanvas } from '@/components/graph/GraphCanvas';
import { PageTransition } from '@/components/layout/PageTransition';

export const dynamic = 'force-dynamic';

export default function GraphPage() {
  return (
    <PageTransition>
      <div className="h-screen">
        <GraphCanvas />
      </div>
    </PageTransition>
  );
}
