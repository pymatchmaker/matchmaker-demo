import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { ScoreRenderer, NoteInfo } from '../utils/scoreRenderer';

export class OSMDRendererImpl implements ScoreRenderer {
  private osmd: OpenSheetMusicDisplay | null = null;
  private notes: NoteInfo[] = [];
  private timeIndexMap: { [key: number]: number } = {};
  private onNotesRegistered?: (notes: NoteInfo[], timeIndexMap: { [key: number]: number }) => void;
  private lastCursorTop?: number;

  constructor(container: HTMLElement, onNotesRegistered?: (notes: NoteInfo[], timeIndexMap: { [key: number]: number }) => void) {
    this.osmd = new OpenSheetMusicDisplay(container, {
      autoResize: true,
      drawTitle: true,
    });
    this.osmd.zoom = 0.5;
    this.osmd.EngravingRules.TitleTopDistance = 2;
    this.osmd.EngravingRules.SheetTitleHeight = 2.5;
    this.osmd.EngravingRules.SheetSubtitleHeight = 1.5;
    this.osmd.EngravingRules.SheetComposerHeight = 1.5;
    this.osmd.EngravingRules.FixedMeasureWidth = false;
    this.onNotesRegistered = onNotesRegistered;
  }

  async load(content: string): Promise<void> {
    if (!this.osmd) {
      throw new Error('OSMD not initialized');
    }
    await this.osmd.load(content);
  }

  async render(): Promise<void> {
    if (!this.osmd) {
      throw new Error('OSMD not initialized');
    }
    await this.osmd.render();
    this.extractNotes();
    
    if (this.onNotesRegistered) {
      this.onNotesRegistered(this.notes, this.timeIndexMap);
    }
  }

  private extractNotes(): void {
    if (!this.osmd || !this.osmd.cursor) return;

    const allNotes: NoteInfo[] = [];
    let iterator = this.osmd.cursor.Iterator;

    while (!iterator.EndReached) {
      const voices = iterator.CurrentVoiceEntries;
      for (let i = 0; i < voices.length; i++) {
        const v = voices[i];
        const notes = v.Notes;
        for (let j = 0; j < notes.length; j++) {
          const note = notes[j];
          if (note != null) {
            allNotes.push({
              note: note.halfTone + 12,
              time: iterator.currentTimeStamp.RealValue * 4,
              length: note.Length.RealValue,
            });
          }
        }
      }
      iterator.moveToNext();
    }

    // Remove duplicates and build time-to-index map
    const uniqueNotes: NoteInfo[] = [];
    const timeIndexMapObj: { [key: number]: number } = {};
    
    allNotes.forEach((note) => {
      if (!timeIndexMapObj.hasOwnProperty(note.time)) {
        uniqueNotes.push(note);
        timeIndexMapObj[note.time] = uniqueNotes.length - 1;
      }
    });

    this.notes = uniqueNotes;
    this.timeIndexMap = timeIndexMapObj;
  }

  getNotes(): NoteInfo[] {
    return this.notes;
  }

  moveToPosition(targetBeat: number): void {
    if (!this.osmd || !this.osmd.cursor) return;

    const currentBeat = this.getCurrentPosition();
    const currentIndex = this.timeIndexMap[currentBeat];
    let targetIndex = this.timeIndexMap[targetBeat];

    if (currentIndex === undefined) {
      console.warn(`Invalid current beat position: ${currentBeat}`);
      return;
    }

    if (targetIndex === undefined) {
      // Find the closest position
      const beats = Object.keys(this.timeIndexMap).map(Number).sort((a, b) => a - b);
      const closestBeat = beats.findLast((beat) => beat <= targetBeat) || beats[0];
      targetIndex = this.timeIndexMap[closestBeat];
    }

    const steps = targetIndex - currentIndex;

    if (steps > 0) {
      for (let i = 0; i < steps; i++) {
        this.osmd.cursor.next();
      }
    } else if (steps < 0) {
      for (let i = 0; i < Math.abs(steps); i++) {
        this.osmd.cursor.previous();
      }
    }

    this.osmd.cursor.update();
    this.osmd.cursor.show();

    const cursorEl = this.osmd.cursor.cursorElement;
    if (cursorEl) {
      // Dynamically set cursor height to match the current system's staff height
      const cursorImg = cursorEl.querySelector('img') as HTMLImageElement | null;
      if (cursorImg) {
        const container = cursorEl.closest('#osmdContainer');
        if (container) {
          const staves = container.querySelectorAll('.vf-stave');
          if (staves.length > 0) {
            const cursorRect = cursorEl.getBoundingClientRect();

            // Find staves in the same system (similar Y position)
            let minY = Infinity, maxY = -Infinity;
            staves.forEach((stave: Element) => {
              const r = stave.getBoundingClientRect();
              if (Math.abs(r.top - cursorRect.top) < 200) {
                minY = Math.min(minY, r.top);
                maxY = Math.max(maxY, r.bottom);
              }
            });

            if (minY !== Infinity) {
              const h = Math.round(maxY - minY);
              cursorImg.height = h;
              cursorImg.style.height = `${h}px`;
            }
          }
        }
      }

      // Auto-scroll only when system changes
      const cursorTop = cursorEl.getBoundingClientRect().top;
      if (this.lastCursorTop === undefined || Math.abs(cursorTop - this.lastCursorTop) > 50) {
        cursorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      this.lastCursorTop = cursorTop;
    }
  }

  highlightPosition(beat: number): void {
    // OSMD uses cursor to indicate position, so this is handled in moveToPosition
    this.moveToPosition(beat);
  }

  getCurrentPosition(): number {
    if (!this.osmd || !this.osmd.cursor || !this.osmd.cursor.Iterator) {
      return 0;
    }
    return this.osmd.cursor.Iterator.currentTimeStamp.RealValue * 4;
  }

  reset(): void {
    if (this.osmd && this.osmd.cursor) {
      this.osmd.cursor.reset();
    }
  }

  show(): void {
    if (this.osmd && this.osmd.cursor) {
      this.osmd.cursor.show();
    }
  }

  hide(): void {
    if (this.osmd && this.osmd.cursor) {
      this.osmd.cursor.hide();
    }
  }

  getCursor() {
    return this.osmd?.cursor;
  }
}

