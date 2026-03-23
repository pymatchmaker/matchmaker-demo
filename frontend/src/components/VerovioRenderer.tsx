import { ScoreRenderer, NoteInfo } from '../utils/scoreRenderer';

let VerovioToolkitClass: any = null;
let VerovioModule: any = null;
let verovioLoadPromise: Promise<void> | null = null;

const loadVerovio = async (): Promise<void> => {
  if (VerovioToolkitClass && VerovioModule) return;
  if (verovioLoadPromise) return verovioLoadPromise;
  if (typeof window === 'undefined') throw new Error('Verovio requires browser');

  verovioLoadPromise = Promise.all([
    import('verovio/wasm') as Promise<any>,
    import('verovio/esm') as Promise<any>,
  ]).then(async ([wasmMod, esmMod]) => {
    VerovioModule = await (wasmMod.default || wasmMod)();
    VerovioToolkitClass = esmMod.VerovioToolkit;
  });
  return verovioLoadPromise;
};

/**
 * Verovio SVG structure:
 *   <svg width="Wpx" height="Hpx">            <- pixel dimensions
 *     <svg class="definition-scale" viewBox="0 0 VW VH">  <- internal coordinate system
 *       <g class="page-margin" transform="translate(MX, MY)">
 *         <g class="system">
 *           <g class="staff" id="m1s1"> ... </g>
 *           <g class="note" id="nXXX">
 *             <use transform="translate(X, Y) scale(...)"/>
 *
 * note.getBBox() is relative to the page-margin coordinate system.
 * The cursor rect must also be appended to page-margin so coordinates match.
 */
export class VerovioRendererImpl implements ScoreRenderer {
  private toolkit: any = null;
  private container: HTMLDivElement | null = null;
  private onNotesRegistered?: (notes: NoteInfo[], timeIndexMap: { [key: number]: number }) => void;
  private notes: NoteInfo[] = [];
  private timeIndexMap: { [key: number]: number } = {};
  private quarterToNoteId: Map<number, string> = new Map();
  private cursorRect: SVGRectElement | null = null;
  private measureRect: SVGRectElement | null = null;
  private currentBeat = 0;
  private currentNoteId: string | null = null;
  private lastNoteTop?: number;

  constructor(
    container: HTMLDivElement,
    onNotesRegistered?: (notes: NoteInfo[], timeIndexMap: { [key: number]: number }) => void,
  ) {
    this.container = container;
    this.onNotesRegistered = onNotesRegistered;
  }

  async load(content: string): Promise<void> {
    await loadVerovio();
    this.toolkit = new VerovioToolkitClass(VerovioModule);
    this.toolkit.setOptions({
      scale: 30,
      pageWidth: 2000,
      pageHeight: 3000,
      adjustPageHeight: true,
      minLastJustification: 0,
      breaks: 'encoded',
    });
    if (!this.toolkit.loadData(content)) {
      throw new Error('Failed to load data into Verovio');
    }
  }

  async render(): Promise<void> {
    if (!this.toolkit || !this.container) throw new Error('Not initialized');

    this.container.innerHTML = this.toolkit.renderToSVG(1, false);

    // Responsive: fit SVG to container width
    const outerSvg = this.container.querySelector('svg');
    if (outerSvg) {
      outerSvg.removeAttribute('width');
      outerSvg.removeAttribute('height');
      outerSvg.style.width = '100%';
      outerSvg.style.height = 'auto';

      // Copy viewBox from definition-scale SVG to outer SVG for responsive scaling
      const defScale = outerSvg.querySelector('svg.definition-scale') as SVGSVGElement | null;
      if (defScale) {
        const vb = defScale.getAttribute('viewBox');
        if (vb) outerSvg.setAttribute('viewBox', vb);
      }
    }

    this.buildPositionMap();
    this.extractNotes();

    if (this.onNotesRegistered) {
      this.onNotesRegistered(this.notes, this.timeIndexMap);
    }
  }

  // --- position map: qstamp → note element ID ---

  private buildPositionMap(): void {
    if (!this.toolkit || !this.container) return;
    this.quarterToNoteId.clear();

    const pageMargin = this.container.querySelector('g.page-margin');
    if (!pageMargin) return;

    const timemap = this.toolkit.renderToTimemap({ includeMeasures: true, includeRests: true });

    for (const entry of timemap) {
      if (entry.qstamp === undefined || !entry.on || entry.on.length === 0) continue;

      for (const noteId of entry.on) {
        if (pageMargin.querySelector(`#${noteId}`)) {
          this.quarterToNoteId.set(entry.qstamp, noteId);
          break;
        }
      }
    }

    console.log(`Verovio position map: ${this.quarterToNoteId.size} entries`);
  }

  private getNoteIdForQuarter(q: number): string | null {
    if (this.quarterToNoteId.has(q)) return this.quarterToNoteId.get(q)!;

    const keys = Array.from(this.quarterToNoteId.keys()).sort((a, b) => a - b);
    const prev = keys.findLast(k => k <= q);
    return prev !== undefined ? this.quarterToNoteId.get(prev)! : null;
  }

