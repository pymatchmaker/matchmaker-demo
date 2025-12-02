import React, { useState, useRef, useEffect } from 'react';
import Head from 'next/head';
import FileUpload from '../components/FileUpload';
import CustomAudioPlayer from '../components/AudioPlayer';
import { AudioPlayerRef } from '../components/AudioPlayer';
import { ScoreRenderer, detectScoreFormat, detectScoreFormatFromContent, ScoreFormat } from '../utils/scoreRenderer';
import { OSMDRendererImpl } from '../components/OSMDRenderer';
import { VerovioRendererImpl } from '../components/VerovioRenderer';

const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

interface FileUploadData {
  file_id: string;
  file_content: string;
  hasPerformanceFile: boolean;
  fileName?: string;
  onset_beats?: number[];
}

const IndexPage: React.FC = () => {
  const vfRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFileUploaded, setIsFileUploaded] = useState(false);
  const [anchorPositionIndex, setAnchorPositionIndex] = useState<number>(0);
  const [realTimePosition, setRealTimePosition] = useState<number>(0);
  const [inputType, setInputType] = useState<'MIDI' | 'Audio' | ''>('');
  const [audioDevices, setAudioDevices] = useState<Array<{ index: number; name: string }>>([]);
  const [selectedAudioDevice, setSelectedAudioDevice] = useState<string>('');
  const [midiDevices, setMidiDevices] = useState<Array<{ index: number; name: string }>>([]);
  const [selectedMidiDevice, setSelectedMidiDevice] = useState<string>('');
  const scoreRenderer = useRef<ScoreRenderer | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const onsetBeats = useRef<number[] | null>([]);
  const fileId = useRef<string | null>(null);
  const uniqueNotesWRest = useRef<any[]>([]);
  const timeIndexMap = useRef<{ [key: number]: number }>({}); // timeIndexMap: { time: index }
  const [isSimulationMode, setIsSimulationMode] = useState(false);
  const [performanceFile, setPerformanceFile] = useState<File | null>(null);
  const audioPlayerRef = useRef<AudioPlayerRef>(null);
  const scoreContainerRef = useRef<HTMLDivElement>(null);
  const [scoreFormat, setScoreFormat] = useState<ScoreFormat>('unknown');

  useEffect(() => {
    if (inputType === 'Audio') {
      fetchAudioDevices();
    }
    else if (inputType === 'MIDI') {
      fetchMidiDevices();
    }
  }, [inputType]);

  useEffect(() => {
    console.log(`Real-time position: ${realTimePosition}, Anchor position index: ${anchorPositionIndex}`);
    if (realTimePosition !== anchorPositionIndex) {
      moveToTargetBeat(realTimePosition);
      console.log("realTimePosition: ", realTimePosition);
      setAnchorPositionIndex(realTimePosition);
      console.log('Best position updated to:', anchorPositionIndex);
    }
  }, [realTimePosition]);

  // 렌더러 초기화는 파일 업로드 시점에 수행


  const logWithTimestamp = (message: string) => {
    const now = new Date();
    const timestamp = now.toISOString();
    console.log(`[${timestamp}] ${message}`);
  };

  const registerNotesFromRenderer = (notes: any[], timeIndexMapObj: { [key: number]: number }) => {
    uniqueNotesWRest.current = notes;
    timeIndexMap.current = timeIndexMapObj;
  };

  const onFileUpload = async (data: { 
    file_id: string; 
    file_content: string;
    hasPerformanceFile: boolean;
    performanceFile?: File;
    fileName?: string;
  }) => {
    fileId.current = data.file_id;
    if (data.performanceFile && data.performanceFile instanceof File) {
      console.log('Performance file received:', data.performanceFile);
      setPerformanceFile(data.performanceFile);
    }
    try {
      console.log('Performance file exists:', data.hasPerformanceFile);
      setIsSimulationMode(data.hasPerformanceFile);
      
      // onset_beats는 서버에서 제공되지 않을 수 있으므로 옵셔널로 처리
      // onsetBeats.current = data.onset_beats || [];

      if (!vfRef.current) {
        console.error('Container ref not available');
        return;
      }

      // 파일 형식 감지
      let format: ScoreFormat = 'unknown';
      if (data.fileName) {
        format = detectScoreFormat(data.fileName);
      }
      if (format === 'unknown') {
        format = detectScoreFormatFromContent(data.file_content);
      }
      setScoreFormat(format);

      console.log('Detected score format:', format);

      // 형식에 따라 적절한 렌더러 선택
      if (format === 'mei') {
        scoreRenderer.current = new VerovioRendererImpl(
          vfRef.current,
          registerNotesFromRenderer
        );
      } else {
        // MusicXML 또는 기본값은 OSMD 사용
        scoreRenderer.current = new OSMDRendererImpl(
          vfRef.current,
          registerNotesFromRenderer
        );
      }

      // 파일 로드 및 렌더링
      await scoreRenderer.current.load(data.file_content);
      await scoreRenderer.current.render();

      // 초기화
      scoreRenderer.current.reset();
      scoreRenderer.current.show();
      
      setIsFileUploaded(true);
    } catch (error) {
      console.error('Error in onFileUpload:', error);
    }
  };

  const playMusic = async () => {
    if (!scoreRenderer.current || !fileId.current) return;
    
    setIsPlaying(true);
    if (performanceFile) {
      audioPlayerRef.current?.play();
    }

    console.log('Starting music playback...');
    scoreRenderer.current.reset();

    const wsUrl = `${backendUrl.replace(/^http/, 'ws')}/ws`;
    ws.current = new WebSocket(wsUrl);

    ws.current.onopen = () => {
      console.log('WebSocket connection opened');
      const input_type = performanceFile 
        ? (performanceFile.type.includes('midi') ? 'midi' : 'audio')
        : (inputType === 'MIDI' ? 'midi' : 'audio');
      
      ws.current?.send(JSON.stringify({ 
        file_id: fileId.current,
        input_type: input_type,
        device: performanceFile ? '' : (inputType === 'Audio' ? selectedAudioDevice : selectedMidiDevice),
      }));
    };

    ws.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      console.log('WebSocket message received:', data);
      
      if (data.beat_position !== undefined) {
        moveToTargetBeat(data.beat_position);
      }
    };

    ws.current.onclose = () => {
      console.log('WebSocket connection closed');
      setIsPlaying(false);
    };

    ws.current.onerror = (error) => {
      console.error('WebSocket error:', error);
      setIsPlaying(false);
    };
  };

  const findClosestIndex = (array: number[], target: number) => {
    let closestIndex = array.findLastIndex((value) => value <= target);
    if (closestIndex === -1) {
      closestIndex = 0;
    }
    return closestIndex;
  };

  const moveToTargetBeat = (targetBeat: number) => {
    logWithTimestamp(`Moving to target beat: ${targetBeat}`);
    if (!scoreRenderer.current) return;
    
    scoreRenderer.current.moveToPosition(targetBeat);
  };

  const stopMusic = () => {
    console.log('Stopping music');
    if (scoreRenderer.current) {
      scoreRenderer.current.hide();
    }
    setIsPlaying(false);
    if (ws.current) {
      ws.current.close();
      ws.current = null;
      console.log('WebSocket connection closed');
    }
  };

  const fetchAudioDevices = async () => {
    try {
      const response = await fetch(`${backendUrl}/audio-devices`);
      const data = await response.json();
      setAudioDevices(data.devices);
      if (data.devices.length > 0) {
        setSelectedAudioDevice(data.devices[0].name);
      }
    } catch (error) {
      console.error('Error fetching audio devices:', error);
    }
  };

  const fetchMidiDevices = async () => {
    try {
      const response = await fetch(`${backendUrl}/midi-devices`);
      const data = await response.json();
      setMidiDevices(data.devices);
      if (data.devices.length > 0) {
        setSelectedMidiDevice(data.devices[0].name);
      }
    } catch (error) {
      console.error('Error fetching midi devices:', error);
    }
  };
  

  return (
    <div className="min-h-screen flex flex-col">
      <Head>
        <title>Score Following App</title>
      </Head>

      <div className={`text-center ${isFileUploaded ? 'mt-8 mb-4' : 'mt-24 -mb-8'}`}>
        <h1 className="text-4xl font-bold mb-1">Score Following App</h1>
        <h2 className="text-2xl text-gray-600 mb-2">with Matchmaker</h2>
        <a 
          href="https://github.com/pymatchmaker/matchmaker" 
          target="_blank" 
          rel="noopener noreferrer"
          className="text-blue-800 hover:text-blue-900 text-sm inline-flex items-center relative z-10"
        >
          <svg className="w-4 h-4 mr-1" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
          View on GitHub
        </a>
      </div>

      <div className="flex-1 pb-32">
        {!isFileUploaded && (
          <div className="max-w-2xl mx-auto pt-16 px-8">
            <FileUpload backendUrl={backendUrl} onFileUpload={onFileUpload} />
          </div>
        )}
        {isFileUploaded && (
          <div className="flex flex-col items-center space-y-3 py-2">
            {!isSimulationMode && (
              <div className="flex space-x-4">
                <button
                  onClick={() => setInputType('Audio')}
                  className={`px-6 py-2 rounded-full font-medium transition-all duration-200
                    ${inputType === 'Audio'
                      ? 'bg-blue-500 text-white shadow-md scale-105'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >
                  🎤 Audio
                </button>
                <button
                  onClick={() => setInputType('MIDI')}
                  className={`px-6 py-2 rounded-full font-medium transition-all duration-200
                    ${inputType === 'MIDI'
                      ? 'bg-blue-500 text-white shadow-md scale-105'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
                >
                  🎹 MIDI
                </button>
              </div>
            )}

            {!isSimulationMode && inputType === 'Audio' && (
              <div className="w-64">
                <select
                  value={selectedAudioDevice}
                  onChange={(e) => setSelectedAudioDevice(e.target.value)}
                  className="w-full px-4 py-2 rounded-md bg-white border border-gray-200 
                    shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500
                    transition-all duration-200"
                >
                  {audioDevices.map((device, index) => (
                    <option key={index} value={device.name}>
                      {device.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {!isSimulationMode && inputType === 'MIDI' && (
              <div className="w-64">
                <select
                  value={selectedMidiDevice}
                  onChange={(e) => setSelectedMidiDevice(e.target.value)}
                  className="w-full px-4 py-2 rounded-md bg-white border border-gray-200 
                    shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500
                    transition-all duration-200"
                >
                  {midiDevices.map((device, index) => (
                    <option key={index} value={device.name}>
                      {device.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex space-x-4">
              <button
                onClick={playMusic}
                disabled={isPlaying}
                className={`flex items-center px-6 py-2 rounded-full font-medium transition-all duration-200
                  ${!isPlaying
                    ? 'bg-green-500 text-white hover:bg-green-600 shadow-md'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}
              >
                <span className="mr-2">▶️</span> Play
              </button>
              <button
                onClick={stopMusic}
                disabled={!isPlaying}
                className={`flex items-center px-6 py-2 rounded-full font-medium transition-all duration-200
                  ${isPlaying
                    ? 'bg-red-500 text-white hover:bg-red-600 shadow-md'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}
              >
                <span className="mr-2">⏹️</span> Stop
              </button>
            </div>
          </div>
        )}
        <div ref={vfRef} id="osmdContainer"></div>
      </div>

      {performanceFile && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-lg">
          <CustomAudioPlayer 
            ref={audioPlayerRef}
            audioFile={performanceFile}
            isPlaying={isPlaying}
            onPlay={() => {
              if (!isPlaying) playMusic();
            }}
            onPause={() => {
              if (isPlaying) stopMusic();
            }}
            onEnded={stopMusic}
          />
        </div>
      )}
    </div>
  );
};

export default IndexPage;