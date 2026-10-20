import { sanitizeSvg } from "./svgSanitizer";

// The one renderer every reply's diagrams and formulas share: a hidden,
// sandboxed WebView (`RichRendererHost.tsx`) running Mermaid and KaTeX, and
// this, its queue. Drawing is serial — Mermaid's configuration is global, and
// one job at a time keeps a long reply from flooding the page — and each
// drawing is kept, by what was drawn and how it should look, so a reply that
// scrolls back into view or a chat opened again draws at once.
//
// The page is not trusted. Every message from it is parsed and checked here:
// it must answer the job in flight by its id, and its SVG is rebuilt by the
// sanitiser before anyone sees it. A page that does not answer in time is
// thrown away and started afresh, and its job reported as not drawn.
//
// No React Native here, so the regression suite drives it under Node.

export type RenderKind = "mermaid" | "math";
export type RenderJob = {
  kind: RenderKind;
  source: string;
  /** Pixels per em the drawing is set at. */
  fontSize: number;
  /** The face a diagram's labels are set in, one the phone has too. */
  fontFamily: string;
  /** A formula's ink. */
  color: string;
  /** A diagram's colours (`diagramTheme`). */
  theme: Record<string, string | boolean>;
};
export type RenderResult = { svg: string; width: number; height: number } | { error: string };

/** What the queue asks of the WebView that hosts the page. */
export type RendererPort = {
  /** Hands the page a job. */
  post(job: RenderJob & { id: string }): void;
  /** Throws the page away and loads it afresh; `ready()` follows. */
  reset(): void;
};

export const RENDER_TIMEOUT_MS = 15_000;
/** The most bytes of SVG a page's answer may carry. */
const MAX_ANSWER = 2_000_000;
const MAX_KEPT = 64;

type Timers = { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
const realTimers: Timers = { set: (callback, ms) => setTimeout(callback, ms), clear: (handle) => clearTimeout(handle as never) };

/** The key a drawing is kept under: what it draws and everything that changes how it looks. */
export function renderKey(job: RenderJob): string {
  const look = job.kind === "mermaid" ? [job.fontSize, job.fontFamily, JSON.stringify(job.theme)] : [job.fontSize, job.color];
  return `${job.kind}\0${look.join("\0")}\0${job.source}`;
}

export function createRichRenderer({ timers = realTimers, timeoutMs = RENDER_TIMEOUT_MS } = {}) {
  const kept = new Map<string, RenderResult>();
  const waiting = new Map<string, RenderJob>();
  let inFlight: { id: string; key: string; timer: unknown } | null = null;
  let port: RendererPort | null = null;
  let ready = false;
  let serial = 0;
  let wanted = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  function remember(key: string, result: RenderResult) {
    kept.delete(key);
    kept.set(key, result);
    if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value!);
  }

  function settle(result: RenderResult) {
    if (!inFlight) return;
    timers.clear(inFlight.timer);
    remember(inFlight.key, result);
    inFlight = null;
    notify();
    pump();
  }

  function pump() {
    if (inFlight || !port || !ready) return;
    const next = waiting.entries().next();
    if (next.done) return;
    const [key, job] = next.value;
    waiting.delete(key);
    const id = `r${++serial}`;
    inFlight = {
      id,
      key,
      timer: timers.set(() => {
        if (inFlight?.id !== id) return;
        // A page stuck on one drawing is stuck for all of them.
        ready = false;
        settle({ error: "The drawing took too long" });
        port?.reset();
      }, timeoutMs),
    };
    port.post({ ...job, id });
  }

  return {
    /** The drawing kept for this key, if any. */
    peek(key: string): RenderResult | undefined {
      const hit = kept.get(key);
      if (hit) {
        kept.delete(key);
        kept.set(key, hit);
      }
      return hit;
    },
    /** Asks for a drawing; the same one asked for twice while it waits is drawn once. */
    request(job: RenderJob): string {
      const key = renderKey(job);
      if (kept.has(key) || waiting.has(key) || inFlight?.key === key) return key;
      waiting.set(key, job);
      if (!wanted) {
        wanted = true;
        notify();
      }
      pump();
      return key;
    },
    /** Called on any change: a drawing kept, or the page first wanted. */
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Whether anything has asked for a drawing yet; the host mounts the page only then. */
    wanted: () => wanted,
    attach(next: RendererPort) {
      port = next;
      ready = false;
    },
    detach(next: RendererPort) {
      if (port !== next) return;
      port = null;
      ready = false;
      if (inFlight) settle({ error: "The renderer closed" });
    },
    /** A message from the page, as it arrived. */
    receive(raw: unknown) {
      if (typeof raw !== "string" || raw.length > MAX_ANSWER + 4_096) return;
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (!message || typeof message !== "object") return;
      const { type, id, svg, message: complaint } = message as Record<string, unknown>;
      if (type === "ready") {
        ready = true;
        pump();
        return;
      }
      if (!inFlight || id !== inFlight.id) return;
      if (type === "error") {
        settle({ error: typeof complaint === "string" && complaint ? complaint.slice(0, 500) : "The drawing failed" });
      } else if (type === "result") {
        const clean = typeof svg === "string" && svg.length <= MAX_ANSWER ? sanitizeSvg(svg) : null;
        settle(clean ?? { error: "The drawing could not be read" });
      }
    },
    /** The page's process died: its job is not drawn, and the page loads afresh. */
    crashed() {
      ready = false;
      if (inFlight) settle({ error: "The renderer stopped" });
      port?.reset();
    },
  };
}

export type RichRenderer = ReturnType<typeof createRichRenderer>;

/** The app's one renderer. */
export const richRenderer = createRichRenderer();

/**
 * How a drawing sits in a column `available` wide: at its own size when it
 * fits, else scaled down to the column, but never below `minScale`; past that
 * it keeps that scale and scrolls sideways. A formula passes 1, as the
 * desktop never shrinks one; a diagram may shrink to half.
 */
export function fitDrawing(
  drawing: { width: number; height: number },
  available: number,
  minScale: number,
): { width: number; height: number; scrolls: boolean } {
  if (!(available > 0) || !(drawing.width > 0) || !(drawing.height > 0)) {
    return { width: drawing.width, height: drawing.height, scrolls: false };
  }
  const scale = Math.min(1, available / drawing.width);
  const used = Math.max(scale, Math.min(1, minScale));
  return { width: drawing.width * used, height: drawing.height * used, scrolls: drawing.width * used > available + 0.5 };
}
