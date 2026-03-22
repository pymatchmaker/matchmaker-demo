import React, { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
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
  const [loadingMessage, setLoadingMessage] = useState('Loading score...');
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
  const [performanceInputType, setPerformanceInputType] = useState<'audio' | 'midi'>('audio');
  const [performanceSource, setPerformanceSource] = useState<File | string | null>(null);
  const [alignmentData, setAlignmentData] = useState<Array<{time: number; position: number}> | null>(null);
  const audioPlayerRef = useRef<AudioPlayerRef>(null);
  const animFrameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!router.isReady || !file_id) return;

    const loadScore = async () => {
      let fileContent: string | null = null;
      let fileName = '';
      let hasPerformance = false;
      let perfType: 'audio' | 'midi' = 'audio';

      let alignment: Array<{time: number; position: number}> | null = null;

      // 1) Try sessionStorage first (immediate after upload)
      const cached = sessionStorage.getItem(`score_${file_id}`);
      if (cached) {
        const data = JSON.parse(cached);
        fileContent = data.file_content;
        fileName = data.file_name;
        hasPerformance = data.has_performance_file;
        perfType = data.performance_input_type || 'audio';
        alignment = data.alignment || null;
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

          // Try to fetch precomputed alignment
          try {
            const alignRes = await fetch(`${backendUrl}/score/${file_id}/alignment`);
            if (alignRes.ok) {
              const alignData = await alignRes.json();
              alignment = alignData.alignment;
            }
          } catch { /* no alignment available */ }
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
          setPerformanceInputType(perfType);
          setPerformanceSource(`${backendUrl}/score/${file_id}/performance`);
          if (alignment) setAlignmentData(alignment);
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
    if (isSimulationMode) {
      fetchMethods();
    } else if (inputType === 'Audio') {
      fetchAudioDevices();
      fetchMethods();
    } else if (inputType === 'MIDI') {
      fetchMidiDevices();
      fetchMethods();
    }
  }, [inputType, isSimulationMode]);

  // Update selected method when inputType or available methods change
  useEffect(() => {
    const key = isSimulationMode ? performanceInputType : (inputType === 'Audio' ? 'audio' : 'midi');
    const methods = availableMethods[key];
    if (methods.length > 0 && !methods.includes(selectedMethod)) {
      setSelectedMethod(methods[0]);
    }
  }, [inputType, availableMethods, isSimulationMode, performanceInputType]);

  // Binary search: find last entry where entry.time <= currentTime
  const lookupPosition = (alignment: Array<{time: number; position: number}>, t: number): number => {
    if (!alignment || alignment.length === 0) return 0;
    let lo = 0, hi = alignment.length - 1;
    if (t < alignment[0].time) return alignment[0].position;
    if (t >= alignment[hi].time) return alignment[hi].position;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (alignment[mid].time <= t) lo = mid;
      else hi = mid - 1;
    }
    return alignment[lo].position;
  };

  // Simulation mode: run alignment separately, then play
  const runAlignment = async () => {
    if (!file_id) return;
    setLoadingMessage('Running alignment...');
    setIsLoading(true);
    try {
      const defaultMethod = performanceInputType === 'midi' ? 'outerhmm' : 'audio_outerhmm';
      const method = selectedMethod || defaultMethod;
      const res = await fetch(`${backendUrl}/score/${file_id}/alignment?method=${method}`, { method: 'POST' });
      if (!res.ok) throw new Error('Alignment failed');
      const { alignment } = await res.json();
      setAlignmentData(alignment);
      setIsLoading(false);
    } catch (e) {
      console.error('Alignment error:', e);
      setIsLoading(false);
    }
  };

  const playMusic = async () => {
    if (!scoreRenderer.current || !file_id) return;

    setIsPlaying(true);
    scoreRenderer.current.reset();

    // Simulation mode: play with pre-computed alignment
    if (isSimulationMode && alignmentData) {
      await audioPlayerRef.current?.unlock();
      audioPlayerRef.current?.play();

      const tick = () => {
        const t = audioPlayerRef.current?.getCurrentTime() ?? 0;
        const pos = lookupPosition(alignmentData, t);
        scoreRenderer.current?.moveToPosition(pos);
        animFrameRef.current = requestAnimationFrame(tick);
      };
      animFrameRef.current = requestAnimationFrame(tick);
      return;
    }

    // Live mode: WebSocket
    const wsUrl = `${backendUrl.replace(/^http/, 'ws')}/ws`;
    ws.current = new WebSocket(wsUrl);

    ws.current.onopen = () => {
      const input_type = inputType === 'MIDI' ? 'midi' : 'audio';
      ws.current?.send(JSON.stringify({
        file_id,
        input_type,
        device: inputType === 'Audio' ? selectedAudioDevice : selectedMidiDevice,
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
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
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
        <Link href="/" className="text-sm font-medium text-gray-700 hover:text-gray-900 transition-colors cursor-pointer">Score Following <span className="text-gray-400 font-normal">with Matchmaker</span></Link>
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
            <div className="text-gray-500 text-lg">{loadingMessage}</div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 py-3 px-4">
            {/* Simulation mode controls */}
            {isSimulationMode && (
              <>
                <div className="text-xs text-gray-400 mb-1">
                  Simulation mode — align a recorded performance to the score, then play back with synchronized highlighting.
                </div>
                <div className="flex flex-wrap items-end justify-center gap-3">
                  <div className="min-w-[180px]">
                    <label className="block text-xs text-gray-400 mb-1">Alignment algorithm</label>
                    <select
                      value={selectedMethod}
                      onChange={(e) => { setSelectedMethod(e.target.value); setAlignmentData(null); }}
                      className="w-full px-3 py-2 text-sm rounded-lg bg-white border border-gray-200
                        focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    >
                      {(availableMethods[performanceInputType] || []).map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                  {!alignmentData ? (
                    <button
                      onClick={runAlignment}
                      disabled={isPlaying}
                      className="px-5 py-2 rounded-lg text-sm font-medium bg-blue-500 text-white hover:bg-blue-600 shadow-sm transition-all duration-150"
                    >
                      Run Simulation
                    </button>
                  ) : (
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
                  )}
                </div>
              </>
            )}

            {/* Live mode controls */}
            {!isSimulationMode && (
              <div className="flex flex-wrap items-end justify-center gap-3">
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

                {inputType === 'Audio' && (
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

                {inputType === 'MIDI' && (
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

                {inputType && (
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
