import { useEffect, useRef, useState } from "react";
import { MaximizeIcon, MinusIcon, PlusIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogTrigger } from "./ui/dialog";

export interface DiagramView {
  x: number;
  y: number;
  scale: number;
}

const INITIAL_VIEW: DiagramView = { x: 0, y: 0, scale: 1 };

export function zoomDiagram(view: DiagramView, factor: number, x = 0, y = 0): DiagramView {
  const scale = Math.min(8, Math.max(0.25, view.scale * factor));
  const ratio = scale / view.scale;
  return { scale, x: x - (x - view.x) * ratio, y: y - (y - view.y) * ratio };
}

function Canvas({ svg, expanded }: { svg: string; expanded: boolean }) {
  const [view, setView] = useState(INITIAL_VIEW);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      // Ordinary scrolling still scrolls the conversation in the inline preview.
      if (!expanded && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
      setView((current) =>
        zoomDiagram(
          current,
          Math.exp(-delta * 0.002),
          event.clientX - rect.left - rect.width / 2,
          event.clientY - rect.top - rect.height / 2,
        ),
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [expanded]);

  return (
    <div className={`flex min-h-0 flex-col ${expanded ? "flex-1" : "h-full"}`}>
      <div className="flex items-center gap-1 border-b border-border/60 px-3 py-1">
        <Button
          size="icon"
          variant="ghost"
          aria-label="Zoom out"
          disabled={view.scale <= 0.25}
          onClick={() => setView((current) => zoomDiagram(current, 1 / 1.25))}
        >
          <MinusIcon />
        </Button>
        <span className="w-12 text-center text-xs tabular-nums">
          {Math.round(view.scale * 100)}%
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Zoom in"
          disabled={view.scale >= 8}
          onClick={() => setView((current) => zoomDiagram(current, 1.25))}
        >
          <PlusIcon />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          aria-label="Reset diagram view"
          onClick={() => setView(INITIAL_VIEW)}
        >
          <RotateCcwIcon />
        </Button>
        <span className="ml-2 text-xs text-muted-foreground">
          Drag to pan · {expanded ? "Scroll" : "Ctrl/⌘ + scroll"} to zoom
        </span>
        {!expanded && (
          <DialogTrigger
            render={
              <Button className="ml-auto" size="icon" variant="ghost" aria-label="Expand diagram" />
            }
          >
            <MaximizeIcon />
          </DialogTrigger>
        )}
      </div>
      <div
        ref={viewport}
        role="region"
        aria-label="Mermaid diagram canvas. Use arrow keys to pan, plus or minus to zoom, and zero to reset."
        tabIndex={0}
        className={`relative min-h-0 touch-none overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-ring ${expanded ? "flex-1" : "h-80"} cursor-grab active:cursor-grabbing`}
        onKeyDown={(event) => {
          const offsets: Record<string, [number, number]> = {
            ArrowLeft: [-40, 0],
            ArrowRight: [40, 0],
            ArrowUp: [0, -40],
            ArrowDown: [0, 40],
          };
          const offset = offsets[event.key];
          if (offset)
            setView((current) => ({
              ...current,
              x: current.x + offset[0],
              y: current.y + offset[1],
            }));
          else if (event.key === "+" || event.key === "=")
            setView((current) => zoomDiagram(current, 1.25));
          else if (event.key === "-") setView((current) => zoomDiagram(current, 1 / 1.25));
          else if (event.key === "0") setView(INITIAL_VIEW);
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || drag.current) return;
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
        }}
        onPointerMove={(event) => {
          const previous = drag.current;
          if (!previous || previous.id !== event.pointerId) return;
          const dx = event.clientX - previous.x;
          const dy = event.clientY - previous.y;
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
          setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
        }}
        onPointerUp={(event) => {
          if (drag.current?.id !== event.pointerId) return;
          drag.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
      >
        <div
          className="pointer-events-none absolute inset-4 select-none [&>svg]:h-full! [&>svg]:w-full! [&>svg]:max-w-none!"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
          data-mermaid-diagram=""
          // Mermaid sanitizes this SVG in strict security mode. No event bindings are installed.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  );
}

export default function MermaidCanvas({ svg }: { svg: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Dialog open={expanded} onOpenChange={setExpanded}>
      <div className={expanded ? "invisible" : undefined} aria-hidden={expanded} inert={expanded}>
        <Canvas svg={expanded ? "" : svg} expanded={false} />
      </div>
      <DialogPopup
        className="flex h-[90dvh] w-[95vw] max-w-none flex-col"
        bottomStickOnMobile={false}
      >
        <DialogTitle className="px-4 py-3 text-base">Mermaid diagram</DialogTitle>
        {expanded && <Canvas svg={svg} expanded />}
      </DialogPopup>
    </Dialog>
  );
}
