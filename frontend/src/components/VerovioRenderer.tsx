import React, { useEffect, useRef } from 'react';
import { ScoreRenderer, NoteInfo } from '../utils/scoreRenderer';

// Verovio를 동적으로 import하여 클라이언트 사이드에서만 로드
let VerovioToolkitClass: any = null;
let VerovioModule: any = null;
let verovioLoadPromise: Promise<{ VerovioToolkit: any; VerovioModule: any }> | null = null;

const loadVerovio = async (): Promise<{ VerovioToolkit: any; VerovioModule: any }> => {
  if (VerovioToolkitClass && VerovioModule) {
    return { VerovioToolkit: VerovioToolkitClass, VerovioModule };
  }
  if (verovioLoadPromise) {
    return verovioLoadPromise;
  }
  if (typeof window === 'undefined') {
    throw new Error('Verovio can only be loaded in browser environment');
  }
  
  verovioLoadPromise = Promise.all([
    import('verovio/wasm') as Promise<any>,
    import('verovio/esm') as Promise<any>
  ]).then(async ([wasmModule, esmModule]) => {
    // WASM 모듈 생성
    const createVerovioModule = wasmModule.default || wasmModule;
    VerovioModule = await createVerovioModule();
    
    // VerovioToolkit 클래스 가져오기
    VerovioToolkitClass = esmModule.VerovioToolkit;
    
    if (!VerovioToolkitClass) {
      throw new Error('VerovioToolkit class not found');
    }
    
    return { VerovioToolkit: VerovioToolkitClass, VerovioModule };
  });
  
  return verovioLoadPromise;
};

interface VerovioRendererProps {
  containerRef: React.RefObject<HTMLDivElement>;
  onNotesRegistered?: (notes: NoteInfo[], timeIndexMap: { [key: number]: number }) => void;
}

export class VerovioRendererImpl implements ScoreRenderer {
  private toolkit: any | null = null;
  private container: HTMLDivElement | null = null;
  private content: string = '';
  private notes: NoteInfo[] = [];
  private timeIndexMap: { [key: number]: number } = {};
  private currentBeat: number = 0;
  private highlightElement: SVGElement | null = null;
  private onNotesRegistered?: (notes: NoteInfo[], timeIndexMap: { [key: number]: number }) => void;
  private initialized: boolean = false;

  constructor(container: HTMLDivElement, onNotesRegistered?: (notes: NoteInfo[], timeIndexMap: { [key: number]: number }) => void) {
    this.container = container;
    this.onNotesRegistered = onNotesRegistered;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized && this.toolkit) {
      return;
    }

    const { VerovioToolkit, VerovioModule: module } = await loadVerovio();
    
    // VerovioToolkit 인스턴스 생성 (VerovioModule을 인자로 전달)
    this.toolkit = new VerovioToolkit(module);
    
    if (!this.toolkit) {
      throw new Error('Failed to create Verovio toolkit instance');
    }
    
