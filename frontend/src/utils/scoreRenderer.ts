/**
 * Score Renderer Utilities
 * 파일 형식 감지 및 렌더러 추상화
 */

export type ScoreFormat = "musicxml" | "mei" | "unknown";

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

/**
 * 파일 확장자로부터 형식 감지
 */
export function detectScoreFormat(fileName: string): ScoreFormat {
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith(".mei")) {
    return "mei";
  } else if (lowerName.endsWith(".xml") || lowerName.endsWith(".musicxml")) {
    return "musicxml";
  }

  return "unknown";
}

/**
 * 파일 내용으로부터 형식 감지 (확장자가 없는 경우)
 */
export function detectScoreFormatFromContent(content: string): ScoreFormat {
  // MEI 파일은 보통 <mei> 또는 <meiHead> 태그로 시작
  if (content.trim().startsWith("<?xml")) {
    if (content.includes("<mei") || content.includes("<meiHead")) {
      return "mei";
    } else if (
      content.includes("<score-partwise") ||
      content.includes("<score-timewise")
    ) {
      return "musicxml";
    }
  }

  return "unknown";
}
