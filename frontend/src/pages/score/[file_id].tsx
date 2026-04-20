import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Head from 'next/head';
import CustomAudioPlayer, { AudioPlayerRef } from '../../components/AudioPlayer';
import { ScoreRenderer } from '../../utils/scoreRenderer';
import { OSMDRendererImpl } from '../../components/OSMDRenderer';
import { VerovioRendererImpl } from '../../components/VerovioRenderer';
import { ImageRendererImpl } from '../../components/ImageRenderer';

const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

const ScorePage: React.FC = () => {
  const router = useRouter();
  const { file_id } = router.query;

  const vfRef = useRef<HTMLDivElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState('Loading score...');
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [inputType, setInputType] = useState<'audio' | 'midi' | ''>('');
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
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const levelAnimRef = useRef<number | null>(null);
  const [browserAudioStatus, setBrowserAudioStatus] = useState<'idle' | 'connecting' | 'listening' | 'initializing' | 'countdown' | 'active'>('idle');
  const backendReadyRef = useRef(false);
  const [countdownNumber, setCountdownNumber] = useState(0);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sendingRef = useRef(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const midiAccessRef = useRef<MIDIAccess | null>(null);
  const midiInputRef = useRef<MIDIInput | null>(null);
  const [midiInputs, setMidiInputs] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedMidiInput, setSelectedMidiInput] = useState<string>('');
  const [midiMessageCount, setMidiMessageCount] = useState(0);
  const midiStartTimeRef = useRef<number>(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showNotePointer, setShowNotePointer] = useState(false);
  const [showMeasurePointer, setShowMeasurePointer] = useState(true);
  const settingsRef = useRef<HTMLDivElement>(null);

  // Close settings popup on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setShowSettings(false);
      }
    };
    if (showSettings) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSettings]);

  // Use refs so the latest values are always available in callbacks
  const showNotePointerRef = useRef(showNotePointer);
  const showMeasurePointerRef = useRef(showMeasurePointer);
  useEffect(() => { showNotePointerRef.current = showNotePointer; }, [showNotePointer]);
  useEffect(() => { showMeasurePointerRef.current = showMeasurePointer; }, [showMeasurePointer]);

  // Apply cursor visibility after each render or setting change
  const applyCursorVisibility = useCallback(() => {
    if (!vfRef.current) return;
    const container = vfRef.current;
    const noteOn = showNotePointerRef.current;
    const measureOn = showMeasurePointerRef.current;
    const children = container.children;
    for (let i = 0; i < children.length; i++) {
      const el = children[i] as HTMLElement;
      if (!el.style) continue;
      const bg = el.style.backgroundColor || '';
      // ImageRenderer: green = note pointer, blue = measure highlight
      if (bg.includes('51, 204, 51')) el.style.display = noteOn ? 'block' : 'none';
      if (bg.includes('59, 130, 246')) el.style.display = measureOn ? 'block' : 'none';
    }
    // OSMD: cursor elements are <img> with data:image src
    const imgs = container.querySelectorAll('img[src^="data:image"]');
    imgs.forEach((img, idx) => {
      if (idx === 0) (img as HTMLElement).style.display = noteOn ? 'block' : 'none';
      if (idx === 1) (img as HTMLElement).style.display = measureOn ? 'block' : 'none';
    });
  }, []);

  useEffect(() => { applyCursorVisibility(); }, [showNotePointer, showMeasurePointer, applyCursorVisibility]);

  const playTick = useCallback(() => {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 1000;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.08);
      osc.onended = () => ctx.close();
    } catch { /* ignore audio errors */ }
  }, []);

  const startCountdown = useCallback(() => {
    setBrowserAudioStatus('countdown');
    let remaining = 4;
    setCountdownNumber(remaining);
    playTick();

    countdownTimerRef.current = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        if (countdownTimerRef.current) clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
        setCountdownNumber(0);
        sendingRef.current = true;
        setBrowserAudioStatus('active');
      } else {
        setCountdownNumber(remaining);
        playTick();
      }
    }, 1000);
  }, [playTick]);

  const cleanupCountdown = useCallback(() => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdownNumber(0);
  }, []);

  useEffect(() => {
    if (!router.isReady || !file_id) return;

    const loadScore = async () => {
      let fileContent: string | null = null;
      let fileName = '';
      let hasPerformance = false;
      let perfType: 'audio' | 'midi' = 'audio';

      let alignment: Array<{time: number; position: number}> | null = null;
      let isPdf = false;
      let pixelMapping: any = null;

      // 1) Try sessionStorage for metadata (immediate after upload)
      const cached = sessionStorage.getItem(`score_${file_id}`);
      if (cached) {
        const data = JSON.parse(cached);
        fileContent = data.file_content || null;
        fileName = data.file_name;
        hasPerformance = data.has_performance_file;
        perfType = data.performance_input_type || 'audio';
        alignment = data.alignment || null;
        isPdf = data.is_pdf || false;
        pixelMapping = data.pixel_mapping || null;
      }

      // 2) Fetch from server if we don't have file_content (or no cache at all)
      if (!fileContent && !isPdf) {
        try {
          const res = await fetch(`${backendUrl}/score/${file_id}`);
          if (!res.ok) {
            setError(res.status === 404 ? 'Score not found' : `Server error (${res.status})`);
            return;
          }
          const data = await res.json();
          fileContent = data.file_content;
          fileName = fileName || data.file_name;
          hasPerformance = hasPerformance || data.has_performance_file;
          isPdf = data.is_pdf || false;
        } catch (e) {
          setError('Failed to connect to server');
          return;
        }
      }

      // 3) Fetch pixel mapping and alignment if needed
      if (isPdf && !pixelMapping) {
        try {
          const pmRes = await fetch(`${backendUrl}/score/${file_id}/pixel-mapping`);
          if (pmRes.ok) pixelMapping = await pmRes.json();
        } catch { /* no pixel mapping */ }
      }
      // alignment is only fetched on-demand via POST (Run button)

      if (!vfRef.current) {
        setError('Container not available');
        return;
      }

      try {
        // Select renderer
        if (isPdf && pixelMapping) {
          const imageUrl = `${backendUrl}/score/${file_id}/image`;
          scoreRenderer.current = new ImageRendererImpl(vfRef.current, imageUrl, pixelMapping);
        } else if (!fileContent) {
          setError('No score content available');
          return;
        } else if (fileName.toLowerCase().endsWith('.mei')) {
          scoreRenderer.current = new VerovioRendererImpl(vfRef.current);
        } else {
          scoreRenderer.current = new OSMDRendererImpl(vfRef.current);
        }

        await scoreRenderer.current.load(fileContent || '');
        await scoreRenderer.current.render();
        scoreRenderer.current.reset();
        scoreRenderer.current.show();

        // Apply initial cursor visibility from settings
        applyCursorVisibility();

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
    if (isSimulationMode || inputType) {
      fetchMethods();
    }
  }, [inputType, isSimulationMode]);

  // Update selected method when inputType or available methods change
  useEffect(() => {
    const key = isSimulationMode ? performanceInputType : (inputType === 'midi' ? 'midi' : 'audio');
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

  const cleanupBrowserAudio = () => {
    if (levelAnimRef.current !== null) {
      cancelAnimationFrame(levelAnimRef.current);
      levelAnimRef.current = null;
    }
    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    backendReadyRef.current = false;

    sendingRef.current = false;
    cleanupCountdown();
    setBrowserAudioStatus('idle');
    setAudioLevel(0);
  };

  const cleanupBrowserMidi = () => {
    if (midiInputRef.current) {
      midiInputRef.current.onmidimessage = null;
      midiInputRef.current = null;
    }
    if (midiAccessRef.current) {
      midiAccessRef.current = null;
    }
    backendReadyRef.current = false;

    sendingRef.current = false;
    cleanupCountdown();
    setBrowserAudioStatus('idle');
    setMidiMessageCount(0);
  };

  // Cleanup browser audio/midi on unmount
  useEffect(() => {
    return () => {
      cleanupBrowserAudio();
      cleanupBrowserMidi();
      if (ws.current) {
        ws.current.close();
        ws.current = null;
      }
    };
  }, []);

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
        applyCursorVisibility();
        animFrameRef.current = requestAnimationFrame(tick);
      };
      animFrameRef.current = requestAnimationFrame(tick);
      return;
    }

    // Browser audio streaming mode
    if (inputType === 'audio') {
      try {
        setBrowserAudioStatus('connecting');

        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: 44100,
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        });
        mediaStreamRef.current = stream;

        const audioCtx = new AudioContext({ sampleRate: 44100 });
        audioContextRef.current = audioCtx;

        // Set up audio level meter
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        analyserRef.current = analyser;
        const source = audioCtx.createMediaStreamSource(stream);
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const updateLevel = () => {
          analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
          setAudioLevel(sum / dataArray.length / 255);
          levelAnimRef.current = requestAnimationFrame(updateLevel);
        };
        levelAnimRef.current = requestAnimationFrame(updateLevel);

        // Set up audio worklet for streaming
        await audioCtx.audioWorklet.addModule('/audio-worklet-processor.js');
        const workletNode = new AudioWorkletNode(audioCtx, 'pcm-capture-processor');
        workletNodeRef.current = workletNode;
        source.connect(workletNode);

        setBrowserAudioStatus('listening');

        // Connect WebSocket
        const wsUrl = `wss://${window.location.host}/ws/audio-stream`;
        ws.current = new WebSocket(wsUrl);

        ws.current.onopen = () => {
          ws.current?.send(JSON.stringify({
            file_id,
            method: selectedMethod || undefined,
          }));
          setBrowserAudioStatus('initializing');
        };

        workletNode.port.onmessage = (event) => {
          if (!sendingRef.current) return;
          if (ws.current && ws.current.readyState === WebSocket.OPEN) {
            const float32 = event.data as Float32Array;
            ws.current.send(float32.buffer);
          }
        };

        let wsMsgCount = 0;
        let wsLastTime = performance.now();
        ws.current.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.status === 'ready') {
            console.log('[WS] ready received');
            backendReadyRef.current = true;
            startCountdown();
            return;
          }
          if (data.status === 'stream_started') {
            console.log('[WS] stream_started');
            return;
          }
          if (data.status === 'completed') {
            console.log('[WS] completed');
            stopMusic();
            return;
          }
          if (data.beat_position !== undefined) {
            wsMsgCount++;
            const now = performance.now();
            const renderStart = performance.now();
            scoreRenderer.current?.moveToPosition(data.beat_position);
            applyCursorVisibility();
            const renderEnd = performance.now();
            if (wsMsgCount % 10 === 1) {
              const networkDelay = data.server_ts ? (Date.now() - data.server_ts).toFixed(0) : '?';
              console.log(`[WS] #${wsMsgCount} beat=${data.beat_position.toFixed(2)} msgInterval=${(now - wsLastTime).toFixed(0)}ms network=${networkDelay}ms render=${(renderEnd - renderStart).toFixed(1)}ms`);
            }
            wsLastTime = now;
          }
        };

        ws.current.onclose = () => {
          cleanupBrowserAudio();
          setIsPlaying(false);
        };
        ws.current.onerror = () => {
          cleanupBrowserAudio();
          setIsPlaying(false);
        };
      } catch (e) {
        console.error('[Browser Audio] Error:', e);
        alert(`Browser audio error: ${e}`);
        cleanupBrowserAudio();
        setIsPlaying(false);
      }
      return;
    }

    // Browser MIDI streaming mode
    if (inputType === 'midi') {
      try {
        setBrowserAudioStatus('connecting');
        setMidiMessageCount(0);

        const midiAccess = await navigator.requestMIDIAccess();
        midiAccessRef.current = midiAccess;

        // Gather available MIDI inputs
        const inputs: Array<{ id: string; name: string }> = [];
        midiAccess.inputs.forEach((input) => {
          inputs.push({ id: input.id, name: input.name || `MIDI Input ${input.id}` });
        });
        setMidiInputs(inputs);

        if (inputs.length === 0) {
          alert('No MIDI input devices found. Please connect a MIDI device and try again.');
          cleanupBrowserMidi();
          setIsPlaying(false);
          return;
        }

        // Auto-select first input if none selected
        const targetId = selectedMidiInput || inputs[0].id;
        if (!selectedMidiInput) setSelectedMidiInput(targetId);

        let foundInput: MIDIInput | undefined;
        midiAccess.inputs.forEach((input) => {
          if (input.id === targetId) foundInput = input;
        });
        if (!foundInput) {
          alert('Selected MIDI input not found.');
          cleanupBrowserMidi();
          setIsPlaying(false);
          return;
        }
        const midiInput = foundInput;
        midiInputRef.current = midiInput;

        setBrowserAudioStatus('listening');

        // Connect WebSocket
        const wsUrl = `wss://${window.location.host}/ws/audio-stream`;
        ws.current = new WebSocket(wsUrl);

        ws.current.onopen = () => {
          ws.current?.send(JSON.stringify({
            file_id,
            method: selectedMethod || undefined,
            input_type: 'midi',
          }));
          midiStartTimeRef.current = performance.now();
          setBrowserAudioStatus('initializing');
        };

        // Listen for MIDI messages
        midiInput.onmidimessage = (event: MIDIMessageEvent) => {
          if (!sendingRef.current) return;
          if (!event.data || event.data.length < 3) return;
          const statusByte = event.data[0];
          const data1 = event.data[1];
          const data2 = event.data[2];

          // Only forward note_on (0x90) and note_off (0x80) messages
          const msgType = statusByte & 0xF0;
          if (msgType !== 0x90 && msgType !== 0x80) return;

          const relativeTime = (performance.now() - midiStartTimeRef.current) / 1000;

          if (ws.current && ws.current.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({
              type: 'midi',
              status: statusByte,
              note: data1,
              velocity: data2,
              time: relativeTime,
            }));
            setMidiMessageCount((c) => c + 1);
          }
        };

        let wsMsgCount = 0;
        let wsLastTime = performance.now();
        ws.current.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.status === 'ready') {
            console.log('[WS] ready received');
            backendReadyRef.current = true;
            startCountdown();
            return;
          }
          if (data.status === 'stream_started') {
            console.log('[WS] stream_started');
            return;
          }
          if (data.status === 'completed') {
            console.log('[WS] completed');
            stopMusic();
            return;
          }
          if (data.beat_position !== undefined) {
            wsMsgCount++;
            const now = performance.now();
            const renderStart = performance.now();
            scoreRenderer.current?.moveToPosition(data.beat_position);
            applyCursorVisibility();
            const renderEnd = performance.now();
            if (wsMsgCount % 10 === 1) {
              const networkDelay = data.server_ts ? (Date.now() - data.server_ts).toFixed(0) : '?';
              console.log(`[WS] #${wsMsgCount} beat=${data.beat_position.toFixed(2)} msgInterval=${(now - wsLastTime).toFixed(0)}ms network=${networkDelay}ms render=${(renderEnd - renderStart).toFixed(1)}ms`);
            }
            wsLastTime = now;
          }
        };

        ws.current.onclose = () => {
          cleanupBrowserMidi();
          setIsPlaying(false);
        };
        ws.current.onerror = () => {
          cleanupBrowserMidi();
          setIsPlaying(false);
        };
      } catch (e) {
        console.error('[Browser MIDI] Error:', e);
        alert(`Browser MIDI error: ${e}`);
        cleanupBrowserMidi();
        setIsPlaying(false);
      }
      return;
    }
  };

  const stopMusic = () => {
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    cleanupBrowserAudio();
    cleanupBrowserMidi();
    scoreRenderer.current?.hide();
    setIsPlaying(false);
    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }
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
      <div className="min-h-screen flex flex-col items-center justify-center bg-stone-50 font-sans">
        <p className="text-red-500 text-lg mb-4">{error}</p>
        <button
          onClick={() => router.push('/')}
          className="px-6 py-2 bg-stone-800 text-white rounded-lg hover:bg-stone-700 text-sm"
        >
          Back to Upload
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-stone-50 font-sans">
      <Head>
        {/* <title>LISzT</title> */}
        <title>Matchmaker for the Web</title>
      </Head>

      <div className="flex items-center justify-between px-8 py-5 border-b border-stone-200">
        {/* <Link href="/" className="...">LISzT</Link> */}
        <Link href="/" className="font-serif text-xl font-semibold tracking-wide text-stone-700 hover:text-stone-900 transition-colors cursor-pointer active:scale-95">Matchmaker</Link>
        <div className="flex items-center gap-3">
          <div className="relative" ref={settingsRef}>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="text-stone-400 hover:text-stone-600 transition-colors p-1 rounded-lg hover:bg-stone-100"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
              </svg>
            </button>
            {showSettings && (
              <div className="absolute right-0 top-full mt-2 w-56 bg-white rounded-xl border border-stone-100 py-3 px-4 z-50"
                   style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.06), 0 1px 4px rgba(0,0,0,0.04)' }}>
                <p className="text-[11px] text-stone-400 uppercase tracking-wider mb-3">Display</p>
                <label className="flex items-center justify-between cursor-pointer py-1.5">
                  <span className="text-sm text-stone-600">Note pointer</span>
                  <button
                    onClick={() => setShowNotePointer(!showNotePointer)}
                    className={`relative w-9 h-5 rounded-full transition-colors duration-200 ${showNotePointer ? 'bg-emerald-400' : 'bg-stone-200'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-200 ${showNotePointer ? 'translate-x-4' : ''}`} />
                  </button>
                </label>
                <label className="flex items-center justify-between cursor-pointer py-1.5">
                  <span className="text-sm text-stone-600">Measure highlight</span>
                  <button
                    onClick={() => setShowMeasurePointer(!showMeasurePointer)}
                    className={`relative w-9 h-5 rounded-full transition-colors duration-200 ${showMeasurePointer ? 'bg-emerald-400' : 'bg-stone-200'}`}
                  >
                    <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform duration-200 ${showMeasurePointer ? 'translate-x-4' : ''}`} />
                  </button>
                </label>
              </div>
            )}
          </div>
          <a
            href="https://github.com/pymatchmaker/matchmaker"
            target="_blank"
            rel="noopener noreferrer"
            className="text-stone-400 hover:text-stone-600 transition-colors"
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
            </svg>
          </a>
        </div>
      </div>

      <div className="flex-1 pb-32">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <div className="flex gap-1.5">
              {[0, 1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="w-2 h-2 bg-gray-400 rounded-full loading-dot"
                  style={{ animationDelay: `${i * 0.2}s` }}
                />
              ))}
            </div>
            <p className="text-gray-400 text-sm">{loadingMessage}</p>
          </div>
        ) : (
          <div className="flex justify-center py-3 px-4">
            <div className="inline-flex items-center gap-2 bg-white/80 backdrop-blur-md border border-gray-200 rounded-full px-3 py-2 shadow-sm">
              {/* Simulation mode */}
              {isSimulationMode && (
                <>
                  <span className="text-[11px] text-gray-400 px-1 hidden sm:inline">Simulation</span>
                  <select
                    value={selectedMethod}
                    onChange={(e) => { setSelectedMethod(e.target.value); setAlignmentData(null); }}
                    className="appearance-none bg-gray-50 text-gray-700 text-xs rounded-full px-3 py-1.5
                      border border-gray-200 focus:outline-none focus:border-gray-300 cursor-pointer"
                  >
                    {(availableMethods[performanceInputType] || []).map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                  {!alignmentData ? (
                    <button
                      onClick={runAlignment}
                      disabled={isPlaying}
                      className="px-4 py-1.5 rounded-full text-xs font-medium bg-gray-800 text-white hover:bg-gray-700 transition-colors"
                    >
                      Run
                    </button>
                  ) : (
                    <>
                      <button
                        onClick={playMusic}
                        disabled={isPlaying}
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-xs transition-colors
                          ${!isPlaying
                            ? 'bg-emerald-500/90 text-white hover:bg-emerald-600'
                            : 'bg-gray-100 text-gray-300 cursor-not-allowed'}`}
                      >
                        ▶
                      </button>
                      <button
                        onClick={stopMusic}
                        disabled={!isPlaying}
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-xs transition-colors
                          ${isPlaying
                            ? 'bg-rose-500/90 text-white hover:bg-rose-600'
                            : 'bg-gray-100 text-gray-300 cursor-not-allowed'}`}
                      >
                        ■
                      </button>
                    </>
                  )}
                </>
              )}

              {/* Live mode */}
              {!isSimulationMode && (
                <>
                  <div className="flex rounded-full overflow-hidden border border-gray-200">
                    <button
                      onClick={() => setInputType('audio')}
                      className={`px-3 py-1.5 text-xs font-medium transition-colors
                        ${inputType === 'audio'
                          ? 'bg-gray-800 text-white'
                          : 'text-gray-500 hover:bg-gray-50'}`}
                    >
                      Audio
                    </button>
                    <button
                      onClick={() => setInputType('midi')}
                      className={`px-3 py-1.5 text-xs font-medium transition-colors border-l border-gray-200
                        ${inputType === 'midi'
                          ? 'bg-gray-800 text-white'
                          : 'text-gray-500 hover:bg-gray-50'}`}
                    >
                      MIDI
                    </button>
                  </div>

                  {inputType === 'midi' && midiInputs.length > 1 && (
                    <select
                      value={selectedMidiInput}
                      onChange={(e) => setSelectedMidiInput(e.target.value)}
                      className="appearance-none bg-gray-50 text-gray-700 text-xs rounded-full px-3 py-1.5
                        border border-gray-200 focus:outline-none focus:border-gray-300 cursor-pointer max-w-[180px]"
                    >
                      {midiInputs.map((input) => (
                        <option key={input.id} value={input.id}>{input.name}</option>
                      ))}
                    </select>
                  )}

                  {inputType && (
                    <select
                      value={selectedMethod}
                      onChange={(e) => setSelectedMethod(e.target.value)}
                      className="appearance-none bg-gray-50 text-gray-700 text-xs rounded-full px-3 py-1.5
                        border border-gray-200 focus:outline-none focus:border-gray-300 cursor-pointer"
                    >
                      {(availableMethods[inputType] || []).map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  )}

                  <div className="flex gap-1 items-center">
                    <button
                      onClick={playMusic}
                      disabled={isPlaying}
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-xs transition-colors
                        ${!isPlaying
                          ? 'bg-emerald-500/90 text-white hover:bg-emerald-600'
                          : 'bg-gray-100 text-gray-300 cursor-not-allowed'}`}
                    >
                      ▶
                    </button>
                    <button
                      onClick={stopMusic}
                      disabled={!isPlaying}
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-xs transition-colors
                        ${isPlaying
                          ? 'bg-rose-500/90 text-white hover:bg-rose-600'
                          : 'bg-gray-100 text-gray-300 cursor-not-allowed'}`}
                    >
                      ■
                    </button>

                    {browserAudioStatus !== 'idle' && (
                      <div className="flex items-center gap-1.5 ml-2">
                        {browserAudioStatus === 'connecting' && (
                          <div className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full bg-yellow-400 animate-pulse" />
                            <span className="text-[10px] text-gray-400">connecting</span>
                          </div>
                        )}
                        {browserAudioStatus === 'listening' && (
                          <div className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
                            {inputType === 'audio' && (
                              <div className="flex items-end gap-[2px] h-4">
                                {Array.from({ length: 8 }).map((_, i) => (
                                  <div
                                    key={i}
                                    className="w-[3px] rounded-full transition-all duration-[50ms]"
                                    style={{
                                      height: `${Math.max(3, Math.min(16, audioLevel * 40 * (0.5 + Math.sin(i * 0.8) * 0.5 + Math.random() * 0.3)))}px`,
                                      backgroundColor: audioLevel > 0.03 ? '#60a5fa' : '#d1d5db',
                                    }}
                                  />
                                ))}
                              </div>
                            )}
                            {inputType === 'midi' && (
                              <span className="text-[10px] text-blue-400">ready</span>
                            )}
                          </div>
                        )}
                        {browserAudioStatus === 'initializing' && (
                          <div className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                            <span className="text-[10px] text-amber-500">preparing...</span>
                            {inputType === 'audio' && (
                              <div className="flex items-end gap-[2px] h-4">
                                {Array.from({ length: 8 }).map((_, i) => (
                                  <div
                                    key={i}
                                    className="w-[3px] rounded-full transition-all duration-[50ms]"
                                    style={{
                                      height: `${Math.max(3, Math.min(16, audioLevel * 40 * (0.5 + Math.sin(i * 0.8) * 0.5 + Math.random() * 0.3)))}px`,
                                      backgroundColor: audioLevel > 0.03 ? '#fbbf24' : '#d1d5db',
                                    }}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {browserAudioStatus === 'countdown' && (
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-full bg-amber-400 flex items-center justify-center text-white text-xs font-bold animate-pulse">
                              {countdownNumber}
                            </div>
                            {inputType === 'audio' && (
                              <div className="flex items-end gap-[2px] h-4">
                                {Array.from({ length: 8 }).map((_, i) => (
                                  <div
                                    key={i}
                                    className="w-[3px] rounded-full transition-all duration-[50ms]"
                                    style={{
                                      height: `${Math.max(3, Math.min(16, audioLevel * 40 * (0.5 + Math.sin(i * 0.8) * 0.5 + Math.random() * 0.3)))}px`,
                                      backgroundColor: audioLevel > 0.03 ? '#fbbf24' : '#d1d5db',
                                    }}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {browserAudioStatus === 'active' && (
                          <div className="flex items-center gap-1.5">
                            <div className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
                            {inputType === 'audio' && (
                              <div className="flex items-end gap-[2px] h-4">
                                {Array.from({ length: 8 }).map((_, i) => (
                                  <div
                                    key={i}
                                    className="w-[3px] rounded-full transition-all duration-[50ms]"
                                    style={{
                                      height: `${Math.max(3, Math.min(16, audioLevel * 40 * (0.5 + Math.sin(i * 0.8) * 0.5 + Math.random() * 0.3)))}px`,
                                      backgroundColor: audioLevel > 0.03 ? '#34d399' : '#d1d5db',
                                    }}
                                  />
                                ))}
                              </div>
                            )}
                            {inputType === 'midi' && midiMessageCount > 0 && (
                              <span className="text-[10px] text-emerald-400 tabular-nums">{midiMessageCount}</span>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </>
              )}
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