    // Verovio 옵션 설정
    const options = {
      scale: 50,
      pageWidth: 2000,
      pageHeight: 3000,
      adjustPageHeight: true,
    };
    this.toolkit.setOptions(options);
    this.initialized = true;
  }

  async load(content: string): Promise<void> {
    await this.ensureInitialized();
    this.content = content;
    
    if (!this.toolkit) {
      throw new Error('Verovio toolkit not initialized');
    }

    // MEI 또는 MusicXML 로드
    const success = this.toolkit.loadData(content);
    if (!success) {
      throw new Error('Failed to load data into Verovio');
    }
  }

  async render(): Promise<void> {
    if (!this.toolkit || !this.container) {
      throw new Error('Verovio toolkit or container not initialized');
    }

    // SVG 렌더링 (첫 페이지)
    const svg = this.toolkit.renderToSVG(1, false);
    this.container.innerHTML = svg;
    
    // 노트 정보 추출
    this.extractNotes();
    
    // 노트 정보 등록 콜백 호출
    if (this.onNotesRegistered) {
      this.onNotesRegistered(this.notes, this.timeIndexMap);
    }
  }

  private extractNotes(): void {
    if (!this.toolkit) return;

    this.notes = [];
    this.timeIndexMap = {};

    try {
      // Verovio의 renderToTimemap을 사용하여 시간 정보 추출
      const timeMap = this.toolkit.renderToTimemap({
        includeMeasures: false,
        includeRests: true
      });
      
      // TimeMapEntry에서 노트 정보 추출
      timeMap.forEach((entry: any) => {
        if (entry.on && entry.on.length > 0) {
          // on 배열에 있는 요소들은 시작하는 노트들
          // 실제 피치 정보는 MEI/MusicXML에서 추출해야 함
          // 여기서는 시간 정보만 저장
          const time = entry.qstamp * 4; // quarter note를 beat로 변환
          
          // 간단한 노트 정보 생성 (실제로는 더 정교한 파싱 필요)
          this.notes.push({
            note: 60, // 기본값, 실제로는 파싱 필요
            time: time,
            length: 0.25, // 기본값
          });
        }
      });
      
      // TimeMap만으로는 충분하지 않으므로 XML 파싱도 수행
      this.parseNotesFromContent();
      
    } catch (error) {
      console.error('Error extracting notes from Verovio timemap:', error);
      // 폴백: XML 직접 파싱
      this.parseNotesFromContent();
    }
  }

  private parseNotesFromContent(): void {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(this.content, 'text/xml');
    
    // MEI 또는 MusicXML에 따라 다른 파싱 로직
    const isMEI = xmlDoc.documentElement.tagName === 'mei' || 
                  xmlDoc.documentElement.tagName === 'meiCorpus' ||
                  xmlDoc.querySelector('meiHead') !== null;
    
    if (isMEI) {
      this.parseMEINotes(xmlDoc);
    } else {
      this.parseMusicXMLNotes(xmlDoc);
    }

    // 중복 제거 및 시간 인덱스 맵 생성
    const uniqueNotes: NoteInfo[] = [];
    const timeIndexMapObj: { [key: number]: number } = {};
    
    this.notes.forEach((note) => {
      if (!timeIndexMapObj.hasOwnProperty(note.time)) {
        uniqueNotes.push(note);
        timeIndexMapObj[note.time] = uniqueNotes.length - 1;
      }
    });

    this.notes = uniqueNotes;
    this.timeIndexMap = timeIndexMapObj;
  }

  private parseMEINotes(xmlDoc: Document): void {
    // MEI 형식의 note 요소 찾기
    const notes = xmlDoc.querySelectorAll('note');
    
    notes.forEach((noteElement) => {
      const pname = noteElement.getAttribute('pname');
      const oct = noteElement.getAttribute('oct');
      const dur = noteElement.getAttribute('dur');
      const tstamp = noteElement.getAttribute('tstamp') || noteElement.getAttribute('tstamp.ges');
      
      if (pname && oct && dur && tstamp) {
        const pitch = this.pnameToMidi(pname, parseInt(oct));
        const duration = this.durToBeats(dur);
        const time = parseFloat(tstamp) * 4; // tstamp를 beat로 변환 (4분음표 기준)
        
        this.notes.push({
          note: pitch,
          time: time,
          length: duration,
        });
      }
    });
  }

  private parseMusicXMLNotes(xmlDoc: Document): void {
    // MusicXML 형식의 note 요소 찾기
    const notes = xmlDoc.querySelectorAll('note');
    let currentTime = 0;
    let currentMeasure = 0;
    
    notes.forEach((noteElement) => {
      const pitchElement = noteElement.querySelector('pitch');
      const restElement = noteElement.querySelector('rest');
      const durationElement = noteElement.querySelector('duration');
      const measureElement = noteElement.closest('measure');
      
      if (measureElement) {
        const measureNum = parseInt(measureElement.getAttribute('number') || '0');
        if (measureNum !== currentMeasure) {
          currentMeasure = measureNum;
          // 시간 계산은 더 정교하게 필요할 수 있음
        }
      }
      
      if (pitchElement && durationElement) {
        const step = pitchElement.querySelector('step')?.textContent;
        const octave = pitchElement.querySelector('octave')?.textContent;
        const alter = pitchElement.querySelector('alter')?.textContent;
        const duration = parseFloat(durationElement.textContent || '0');
        
        if (step && octave) {
          const pitch = this.musicXMLPitchToMidi(step, parseInt(octave), alter ? parseInt(alter) : 0);
          const timeInBeats = currentTime / 4; // duration은 divisions 단위
          
          this.notes.push({
            note: pitch,
            time: timeInBeats,
            length: duration / 4, // 대략적인 변환
          });
          
          currentTime += duration;
        }
      } else if (restElement && durationElement) {
        const duration = parseFloat(durationElement.textContent || '0');
        currentTime += duration;
      }
    });
  }

  private pnameToMidi(pname: string, octave: number): number {
    const pitchMap: { [key: string]: number } = {
      'c': 0, 'd': 2, 'e': 4, 'f': 5, 'g': 7, 'a': 9, 'b': 11
    };
    const basePitch = pitchMap[pname.toLowerCase()] || 0;
    return basePitch + (octave + 1) * 12;
  }

  private musicXMLPitchToMidi(step: string, octave: number, alter: number): number {
    const pitchMap: { [key: string]: number } = {
      'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11
    };
    const basePitch = pitchMap[step.toUpperCase()] || 0;
    return basePitch + alter + (octave + 1) * 12;
  }

  private durToBeats(dur: string): number {
    // MEI dur 속성을 beat로 변환
    const durMap: { [key: string]: number } = {
      'long': 4, 'breve': 2, '1': 1, '2': 0.5, '4': 0.25,
      '8': 0.125, '16': 0.0625, '32': 0.03125
    };
    return durMap[dur] || 0.25;
  }

  getNotes(): NoteInfo[] {
    return this.notes;
  }

  moveToPosition(targetBeat: number): void {
    this.currentBeat = targetBeat;
    this.highlightPosition(targetBeat);
  }

  highlightPosition(beat: number): void {
    if (!this.container) return;

    // 기존 하이라이트 제거
    this.removeHighlight();

    // SVG에서 해당 beat 위치의 요소 찾기 및 하이라이트
    const svg = this.container.querySelector('svg');
    if (!svg) return;

    // Verovio SVG에서 해당 시간의 요소를 찾기
    // Verovio는 요소에 data-id나 다른 속성을 사용할 수 있음
    // 여기서는 간단하게 모든 note 요소에 하이라이트 스타일 적용 시도
    
    // 더 정교한 방법: SVG의 모든 note 요소를 찾아서 시간에 맞는 것만 하이라이트
    // 하지만 Verovio의 SVG 구조에 따라 다를 수 있으므로
    // 일단 간단한 수평선으로 표시
    
    const svgRect = svg.viewBox?.baseVal || { width: 2000, height: 3000 };
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '0');
    rect.setAttribute('y', '50'); // Y 위치는 스크롤 위치에 따라 조정 필요
    rect.setAttribute('width', svgRect.width.toString());
    rect.setAttribute('height', '3');
    rect.setAttribute('fill', '#ff0000');
    rect.setAttribute('opacity', '0.6');
    rect.setAttribute('class', 'verovio-highlight');
    rect.style.pointerEvents = 'none';
    
    svg.appendChild(rect);
    this.highlightElement = rect;
    
    // 스크롤하여 하이라이트 위치로 이동
    const highlightY = 50;
    if (this.container.parentElement) {
      this.container.parentElement.scrollTop = highlightY - 100;
    }
  }

  private removeHighlight(): void {
    if (this.highlightElement) {
      this.highlightElement.remove();
      this.highlightElement = null;
    }
  }

  getCurrentPosition(): number {
    return this.currentBeat;
  }

  reset(): void {
    this.currentBeat = 0;
    if (this.highlightElement) {
      this.highlightElement.remove();
      this.highlightElement = null;
    }
  }

  show(): void {
    // Verovio는 항상 표시되므로 특별한 작업 없음
  }

  hide(): void {
    this.removeHighlight();
  }
}

// React 컴포넌트 래퍼
export const VerovioRenderer: React.FC<VerovioRendererProps> = ({ containerRef, onNotesRegistered }) => {
  const rendererRef = useRef<VerovioRendererImpl | null>(null);

  useEffect(() => {
    if (containerRef.current) {
      rendererRef.current = new VerovioRendererImpl(containerRef.current, onNotesRegistered);
    }
    
    return () => {
      // Cleanup
    };
  }, [containerRef, onNotesRegistered]);

  return null; // 이 컴포넌트는 렌더링하지 않음
};

export default VerovioRenderer;

