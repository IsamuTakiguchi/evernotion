import { GraphCanvas } from '@/components/graph/GraphCanvas';

export const dynamic = 'force-dynamic';

export default function GraphPage() {
  return (
    <div className="h-screen">
      <GraphCanvas />
    </div>
  );
}
