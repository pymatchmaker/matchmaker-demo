import { ScoreRenderer, NoteInfo } from '../utils/scoreRenderer';

interface PixelMappingEntry {
  quarter: number;
  x: number;
  measure_left: number;
  measure_right: number;
  system_top: number;
  system_bottom: number;
}

interface PixelMapping {
  image_width: number;
  image_height: number;
  entries: PixelMappingEntry[];
}

export class ImageRendererImpl implements ScoreRenderer {
  private container: HTMLDivElement;
  private imageUrl: string;
  private pixelMapping: PixelMapping;
  private imgElement: HTMLImageElement | null = null;
  private measureHighlight: HTMLDivElement | null = null;
  private highlightBar: HTMLDivElement | null = null;
  private currentBeat = 0;
  private notes: NoteInfo[] = [];
  private timeIndexMap: { [key: number]: number } = {};
  private lastSystemTop?: number;

  constructor(container: HTMLDivElement, imageUrl: string, pixelMapping: PixelMapping) {
    this.container = container;
    this.imageUrl = imageUrl;
    this.pixelMapping = pixelMapping;
  }

  async load(_content: string): Promise<void> {
    const seen = new Set<number>();
    for (const entry of this.pixelMapping.entries) {
      if (!seen.has(entry.quarter)) {
        seen.add(entry.quarter);
        this.timeIndexMap[entry.quarter] = this.notes.length;
        this.notes.push({ note: 60, time: entry.quarter, length: 0.25 });
      }
    }
  }

  async render(): Promise<void> {
    this.container.innerHTML = '';
    this.container.style.position = 'relative';
    this.container.style.maxWidth = '1200px';
    this.container.style.margin = '0 auto';

    this.imgElement = document.createElement('img');
    this.imgElement.src = this.imageUrl;
    this.imgElement.style.maxHeight = '85vh';
    this.imgElement.style.width = 'auto';
    this.imgElement.style.margin = '0 auto';
    this.imgElement.style.display = 'block';
    this.container.appendChild(this.imgElement);

    this.measureHighlight = document.createElement('div');
    this.measureHighlight.style.position = 'absolute';
    this.measureHighlight.style.backgroundColor = 'rgba(59, 130, 246, 0.1)';
    this.measureHighlight.style.pointerEvents = 'none';
    this.measureHighlight.style.display = 'none';
    this.measureHighlight.style.borderRadius = '4px';
    this.container.appendChild(this.measureHighlight);

    this.highlightBar = document.createElement('div');
    this.highlightBar.style.position = 'absolute';
    this.highlightBar.style.backgroundColor = 'rgba(51, 204, 51, 0.35)';
    this.highlightBar.style.pointerEvents = 'none';
    this.highlightBar.style.display = 'none';
    this.highlightBar.style.width = '6px';
    this.highlightBar.style.borderRadius = '3px';
    this.container.appendChild(this.highlightBar);
  }

  moveToPosition(targetBeat: number): void {
    this.currentBeat = targetBeat;
    this.highlightPosition(targetBeat);
  }

  highlightPosition(quarterPos: number): void {
    if (!this.imgElement || !this.highlightBar || !this.measureHighlight) return;

    const entries = this.pixelMapping.entries;
    if (entries.length === 0) return;

    // Binary search: last entry where quarter <= quarterPos
    let lo = 0, hi = entries.length - 1;
    if (quarterPos < entries[0].quarter) lo = 0;
    else if (quarterPos >= entries[hi].quarter) lo = hi;
    else {
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (entries[mid].quarter <= quarterPos) lo = mid;
        else hi = mid - 1;
      }
    }
    const entry = entries[lo];

    // Scale pixel coords to displayed image size
    const displayHeight = this.imgElement.clientHeight;
    const scale = displayHeight / this.pixelMapping.image_height;
    const imgOffsetLeft = this.imgElement.offsetLeft;

    const barX = imgOffsetLeft + entry.x * scale;
    const barTop = entry.system_top * scale;
    const barHeight = (entry.system_bottom - entry.system_top) * scale;

    // Measure highlight
    const measureLeft = imgOffsetLeft + entry.measure_left * scale;
    const measureWidth = (entry.measure_right - entry.measure_left) * scale;
    this.measureHighlight.style.left = `${measureLeft}px`;
    this.measureHighlight.style.top = `${barTop}px`;
    this.measureHighlight.style.width = `${measureWidth}px`;
    this.measureHighlight.style.height = `${barHeight}px`;
    this.measureHighlight.style.display = 'block';

    // Note cursor
    this.highlightBar.style.left = `${barX - 3}px`;
    this.highlightBar.style.top = `${barTop}px`;
    this.highlightBar.style.height = `${barHeight}px`;
    this.highlightBar.style.display = 'block';

    // Track system change (no auto-scroll for single-page PDF)
    if (this.lastSystemTop === undefined || entry.system_top !== this.lastSystemTop) {
      this.lastSystemTop = entry.system_top;
    }
  }

  getNotes(): NoteInfo[] { return this.notes; }
  getCurrentPosition(): number { return this.currentBeat; }

  reset(): void {
    this.currentBeat = 0;
    this.lastSystemTop = undefined;
    if (this.highlightBar) this.highlightBar.style.display = 'none';
    if (this.measureHighlight) this.measureHighlight.style.display = 'none';
  }

  show(): void {
    if (this.currentBeat > 0) this.highlightPosition(this.currentBeat);
  }

  hide(): void {
    if (this.highlightBar) this.highlightBar.style.display = 'none';
    if (this.measureHighlight) this.measureHighlight.style.display = 'none';
  }
}
