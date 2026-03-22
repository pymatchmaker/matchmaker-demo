import React, { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import CustomAudioPlayer, { AudioPlayerRef } from '../../components/AudioPlayer';
import { ScoreRenderer } from '../../utils/scoreRenderer';
import { OSMDRendererImpl } from '../../components/OSMDRenderer';
import { VerovioRendererImpl } from '../../components/VerovioRenderer';

const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

const ScorePage: React.FC = () => {
  const router = useRouter();
  const { file_id } = router.query;

  const vfRef = useRef<HTMLDivElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [inputType, setInputType] = useState<'MIDI' | 'Audio' | ''>('');
  const [audioDevices, setAudioDevices] = useState<Array<{ index: number; name: string }>>([]);
  const [selectedAudioDevice, setSelectedAudioDevice] = useState<string>('');
  const [midiDevices, setMidiDevices] = useState<Array<{ index: number; name: string }>>([]);
  const [selectedMidiDevice, setSelectedMidiDevice] = useState<string>('');
  const [availableMethods, setAvailableMethods] = useState<{ audio: string[]; midi: string[] }>({ audio: [], midi: [] });
  const [selectedMethod, setSelectedMethod] = useState<string>('');
  const scoreRenderer = useRef<ScoreRenderer | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const [isSimulationMode, setIsSimulationMode] = useState(false);
  const [performanceSource, setPerformanceSource] = useState<File | string | null>(null);
  const audioPlayerRef = useRef<AudioPlayerRef>(null);

  useEffect(() => {
    if (!router.isReady || !file_id) return;

    const loadScore = async () => {
      let fileContent: string | null = null;
      let fileName = '';
      let hasPerformance = false;

      // 1) Try sessionStorage first (immediate after upload)
      const cached = sessionStorage.getItem(`score_${file_id}`);
      if (cached) {
        const data = JSON.parse(cached);
        fileContent = data.file_content;
        fileName = data.file_name;
        hasPerformance = data.has_performance_file;
      } else {
        // 2) Fallback: fetch from server (page refresh)
        try {
          const res = await fetch(`${backendUrl}/score/${file_id}`);
          if (!res.ok) {
            setError(res.status === 404 ? 'Score not found' : `Server error (${res.status})`);
            return;
          }
          const data = await res.json();
          fileContent = data.file_content;
          fileName = data.file_name;
          hasPerformance = data.has_performance_file;
        } catch (e) {
          setError('Failed to connect to server');
          return;
        }
      }

      if (!fileContent || !vfRef.current) {
        setError('No score content available');
        return;
      }

      try {
        // Select renderer based on file extension
        const isMei = fileName.toLowerCase().endsWith('.mei');
        if (isMei) {
          scoreRenderer.current = new VerovioRendererImpl(vfRef.current);
        } else {
          scoreRenderer.current = new OSMDRendererImpl(vfRef.current);
        }

        await scoreRenderer.current.load(fileContent);
        await scoreRenderer.current.render();
        scoreRenderer.current.reset();
        scoreRenderer.current.show();

        if (hasPerformance) {
          setIsSimulationMode(true);
          setPerformanceSource(`${backendUrl}/score/${file_id}/performance`);
        }

        setIsLoading(false);
      } catch (e) {
        console.error('Error rendering score:', e);
        setError('Failed to render score');
      }
    };

    loadScore();
  }, [router.isReady, file_id]);

  useEffect(() => {
    if (inputType === 'Audio') {
      fetchAudioDevices();
      fetchMethods();
    } else if (inputType === 'MIDI') {
      fetchMidiDevices();
      fetchMethods();
    }
  }, [inputType]);

  // Update selected method when inputType or available methods change
  useEffect(() => {
    const key = inputType === 'Audio' ? 'audio' : 'midi';
    const methods = availableMethods[key];
    if (methods.length > 0 && !methods.includes(selectedMethod)) {
      setSelectedMethod(methods[0]);
    }
  }, [inputType, availableMethods]);

  const playMusic = async () => {
    if (!scoreRenderer.current || !file_id) return;

    setIsPlaying(true);
    if (performanceSource) audioPlayerRef.current?.play();

    scoreRenderer.current.reset();

    const wsUrl = `${backendUrl.replace(/^http/, 'ws')}/ws`;
    ws.current = new WebSocket(wsUrl);

    ws.current.onopen = () => {
      const input_type = performanceSource
        ? 'audio'
        : (inputType === 'MIDI' ? 'midi' : 'audio');

      ws.current?.send(JSON.stringify({
        file_id,
        input_type,
        device: performanceSource ? '' : (inputType === 'Audio' ? selectedAudioDevice : selectedMidiDevice),
        method: selectedMethod || undefined,
      }));
    };

    ws.current.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.beat_position !== undefined) {
        scoreRenderer.current?.moveToPosition(data.beat_position);
      }
    };

    ws.current.onclose = () => setIsPlaying(false);
    ws.current.onerror = () => setIsPlaying(false);
  };

  const stopMusic = () => {
    scoreRenderer.current?.hide();
    setIsPlaying(false);
    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }
  };

  const fetchAudioDevices = async () => {
    try {
      const res = await fetch(`${backendUrl}/audio-devices`);
      const data = await res.json();
      setAudioDevices(data.devices);
      if (data.devices.length > 0) setSelectedAudioDevice(data.devices[0].name);
    } catch (e) { console.error('Error fetching audio devices:', e); }
  };

  const fetchMidiDevices = async () => {
    try {
      const res = await fetch(`${backendUrl}/midi-devices`);
      const data = await res.json();
      setMidiDevices(data.devices);
      if (data.devices.length > 0) setSelectedMidiDevice(data.devices[0].name);
    } catch (e) { console.error('Error fetching midi devices:', e); }
  };

  const fetchMethods = async () => {
    try {
      const res = await fetch(`${backendUrl}/methods`);
      const data = await res.json();
      setAvailableMethods(data);
    } catch (e) { console.error('Error fetching methods:', e); }
  };

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center">
        <p className="text-red-500 text-lg mb-4">{error}</p>
        <button
          onClick={() => router.push('/')}
          className="px-6 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600"
        >
          Back to Upload
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Head>
        <title>Score Following App</title>
      </Head>

      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-100">
        <a href="/" className="text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors cursor-pointer">Score Following <span className="text-gray-400 font-normal">with Matchmaker</span></a>
        <a
          href="https://github.com/pymatchmaker/matchmaker"
          target="_blank"
          rel="noopener noreferrer"
          className="text-gray-400 hover:text-gray-600 transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
        </a>
      </div>

      <div className="flex-1 pb-32">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <div className="text-gray-500 text-lg">Loading score...</div>
          </div>
        ) : (
          <div className="flex flex-wrap items-end justify-center gap-3 py-3 px-4">
            {/* Input type toggle */}
            {!isSimulationMode && (
              <div>
                <div className="flex rounded-lg overflow-hidden border border-gray-200 h-[34px]">
                  <button
                    onClick={() => setInputType('Audio')}
                    className={`px-4 text-sm font-medium transition-all duration-150
                      ${inputType === 'Audio'
                        ? 'bg-blue-500 text-white'
                        : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  >
                    Audio
                  </button>
                  <button
                    onClick={() => setInputType('MIDI')}
                    className={`px-4 text-sm font-medium transition-all duration-150 border-l border-gray-200
                      ${inputType === 'MIDI'
                        ? 'bg-blue-500 text-white'
                        : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  >
                    MIDI
                  </button>
                </div>
              </div>
            )}

            {/* Device select */}
            {!isSimulationMode && inputType === 'Audio' && (
              <div className="min-w-[200px]">
                <label className="block text-xs text-gray-400 mb-1">Device</label>
                <select
                  value={selectedAudioDevice}
                  onChange={(e) => setSelectedAudioDevice(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg bg-white border border-gray-200
                    focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                >
                  {audioDevices.map((device, index) => (
                    <option key={index} value={device.name}>{device.name}</option>
                  ))}
                </select>
              </div>
            )}

            {!isSimulationMode && inputType === 'MIDI' && (
              <div className="min-w-[200px]">
                <label className="block text-xs text-gray-400 mb-1">Device</label>
                <select
                  value={selectedMidiDevice}
                  onChange={(e) => setSelectedMidiDevice(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg bg-white border border-gray-200
                    focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                >
                  {midiDevices.map((device, index) => (
                    <option key={index} value={device.name}>{device.name}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Algorithm select */}
            {!isSimulationMode && inputType && (
              <div className="min-w-[180px]">
                <label className="block text-xs text-gray-400 mb-1">Alignment algorithm</label>
                <select
                  value={selectedMethod}
                  onChange={(e) => setSelectedMethod(e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg bg-white border border-gray-200
                    focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                >
                  {(availableMethods[inputType === 'Audio' ? 'audio' : 'midi'] || []).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Play / Stop */}
            <div className="flex gap-2">
              <button
                onClick={playMusic}
                disabled={isPlaying}
                className={`flex items-center px-5 py-2 rounded-lg text-sm font-medium transition-all duration-150
                  ${!isPlaying
                    ? 'bg-green-500 text-white hover:bg-green-600 shadow-sm'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}
              >
                ▶ Play
              </button>
              <button
                onClick={stopMusic}
                disabled={!isPlaying}
                className={`flex items-center px-5 py-2 rounded-lg text-sm font-medium transition-all duration-150
                  ${isPlaying
                    ? 'bg-red-500 text-white hover:bg-red-600 shadow-sm'
                    : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}
              >
                ■ Stop
              </button>
            </div>
          </div>
        )}
        <div ref={vfRef} id="osmdContainer"></div>
      </div>

      {performanceSource && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t shadow-lg">
          <CustomAudioPlayer
            ref={audioPlayerRef}
            audioFile={performanceSource}
            isPlaying={isPlaying}
            onPlay={() => { if (!isPlaying) playMusic(); }}
            onPause={() => { if (isPlaying) stopMusic(); }}
            onEnded={stopMusic}
          />
        </div>
      )}
    </div>
  );
};

export default ScorePage;
