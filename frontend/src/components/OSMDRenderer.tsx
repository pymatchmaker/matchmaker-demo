import { OpenSheetMusicDisplay, CursorType } from 'opensheetmusicdisplay';
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
      cursorsOptions: [
        { type: CursorType.Standard, color: '#33cc33', alpha: 0.6, follow: false },
        { type: CursorType.CurrentArea, color: '#3b82f6', alpha: 0.1, follow: false },
      ],
    });
    this.osmd.zoom = 0.5;
    this.osmd.EngravingRules.TitleTopDistance = 2;
    this.osmd.EngravingRules.SheetTitleHeight = 2.5;
    this.osmd.EngravingRules.SheetSubtitleHeight = 1.5;
    this.osmd.EngravingRules.SheetComposerHeight = 1.5;
    this.osmd.EngravingRules.StretchLastSystemLine = true;
    this.osmd.EngravingRules.FixedMeasureWidth = false;
    this.onNotesRegistered = onNotesRegistered;
  }

  async load(content: string): Promise<void> {
    if (!this.osmd) throw new Error('OSMD not initialized');
    await this.osmd.load(content);
  }

  async render(): Promise<void> {
    if (!this.osmd) throw new Error('OSMD not initialized');
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

    if (currentIndex === undefined) return;

    if (targetIndex === undefined) {
      const beats = Object.keys(this.timeIndexMap).map(Number).sort((a, b) => a - b);
      const closestBeat = beats.findLast((beat) => beat <= targetBeat) || beats[0];
      targetIndex = this.timeIndexMap[closestBeat];
    }

    const steps = targetIndex - currentIndex;
    const cursors = (this.osmd as any).cursors as any[];

    if (steps > 0) {
      for (let i = 0; i < steps; i++) {
        if (cursors) { for (const c of cursors) c.next(); }
        else { this.osmd.cursor.next(); }
      }
    } else if (steps < 0) {
      for (let i = 0; i < Math.abs(steps); i++) {
        if (cursors) { for (const c of cursors) c.previous(); }
        else { this.osmd.cursor.previous(); }
      }
    }

    if (cursors) {
      for (const c of cursors) { c.update(); c.show(); }
    } else {
      this.osmd.cursor.update();
      this.osmd.cursor.show();
    }

    // Auto-scroll only when system changes
    const cursorEl = this.osmd.cursor.cursorElement;
    if (cursorEl) {
      const cursorTop = cursorEl.getBoundingClientRect().top;
      if (this.lastCursorTop === undefined || Math.abs(cursorTop - this.lastCursorTop) > 50) {
        cursorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      this.lastCursorTop = cursorTop;
    }
  }

  highlightPosition(beat: number): void {
    this.moveToPosition(beat);
  }

  getCurrentPosition(): number {
    if (!this.osmd || !this.osmd.cursor || !this.osmd.cursor.Iterator) return 0;
    return this.osmd.cursor.Iterator.currentTimeStamp.RealValue * 4;
  }

  reset(): void {
    if (!this.osmd) return;
    const cursors = (this.osmd as any).cursors as any[];
    if (cursors) {
      for (const c of cursors) c.reset();
    } else if (this.osmd.cursor) {
      this.osmd.cursor.reset();
    }
  }

  show(): void {
    if (!this.osmd) return;
    const cursors = (this.osmd as any).cursors as any[];
    if (cursors) {
      for (const c of cursors) c.show();
    } else if (this.osmd.cursor) {
      this.osmd.cursor.show();
    }
  }

  hide(): void {
    if (!this.osmd) return;
    const cursors = (this.osmd as any).cursors as any[];
    if (cursors) {
      for (const c of cursors) c.hide();
    } else if (this.osmd.cursor) {
      this.osmd.cursor.hide();
    }
  }
}
