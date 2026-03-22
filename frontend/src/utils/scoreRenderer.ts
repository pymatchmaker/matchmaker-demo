/**
 * Score Renderer Utilities
 * 렌더러 추상화
 */

export interface NoteInfo {
  note: number; // halfTone + 12
  time: number; // beat position
  length: number;
}

export interface ScoreRenderer {
  load(content: string): Promise<void>;
  render(): Promise<void>;
  getNotes(): NoteInfo[];
  moveToPosition(targetBeat: number): void;
  highlightPosition(beat: number): void;
  getCurrentPosition(): number;
  reset(): void;
  show(): void;
  hide(): void;
}
