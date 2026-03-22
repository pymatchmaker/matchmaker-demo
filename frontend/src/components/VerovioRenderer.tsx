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
  private cursorLine: SVGElement | null = null;
  private onNotesRegistered?: (notes: NoteInfo[], timeIndexMap: { [key: number]: number }) => void;
  private initialized: boolean = false;
  private beatToXPosition: Map<number, number> = new Map(); // beat -> x position mapping
  private quarterToXPosition: Map<number, number> = new Map(); // quarter_position -> x position mapping

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
    const svgString = this.toolkit.renderToSVG(1, false);
    this.container.innerHTML = svgString;
    
    // SVG 요소는 그대로 유지 (viewBox 변경하지 않음)
    
    // 노트 정보 추출
    this.extractNotes();
    
    // 시간-위치 매핑 생성
    this.buildBeatToPositionMap();
    
    // 노트 정보 등록 콜백 호출
    if (this.onNotesRegistered) {
      this.onNotesRegistered(this.notes, this.timeIndexMap);
    }

    // 테스트: 첫 노트 위치 하이라이트
    this.highlightFirstNote();
  }

  private highlightFirstNote(): void {
    if (!this.container) return;

    const svg = this.container.querySelector('svg');
    if (!svg) {
      console.warn('SVG not found for first note highlight');
      return;
    }

    // SVG 구조 디버깅
    console.log('SVG viewBox:', svg.viewBox?.baseVal);
    console.log('SVG bbox:', svg.getBBox());

    // 모든 staff 요소 찾기 (더 많은 선택자 시도)
    const staffSelectors = [
      'g[class*="staff"]',
      'g[data-id*="staff"]',
      'g[class*="Staff"]',
      'g[class*="system"]',
      'g[class*="System"]',
      '.staff',
      '.system'
    ];

    let staffElements: NodeListOf<Element> | null = null;
    for (const selector of staffSelectors) {
      staffElements = svg.querySelectorAll(selector);
      if (staffElements.length > 0) {
        console.log(`Found ${staffElements.length} staff elements using selector "${selector}"`);
        break;
      }
    }

    // 첫 번째 measure나 시스템 찾기
    let firstMeasure: Element | null = null;
    const measureSelectors = [
      'g[class*="measure"]',
      'g[data-id*="measure"]',
      'g[class*="Measure"]',
      '.measure'
    ];

    for (const selector of measureSelectors) {
      const measures = svg.querySelectorAll(selector);
      if (measures.length > 0) {
        firstMeasure = measures[0];
        console.log(`Found first measure using selector "${selector}"`);
        break;
      }
    }

    // X 위치 찾기
    let xPosition: number | null = null;

    // 방법 1: 첫 번째 measure의 X 위치 사용
    if (firstMeasure && 'getBBox' in firstMeasure) {
      try {
        const bbox = (firstMeasure as SVGGraphicsElement).getBBox();
        xPosition = bbox.x;
        console.log('First measure bbox:', bbox, 'X position:', xPosition);
      } catch (e) {
        console.warn('Error getting first measure bbox:', e);
      }
    }

    // 방법 2: timemap에서 첫 번째 entry 사용
    if (xPosition === null && this.toolkit) {
      try {
        const timeMap = this.toolkit.renderToTimemap({
          includeMeasures: true,
          includeRests: true
        });
        
        if (timeMap && timeMap.length > 0) {
          const firstEntry = timeMap[0];
          console.log('First timemap entry:', firstEntry);
          
          if (firstEntry.on && firstEntry.on.length > 0) {
            const noteId = firstEntry.on[0];
            const noteElement = svg.querySelector(`[data-id="${noteId}"]`) ||
                             svg.querySelector(`#${noteId}`) ||
                             svg.querySelector(`[id="${noteId}"]`);
            
            if (noteElement && 'getBBox' in noteElement) {
              const bbox = (noteElement as SVGGraphicsElement).getBBox();
              xPosition = bbox.x;
              console.log('First note from timemap bbox:', bbox, 'X position:', xPosition);
            }
          }
        }
      } catch (e) {
        console.warn('Error getting timemap for first note:', e);
      }
    }

    // 방법 3: SVG의 왼쪽 가장자리 사용 (fallback)
    if (xPosition === null) {
      const svgRect = svg.viewBox?.baseVal || svg.getBBox();
      xPosition = svgRect.x || 100; // 기본값
      console.log('Using SVG left edge as fallback, X position:', xPosition);
    }

    // 전체 높이 계산 (모든 staff 포함)
    const svgRect = svg.viewBox?.baseVal || svg.getBBox();
    let svgHeight = svgRect.height || 3000;
    let svgY = svgRect.y || 0;
    
    if (staffElements && staffElements.length > 0) {
      let minY = Infinity;
      let maxY = -Infinity;
      
      staffElements.forEach((staff) => {
        if ('getBBox' in staff) {
          try {
            const bbox = (staff as SVGGraphicsElement).getBBox();
            minY = Math.min(minY, bbox.y);
            maxY = Math.max(maxY, bbox.y + bbox.height);
            console.log('Staff bbox:', bbox);
          } catch (e) {
            console.warn('Error getting staff bbox:', e);
          }
        }
      });
      
      if (minY !== Infinity && maxY !== Infinity) {
        svgY = minY;
        svgHeight = maxY - minY;
        console.log('Calculated staff height:', svgHeight, 'Y:', svgY);
      }
    }

    // 수직 사각형 생성 (모든 staff를 포함)
    const cursorRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    const rectWidth = 5; // 테스트용으로 더 넓게
    const rectX = xPosition - rectWidth / 2;
    cursorRect.setAttribute('x', rectX.toString());
    cursorRect.setAttribute('y', svgY.toString());
    cursorRect.setAttribute('width', rectWidth.toString());
    cursorRect.setAttribute('height', svgHeight.toString());
    cursorRect.setAttribute('fill', '#ff0000'); // 빨간색으로 테스트
    cursorRect.setAttribute('opacity', '0.8'); // 더 진하게
    cursorRect.setAttribute('class', 'verovio-cursor-first-note');
    cursorRect.setAttribute('id', 'verovio-first-note-rect'); // 디버깅용 ID
    cursorRect.style.pointerEvents = 'none';
    cursorRect.style.zIndex = '10000';
    
    // SVG에 추가 (가장 마지막에 추가하여 위에 표시)
    svg.appendChild(cursorRect);
    
    // DOM에 실제로 추가되었는지 확인
    const addedRect = svg.querySelector('#verovio-first-note-rect');
    console.log('First note highlight rectangle added:', {
      x: rectX,
      y: svgY,
      width: rectWidth,
      height: svgHeight,
      addedToDOM: !!addedRect,
      svgChildren: svg.children.length
    });
  }

  private buildBeatToPositionMap(): void {
    if (!this.toolkit || !this.container) return;

    this.beatToXPosition.clear();
    this.quarterToXPosition.clear();
    
    try {
      // Verovio의 renderToTimemap을 사용하여 시간 정보 추출
      const timeMap = this.toolkit.renderToTimemap({
        includeMeasures: true,
        includeRests: true
      });
      
      // SVG에서 각 시간에 해당하는 요소의 X 좌표 찾기
      const svg = this.container.querySelector('svg');
      if (!svg) return;
      
      // viewBox 정보 가져오기 (좌표 변환에 필요)
      const viewBox = svg.viewBox?.baseVal;
      
      console.log('Building position map with viewBox:', viewBox ? {
        x: viewBox.x,
        y: viewBox.y,
        width: viewBox.width,
        height: viewBox.height
      } : 'none');
      
      // 첫 번째 entry를 로깅하여 구조 확인
      if (timeMap.length > 0) {
        console.log('Sample timemap entry:', JSON.stringify(timeMap[0], null, 2));
      }
      
      timeMap.forEach((entry: any) => {
        if (entry.qstamp !== undefined) {
          const quarterPosition = entry.qstamp; // qstamp는 quarter note 단위
          const beat = quarterPosition * 4; // beat로 변환 (호환성 유지)
          
          let foundX: number | null = null;
          
          // 해당 시간의 노트 요소 찾기
          if (entry.on && entry.on.length > 0) {
            const noteId = entry.on[0];
            // Verovio SVG에서 요소 찾기 (여러 방법 시도)
            // Verovio는 보통 data-id 속성을 사용하거나, xml:id를 id로 변환
            let noteElement = svg.querySelector(`[data-id="${noteId}"]`) || 
                             svg.querySelector(`#${noteId}`) ||
                             svg.querySelector(`[id="${noteId}"]`);
            
            // SVG 내부의 g 요소나 use 요소도 확인
            if (!noteElement) {
              const allElements = svg.querySelectorAll('*');
              for (const el of allElements) {
                const elId = el.getAttribute('data-id') || el.getAttribute('id') || el.id;
                if (elId === noteId) {
                  noteElement = el;
                  break;
                }
              }
            }
            
            if (noteElement && 'getBBox' in noteElement) {
              try {
                const svgElement = noteElement as SVGGraphicsElement;
                const bbox = svgElement.getBBox();
                foundX = bbox.x;
              } catch (e) {
                // getBBox 실패 시 무시
                console.debug(`Could not get bbox for note ${noteId}:`, e);
              }
            }
          }
          
          // measure 정보도 사용 (더 정확한 위치 추적)
          // Verovio의 timemap entry에는 measure 정보가 포함될 수 있음
          if (foundX === null) {
            const measureId = entry.measureId || entry.m || entry.measure;
            if (measureId) {
              // measure 요소 찾기 (여러 패턴 시도)
              const measureSelectors = [
                `[data-id*="measure-${measureId}"]`,
                `[id*="measure-${measureId}"]`,
                `g[class*="measure-${measureId}"]`,
                `[data-id="${measureId}"]`,
                `#${measureId}`
              ];
              
              for (const selector of measureSelectors) {
                const measureElement = svg.querySelector(selector);
                if (measureElement && 'getBBox' in measureElement) {
                  try {
                    const svgElement = measureElement as SVGGraphicsElement;
                    const bbox = svgElement.getBBox();
                    foundX = bbox.x;
                    break;
                  } catch (e) {
                    console.debug(`Could not get bbox for measure ${measureId} with selector ${selector}:`, e);
                  }
                }
              }
            }
          }
          
          // tstamp를 사용하여 measure 내 위치 계산
          if (foundX === null && entry.tstamp !== undefined) {
            // measure의 시작 위치를 찾고, tstamp를 사용하여 보간
            const measureId = entry.measureId || entry.m || entry.measure;
            if (measureId) {
              const measureElement = svg.querySelector(`[data-id*="measure"], [id*="measure"]`);
              if (measureElement && 'getBBox' in measureElement) {
                try {
                  const svgElement = measureElement as SVGGraphicsElement;
                  const bbox = svgElement.getBBox();
                  foundX = bbox.x;
                } catch (e) {
                  console.debug(`Could not get bbox for measure:`, e);
                }
              }
            }
          }
          
          // 찾은 X 위치를 매핑에 저장 (viewBox 좌표계로 변환)
          if (foundX !== null) {
            // 절대 좌표를 viewBox 좌표계로 변환
            let viewBoxX = foundX;
            if (viewBox && viewBox.width > 0) {
              // 절대 좌표를 viewBox 좌표계로 변환
              if (foundX >= viewBox.x) {
                viewBoxX = foundX - viewBox.x;
              } else {
                // foundX가 viewBox.x보다 작으면 이미 viewBox 좌표계일 수 있음
                // 하지만 foundX가 viewBox.width보다 크면 절대 좌표
                if (foundX > viewBox.width) {
                  // 절대 좌표로 간주하고 변환
                  viewBoxX = foundX - viewBox.x;
                } else {
                  // 이미 viewBox 좌표계
                  viewBoxX = foundX;
                }
              }
              
              // viewBox 내부에 있는지 확인하고 제한
              if (viewBoxX < 0) viewBoxX = 0;
              if (viewBoxX > viewBox.width) {
                // viewBox 밖이면 스킵하거나 viewBox 내부로 제한
                console.debug(`X position ${viewBoxX} is outside viewBox width ${viewBox.width}, limiting to ${viewBox.width}`);
                viewBoxX = viewBox.width - 1; // 최소한의 너비를 위해
              }
              
              this.quarterToXPosition.set(quarterPosition, viewBoxX);
              this.beatToXPosition.set(beat, viewBoxX);
            } else {
              // viewBox가 없으면 절대 좌표 사용
              this.quarterToXPosition.set(quarterPosition, foundX);
              this.beatToXPosition.set(beat, foundX);
            }
          }
        }
      });
      
      // 노트가 없는 경우, SVG의 measure 요소를 사용하여 대략적인 위치 계산
      if (this.quarterToXPosition.size === 0) {
        const measures = svg.querySelectorAll('[data-id*="measure"], g[class*="measure"], g[data-id]');
        measures.forEach((measure, index) => {
          if ('getBBox' in measure) {
            try {
              const svgElement = measure as SVGGraphicsElement;
              const bbox = svgElement.getBBox();
              const quarterPos = index * 4; // 각 measure를 4 quarter로 가정
              const beat = quarterPos * 4;
              
              // viewBox 좌표계로 변환
              let viewBoxX = bbox.x;
              if (viewBox && viewBox.width > 0) {
                // 절대 좌표를 viewBox 좌표계로 변환
                if (bbox.x >= viewBox.x) {
                  viewBoxX = bbox.x - viewBox.x;
                } else if (bbox.x > viewBox.width) {
                  // bbox.x가 viewBox.width보다 크면 절대 좌표
                  viewBoxX = bbox.x - viewBox.x;
                } else {
                  // 이미 viewBox 좌표계
                  viewBoxX = bbox.x;
                }
                
                // viewBox 내부로 제한
                if (viewBoxX < 0) viewBoxX = 0;
                if (viewBoxX > viewBox.width) {
                  viewBoxX = viewBox.width - 1;
                }
                
                this.quarterToXPosition.set(quarterPos, viewBoxX);
                this.beatToXPosition.set(beat, viewBoxX);
              } else {
                this.quarterToXPosition.set(quarterPos, bbox.x);
                this.beatToXPosition.set(beat, bbox.x);
              }
            } catch (e) {
              console.debug(`Could not get bbox for measure ${index}:`, e);
            }
          }
        });
      }
      
      console.log(`Built position map: ${this.quarterToXPosition.size} quarter positions`);
      if (this.quarterToXPosition.size > 0) {
        const sampleEntries = Array.from(this.quarterToXPosition.entries()).slice(0, 5);
        console.log('Sample position mappings:', sampleEntries);
      }
      
      console.log(`Built position map: ${this.quarterToXPosition.size} quarter positions, ${this.beatToXPosition.size} beat positions`);
      
      // 디버깅: 첫 몇 개의 매핑 출력
      if (this.quarterToXPosition.size > 0) {
        const sampleQuarters = Array.from(this.quarterToXPosition.entries()).slice(0, 5);
        console.log('Sample quarter position mappings:', sampleQuarters);
      }
      
    } catch (error) {
      console.error('Error building beat to position map:', error);
    }
  }

  private getXPositionForBeat(beat: number): number | null {
    // 정확한 beat 위치 찾기
    if (this.beatToXPosition.has(beat)) {
      return this.beatToXPosition.get(beat)!;
    }
    
    // 가장 가까운 beat 위치 찾기
    const beats = Array.from(this.beatToXPosition.keys()).sort((a, b) => a - b);
    const closestBeat = beats.findLast((b) => b <= beat) || beats[0];
    
    if (closestBeat !== undefined && this.beatToXPosition.has(closestBeat)) {
      return this.beatToXPosition.get(closestBeat)!;
    }
    
    return null;
  }

  private getXPositionForQuarter(quarterPosition: number): number | null {
    // 정확한 quarter 위치 찾기
    if (this.quarterToXPosition.has(quarterPosition)) {
      return this.quarterToXPosition.get(quarterPosition)!;
    }
    
    // 가장 가까운 quarter 위치 찾기
    const quarters = Array.from(this.quarterToXPosition.keys()).sort((a, b) => a - b);
    const closestQuarter = quarters.findLast((q) => q <= quarterPosition) || quarters[0];
    
    if (closestQuarter !== undefined && this.quarterToXPosition.has(closestQuarter)) {
      const baseX = this.quarterToXPosition.get(closestQuarter)!;
      
      // 다음 quarter 위치를 찾아서 보간
      const nextQuarter = quarters.find((q) => q > quarterPosition);
      if (nextQuarter !== undefined && this.quarterToXPosition.has(nextQuarter)) {
        const nextX = this.quarterToXPosition.get(nextQuarter)!;
        const ratio = (quarterPosition - closestQuarter) / (nextQuarter - closestQuarter);
        return baseX + (nextX - baseX) * ratio;
      }
      
      return baseX;
    }
    
    return null;
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
    // targetBeat가 실제로는 quarter_position일 수 있으므로 둘 다 시도
    this.highlightPosition(targetBeat);
  }

  highlightPosition(beat: number): void {
    if (!this.container) return;

    // 기존 cursor 제거
    this.removeCursor();

    // SVG 요소 가져오기
    const svg = this.container.querySelector('svg');
    if (!svg) {
      console.warn('SVG not found');
      return;
    }

    // 서버에서 보내는 값은 quarter_position이지만, JSON 키는 "beat_position"
    // Verovio의 qstamp는 quarter note 단위이므로, 받은 값을 quarter_position으로 처리
    let xPosition: number | null = null;
    
    // quarter_position으로 직접 매핑 시도 (서버에서 보내는 값이 quarter_position이므로)
    if (this.quarterToXPosition.size > 0) {
      xPosition = this.getXPositionForQuarter(beat);
      if (xPosition !== null) {
        console.log(`Found X position for quarter_position ${beat}: ${xPosition}`);
      }
    }
    
    // 실패하면 beat로 시도 (호환성 유지)
    if (xPosition === null) {
      xPosition = this.getXPositionForBeat(beat);
      if (xPosition !== null) {
        console.log(`Found X position for beat ${beat}: ${xPosition}`);
      }
    }
    
    // X 위치를 찾지 못한 경우 첫 번째 노트 위치 사용 (fallback)
    if (xPosition === null) {
      console.warn(`Could not find X position for beat/quarter: ${beat}, using first note as fallback`);
      
      // timemap에서 첫 번째 노트 위치 사용
      if (this.toolkit) {
        try {
          const timeMap = this.toolkit.renderToTimemap({
            includeMeasures: true,
            includeRests: true
          });
          
          if (timeMap && timeMap.length > 0) {
            const firstEntry = timeMap[0];
            if (firstEntry.on && firstEntry.on.length > 0) {
              const noteId = firstEntry.on[0];
              const noteElement = svg.querySelector(`[data-id="${noteId}"]`) ||
                               svg.querySelector(`#${noteId}`) ||
                               svg.querySelector(`[id="${noteId}"]`);
              
              if (noteElement && 'getBBox' in noteElement) {
                const bbox = (noteElement as SVGGraphicsElement).getBBox();
                xPosition = bbox.x;
                console.log('Using first note from timemap as fallback:', bbox);
              }
            }
          }
        } catch (e) {
          console.warn('Error getting timemap:', e);
        }
      }
      
      // 여전히 찾지 못한 경우 viewBox 사용
      if (xPosition === null) {
        const viewBox = svg.viewBox?.baseVal;
        if (viewBox && viewBox.width > 0) {
          xPosition = 0; // viewBox 좌표계
        } else {
          const svgBBox = svg.getBBox();
          xPosition = svgBBox.x;
        }
      }
    }

    // Y 위치와 높이 계산 (모든 staff 포함)
    const viewBox = svg.viewBox?.baseVal;
    const svgBBox = svg.getBBox();
    let yPosition: number = 0;
    let rectHeight: number = 0;
    const rectWidth = 4; // 사각형 너비

    // 모든 staff 요소를 찾아서 전체 높이 계산
    const staffElements = svg.querySelectorAll('g[class*="staff"], g[data-id*="staff"]');
    if (staffElements.length > 0) {
      let minY = Infinity;
      let maxY = -Infinity;
      
      staffElements.forEach((staff) => {
        if ('getBBox' in staff) {
          try {
            const bbox = (staff as SVGGraphicsElement).getBBox();
            minY = Math.min(minY, bbox.y);
            maxY = Math.max(maxY, bbox.y + bbox.height);
          } catch (e) {
            // getBBox 실패 시 무시
          }
        }
      });
      
      if (minY !== Infinity && maxY !== -Infinity) {
        yPosition = minY;
        rectHeight = maxY - minY;
      }
    }
    
    // staff를 찾지 못한 경우 viewBox 또는 bbox 사용
    if (rectHeight === 0) {
      if (viewBox && viewBox.height > 0) {
        yPosition = 0; // viewBox 좌표계
        rectHeight = viewBox.height;
      } else {
        yPosition = svgBBox.y;
        rectHeight = svgBBox.height > 0 ? svgBBox.height : 0;
      }
    }
    
    if (rectHeight > 0) {
      console.log('Adjusted height using staff elements:', { yPosition, rectHeight });
    }

    // 절대 좌표를 viewBox 좌표계로 변환
    // viewBox가 있으면, SVG 내부 요소는 viewBox 좌표계를 사용
    let finalX = xPosition;
    let finalY = yPosition;
    
    if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
      // X 좌표 변환: 절대 좌표를 viewBox 좌표계로
      // xPosition이 viewBox.width보다 크면 절대 좌표로 간주
      if (xPosition > viewBox.width) {
        // 절대 좌표를 viewBox 좌표계로 변환
        if (xPosition >= viewBox.x) {
          finalX = xPosition - viewBox.x;
        } else {
          // xPosition이 viewBox.x보다 작으면 이미 변환된 좌표일 수 있음
          finalX = xPosition;
        }
      } else {
        // xPosition이 viewBox.width보다 작거나 같으면 이미 viewBox 좌표계
        finalX = xPosition;
      }
      
      // Y 좌표 변환: 절대 좌표를 viewBox 좌표계로
      // yPosition이 viewBox.height보다 크면 절대 좌표로 간주
      if (yPosition > viewBox.height) {
        if (yPosition >= viewBox.y) {
          finalY = yPosition - viewBox.y;
        } else {
          finalY = yPosition;
        }
      } else {
        finalY = yPosition;
      }
      
      // 높이는 viewBox 높이로 제한
      if (rectHeight > viewBox.height) {
        rectHeight = viewBox.height;
      }
      
      // 최종 좌표가 viewBox 범위 내에 있는지 확인하고 제한
      if (finalX < 0) finalX = 0;
      if (finalX + rectWidth > viewBox.width) {
        finalX = Math.max(0, viewBox.width - rectWidth);
      }
      if (finalY < 0) finalY = 0;
      if (finalY + rectHeight > viewBox.height) {
        rectHeight = viewBox.height - finalY;
      }
      
      console.log('Final coordinates (viewBox):', {
        original: { x: xPosition, y: yPosition, height: rectHeight },
        final: { x: finalX, y: finalY, height: rectHeight },
        viewBox: `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`,
        inViewBox: finalX >= 0 && finalX + rectWidth <= viewBox.width && finalY >= 0 && finalY + rectHeight <= viewBox.height
      });
    }

    console.log('Drawing rectangle:', {
      x: finalX,
      y: finalY,
      width: rectWidth,
      height: rectHeight,
      viewBox: viewBox ? `${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}` : 'none',
      originalX: xPosition,
      originalY: yPosition
    });

    // 수직 사각형 생성
    const cursorRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    cursorRect.setAttribute('x', finalX.toString());
    cursorRect.setAttribute('y', finalY.toString());
    cursorRect.setAttribute('width', rectWidth.toString());
    cursorRect.setAttribute('height', rectHeight.toString());
    cursorRect.setAttribute('fill', '#ff0000'); // 빨간색
    cursorRect.setAttribute('stroke', '#000000'); // 검은색 테두리
    cursorRect.setAttribute('stroke-width', '3');
    cursorRect.setAttribute('opacity', '1'); // 완전 불투명
    cursorRect.setAttribute('class', 'verovio-cursor');
    cursorRect.setAttribute('id', 'verovio-cursor-rect');
    cursorRect.setAttribute('style', 'pointer-events: none;');
    
    // SVG의 맨 마지막에 추가 (다른 모든 요소 위에 표시)
    svg.appendChild(cursorRect);
    this.cursorLine = cursorRect;
    
    // DOM에 실제로 추가되었는지 확인
    const addedRect = svg.querySelector('#verovio-cursor-rect');
    let rectBBox = null;
    let rectComputedStyle = null;
    try {
      rectBBox = cursorRect.getBBox();
      rectComputedStyle = window.getComputedStyle(cursorRect);
    } catch (e) {
      console.warn('Could not get rect info:', e);
    }
    
    console.log('Rectangle added:', {
      addedToDOM: !!addedRect,
      rectBBox: rectBBox,
      computedStyle: {
        display: rectComputedStyle?.display,
        visibility: rectComputedStyle?.visibility,
        opacity: rectComputedStyle?.opacity,
        fill: rectComputedStyle?.fill
      },
      rectElement: cursorRect,
      parentElement: cursorRect.parentElement,
      svgChildren: svg.children.length
    });
    
    // 강제로 다시 그리기 시도
    cursorRect.setAttribute('fill', '#ff0000');
  }

  private removeCursor(): void {
    if (this.cursorLine) {
      this.cursorLine.remove();
      this.cursorLine = null;
    }
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
    this.removeCursor();
  }

  show(): void {
    // cursor가 이미 표시되어 있으면 유지
    if (this.currentBeat > 0) {
      this.highlightPosition(this.currentBeat);
    }
  }

  hide(): void {
    this.removeCursor();
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

