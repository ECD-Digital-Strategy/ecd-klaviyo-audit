import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { loadPdfJs } from '../../lib/pdf-docs';

type PdfDoc = Awaited<ReturnType<Awaited<ReturnType<typeof loadPdfJs>>['getDocument']>['promise']>;

/**
 * The pages of a PDF, one under the other, each drawn when it scrolls near the screen (a 46-page contract stays
 * light). renderOverlay draws on top of a page, in a box exactly the page's size, so fields can be placed in
 * fractions of it. Each page has id="pdf-page-<n>" to scroll to.
 */
export default function PdfPages({
  url,
  renderOverlay,
  className,
}: {
  url: string;
  renderOverlay?: (page: number) => ReactNode;
  className?: string;
}) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [ratios, setRatios] = useState<number[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDoc | null = null;
    (async () => {
      try {
        const pdfjs = await loadPdfJs();
        loaded = await pdfjs.getDocument({ url }).promise;
        const r: number[] = [];
        for (let n = 1; n <= loaded.numPages; n++) {
          const vp = (await loaded.getPage(n)).getViewport({ scale: 1 });
          r.push(vp.height / vp.width);
        }
        if (!cancelled) {
          setDoc(loaded);
          setRatios(r);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'The PDF could not be opened.');
      }
    })();
    return () => {
      cancelled = true;
      void loaded?.destroy();
    };
  }, [url]);

  if (error) return <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</div>;
  if (!doc) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Opening the PDF…
      </div>
    );
  }
  return (
    <div className={className}>
      {ratios.map((ratio, i) => (
        <PdfPage key={i} doc={doc} page={i + 1} ratio={ratio} overlay={renderOverlay?.(i + 1)} />
      ))}
    </div>
  );
}

function PdfPage({ doc, page, ratio, overlay }: { doc: PdfDoc; page: number; ratio: number; overlay?: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [drawnWidth, setDrawnWidth] = useState(0);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const io = new IntersectionObserver(entries => entries.some(e => e.isIntersecting) && setNear(true), { rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;
    const width = box.clientWidth;
    if (!width || Math.abs(width - drawnWidth) < 2) return;
    let task: { cancel: () => void; promise: Promise<unknown> } | null = null;
    let cancelled = false;
    (async () => {
      const p = await doc.getPage(page);
      if (cancelled) return;
      const base = p.getViewport({ scale: 1 });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = p.getViewport({ scale: (width / base.width) * dpr });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      task = p.render({ canvasContext: ctx, viewport });
      await task.promise.catch(() => {});
      if (!cancelled) setDrawnWidth(width);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, doc, page, drawnWidth]);

  return (
    <div id={`pdf-page-${page}`} className="mb-4 scroll-mt-24">
      <div ref={boxRef} className="relative w-full overflow-hidden rounded-md bg-white shadow ring-1 ring-gray-200" style={{ aspectRatio: `1 / ${ratio}` }}>
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
        {overlay && <div className="absolute inset-0">{overlay}</div>}
      </div>
      <p className="mt-1 text-center text-[11px] text-gray-400">Page {page}</p>
    </div>
  );
}