  // --- cursor highlight ---

  private getStaffYRangeInSystem(system: Element): { y: number; height: number } | null {
    const staffEls = system.querySelectorAll('g.staff');
    if (staffEls.length === 0) return null;

    let minY = Infinity, maxY = -Infinity;
    staffEls.forEach(el => {
      try {
        const bbox = (el as SVGGraphicsElement).getBBox();
        minY = Math.min(minY, bbox.y);
        maxY = Math.max(maxY, bbox.y + bbox.height);
      } catch { /* skip */ }
    });

    if (minY === Infinity) return null;
    return { y: minY, height: maxY - minY };
  }

  moveToPosition(targetBeat: number): void {
    this.currentBeat = targetBeat;
    this.highlightPosition(targetBeat);
  }

  highlightPosition(quarterPos: number): void {
    if (!this.container) return;

    const pageMargin = this.container.querySelector('g.page-margin');
    if (!pageMargin) return;

    // Snap to note: only update when position >= a note's onset
    const noteId = this.getNoteIdForQuarter(quarterPos);
    if (!noteId) return;

    // Skip if still on the same note
    if (noteId === this.currentNoteId) return;
    this.currentNoteId = noteId;

    this.removeCursor();

    const noteEl = pageMargin.querySelector(`#${noteId}`) as SVGGraphicsElement | null;
    if (!noteEl) return;

    // X coordinate: notehead center
    let x: number;
    try {
      const notehead = noteEl.querySelector('.notehead') as SVGGraphicsElement | null;
      if (notehead) {
        const hb = notehead.getBBox();
        x = hb.x + hb.width / 2;
      } else {
        const nb = noteEl.getBBox();
        x = nb.x + nb.width / 2;
      }
    } catch { return; }

    const system = noteEl.closest('g.system');
    if (!system) return;

    const staffRange = this.getStaffYRangeInSystem(system);
    if (!staffRange) return;

    // Measure highlight
    const measureEl = noteEl.closest('g.measure') as SVGGraphicsElement | null;
    if (measureEl) {
      try {
        const mb = measureEl.getBBox();
        const mRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        mRect.setAttribute('x', mb.x.toString());
        mRect.setAttribute('y', staffRange.y.toString());
        mRect.setAttribute('width', mb.width.toString());
        mRect.setAttribute('height', staffRange.height.toString());
        mRect.setAttribute('fill', '#3b82f6');
        mRect.setAttribute('opacity', '0.08');
        mRect.setAttribute('class', 'verovio-measure-highlight');
        mRect.style.pointerEvents = 'none';
        pageMargin.appendChild(mRect);
        this.measureRect = mRect;
      } catch { /* skip */ }
    }

    // Note cursor
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    const width = 60;
    rect.setAttribute('x', (x - width / 2).toString());
    rect.setAttribute('y', staffRange.y.toString());
    rect.setAttribute('width', width.toString());
    rect.setAttribute('height', staffRange.height.toString());
    rect.setAttribute('fill', '#33cc33');
    rect.setAttribute('opacity', '0.4');
    rect.setAttribute('class', 'verovio-cursor');
    rect.style.pointerEvents = 'none';

    pageMargin.appendChild(rect);
    this.cursorRect = rect;

    // Auto-scroll only when system changes
    const noteTop = noteEl.getBoundingClientRect().top;
    if (this.lastNoteTop === undefined || Math.abs(noteTop - this.lastNoteTop) > 50) {
      noteEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    this.lastNoteTop = noteTop;
  }

  private removeCursor(): void {
    if (this.measureRect) {
      this.measureRect.remove();
      this.measureRect = null;
    }
    if (this.cursorRect) {
      this.cursorRect.remove();
      this.cursorRect = null;
    }
  }

  // --- note extraction ---

  private extractNotes(): void {
    if (!this.toolkit) return;
    this.notes = [];
    this.timeIndexMap = {};

    const timemap = this.toolkit.renderToTimemap({ includeMeasures: false, includeRests: true });
    const seen = new Set<number>();

    for (const entry of timemap) {
      if (entry.qstamp === undefined || !entry.on || entry.on.length === 0) continue;
      const time = entry.qstamp;
      if (seen.has(time)) continue;
      seen.add(time);

      this.timeIndexMap[time] = this.notes.length;
      this.notes.push({ note: 60, time, length: 0.25 });
    }
  }

  getNotes(): NoteInfo[] { return this.notes; }
  getCurrentPosition(): number { return this.currentBeat; }

  reset(): void {
    this.currentBeat = 0;
    this.currentNoteId = null;
    this.removeCursor();
  }

  show(): void {
    if (this.currentBeat > 0) this.highlightPosition(this.currentBeat);
  }

  hide(): void {
    this.removeCursor();
  }
}
