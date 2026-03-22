import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { ScoreRenderer, NoteInfo } from '../utils/scoreRenderer';

export class OSMDRendererImpl implements ScoreRenderer {
  private osmd: OpenSheetMusicDisplay | null = null;
  private notes: NoteInfo[] = [];
  private timeIndexMap: { [key: number]: number } = {};
  private onNotesRegistered?: (notes: NoteInfo[], timeIndexMap: { [key: number]: number }) => void;

  constructor(container: HTMLElement, onNotesRegistered?: (notes: NoteInfo[], timeIndexMap: { [key: number]: number }) => void) {
    this.osmd = new OpenSheetMusicDisplay(container);
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

