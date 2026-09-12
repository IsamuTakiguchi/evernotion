'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation,
  type Simulation, type SimulationNodeDatum,
} from 'd3-force';
import { api } from '@/lib/client/api';
import { IconSpinner } from '@/components/ui/Icons';

type ApiNode = {
  id: string; title: string; icon: string | null; degree: number; tag: string | null; ghost: boolean;
};
type ApiLink = { source: string; target: string; unresolved: boolean };

type Node = ApiNode & SimulationNodeDatum;
type Link = { source: Node; target: Node; unresolved: boolean };

/** Distinct, colour-blind-safe hues assigned per tag. */
const TAG_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#ef4444'];

/**
 * Force-directed graph on a 2D canvas.
 *
 * d3-force does the layout; drawing is by hand rather than through a graph
 * library, which keeps the dependency footprint to one small ISC package.
 */
export function GraphCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ nodes: 0, links: 0 });
  const [hover, setHover] = useState<Node | null>(null);

  useEffect(() => {
    let simulation: Simulation<Node, undefined> | null = null;
    let frame = 0;
    let disposed = false;

    // View transform, driven by wheel-zoom and drag-pan.
    const view = { x: 0, y: 0, k: 1 };
    let nodes: Node[] = [];
    let links: Link[] = [];

    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;

    const resize = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = wrap.clientWidth * dpr;
      canvas.height = wrap.clientHeight * dpr;
      canvas.style.width = `${wrap.clientWidth}px`;
      canvas.style.height = `${wrap.clientHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const radius = (n: Node) => 4 + Math.sqrt(n.degree) * 3.2;

    const colorFor = (n: Node) => {
      if (n.ghost) return 'var(--text-faint)';
      if (!n.tag) return '#6366f1';
      let hash = 0;
      for (const ch of n.tag) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
      return TAG_COLORS[hash % TAG_COLORS.length];
    };

    const draw = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const styles = getComputedStyle(document.documentElement);
      const textColor = styles.getPropertyValue('--text').trim() || '#333';
      const faint = styles.getPropertyValue('--text-faint').trim() || '#999';
      const bg = styles.getPropertyValue('--bg').trim() || '#fff';

      ctx.save();
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
      ctx.translate(view.x, view.y);
      ctx.scale(view.k, view.k);

      for (const link of links) {
        ctx.beginPath();
        ctx.moveTo(link.source.x ?? 0, link.source.y ?? 0);
        ctx.lineTo(link.target.x ?? 0, link.target.y ?? 0);
        ctx.strokeStyle = faint;
        ctx.globalAlpha = link.unresolved ? 0.3 : 0.45;
        ctx.lineWidth = 1 / view.k;
        ctx.setLineDash(link.unresolved ? [4 / view.k, 3 / view.k] : []);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      for (const node of nodes) {
        const r = radius(node);
        ctx.beginPath();
        ctx.arc(node.x ?? 0, node.y ?? 0, r, 0, Math.PI * 2);
        ctx.fillStyle = node.ghost ? bg : colorFor(node);
        ctx.fill();
        if (node.ghost) {
          ctx.strokeStyle = faint;
          ctx.lineWidth = 1.5 / view.k;
          ctx.setLineDash([3 / view.k, 2 / view.k]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      // Labels only when zoomed in enough to read them, or on hover.
      if (view.k > 0.7) {
        // An explicit Japanese-capable stack; the canvas default renders tofu.
        ctx.font = `${11 / view.k}px system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = textColor;
        for (const node of nodes) {
          const label = node.title.length > 14 ? `${node.title.slice(0, 14)}…` : node.title;
          ctx.fillText(label, node.x ?? 0, (node.y ?? 0) + radius(node) + 12 / view.k);
        }
      }
      ctx.restore();
    };

    const tick = () => {
      draw();
      frame = requestAnimationFrame(tick);
    };

    const toWorld = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left - view.x) / view.k,
        y: (clientY - rect.top - view.y) / view.k,
      };
    };

    const nodeAt = (clientX: number, clientY: number): Node | null => {
      const { x, y } = toWorld(clientX, clientY);
      for (const node of nodes) {
        const dx = (node.x ?? 0) - x;
        const dy = (node.y ?? 0) - y;
        if (dx * dx + dy * dy <= (radius(node) + 4) ** 2) return node;
      }
      return null;
    };

    let dragging: { node: Node | null; startX: number; startY: number; viewX: number; viewY: number } | null = null;

    const onPointerDown = (e: PointerEvent) => {
      const node = nodeAt(e.clientX, e.clientY);
      dragging = { node, startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y };
      if (node) simulation?.alphaTarget(0.25).restart();
      canvas.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) {
        setHover(nodeAt(e.clientX, e.clientY));
        canvas.style.cursor = nodeAt(e.clientX, e.clientY) ? 'pointer' : 'grab';
        return;
      }
      if (dragging.node) {
        const { x, y } = toWorld(e.clientX, e.clientY);
        dragging.node.fx = x;
        dragging.node.fy = y;
      } else {
        view.x = dragging.viewX + (e.clientX - dragging.startX);
        view.y = dragging.viewY + (e.clientY - dragging.startY);
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const moved =
        dragging && Math.hypot(e.clientX - dragging.startX, e.clientY - dragging.startY) > 4;
      if (dragging?.node) {
        dragging.node.fx = null;
        dragging.node.fy = null;
        simulation?.alphaTarget(0);
        // A click, not a drag: open the page. Ghost nodes have no page to open.
        if (!moved && !dragging.node.ghost) router.push(`/p/${dragging.node.id}`);
      }
      dragging = null;
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.min(4, Math.max(0.15, view.k * factor));
      // Zoom about the cursor, so the point under it stays put.
      view.x = mx - ((mx - view.x) * next) / view.k;
      view.y = my - ((my - view.y) * next) / view.k;
      view.k = next;
    };

    (async () => {
      try {
        const data = await api.get<{ nodes: ApiNode[]; links: ApiLink[] }>('/api/graph');
        if (disposed) return;

        nodes = data.nodes.map((n) => ({ ...n }));
        const byId = new Map(nodes.map((n) => [n.id, n]));
        links = data.links
          .map((l) => ({
            source: byId.get(l.source)!,
            target: byId.get(l.target)!,
            unresolved: l.unresolved,
          }))
          .filter((l) => l.source && l.target);

        setStats({ nodes: nodes.length, links: links.length });

        resize();
        const w = canvas.clientWidth || 800;
        const h = canvas.clientHeight || 600;
        view.x = w / 2;
        view.y = h / 2;

        simulation = forceSimulation(nodes)
          .force('link', forceLink<Node, Link>(links).id((d) => d.id).distance(70).strength(0.5))
          .force('charge', forceManyBody().strength(-190))
          .force('collide', forceCollide<Node>().radius((d) => radius(d) + 6))
          .force('center', forceCenter(0, 0))
          .alphaDecay(0.028);

        tick();
      } finally {
        if (!disposed) setLoading(false);
      }
    })();

    window.addEventListener('resize', resize);
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      simulation?.stop();
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [router]);

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />

      <div
        className="pointer-events-none absolute left-4 top-4 rounded-lg border px-3 py-2 text-[12px]"
        style={{ background: 'var(--bg)', color: 'var(--text-muted)', boxShadow: 'var(--shadow)' }}
      >
        {loading ? (
          <span className="flex items-center gap-2">
            <IconSpinner size={13} /> 読み込み中…
          </span>
        ) : (
          <>
            <div>{stats.nodes} ノート · {stats.links} リンク</div>
            <div className="mt-1" style={{ color: 'var(--text-faint)' }}>
              ドラッグで移動 · ホイールで拡大 · クリックで開く
            </div>
            <div className="mt-1" style={{ color: 'var(--text-faint)' }}>
              破線と白丸は未作成のリンク先
            </div>
          </>
        )}
      </div>

      {hover && (
        <div
          className="pointer-events-none absolute bottom-4 left-4 rounded-lg border px-3 py-1.5 text-[13px]"
          style={{ background: 'var(--bg)', boxShadow: 'var(--shadow)' }}
        >
          {hover.icon ? `${hover.icon} ` : ''}
          {hover.title}
          {hover.ghost && <span style={{ color: 'var(--text-faint)' }}>（未作成）</span>}
        </div>
      )}
    </div>
  );
}
