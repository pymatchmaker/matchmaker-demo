import React, { forwardRef, useImperativeHandle, useRef, useState, useEffect, useCallback } from 'react';

export interface AudioPlayerRef {
  play: () => void;
  pause: () => void;
  getCurrentTime: () => number;
  unlock: () => Promise<void>;
}

interface CustomAudioPlayerProps {
  audioFile: File | string;
  isPlaying: boolean;
  onPlay: () => void;
  onPause: () => void;
  onEnded: () => void;
}

const formatTime = (s: number): string => {
  if (!isFinite(s) || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};

const CustomAudioPlayer = forwardRef<AudioPlayerRef, CustomAudioPlayerProps>(({
  audioFile, isPlaying, onPlay, onPause, onEnded
}, ref) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [localPlaying, setLocalPlaying] = useState(false);

  useImperativeHandle(ref, () => ({
    play: () => { audioRef.current?.play(); },
    pause: () => { audioRef.current?.pause(); },
    getCurrentTime: () => audioRef.current?.currentTime ?? 0,
    unlock: async () => {
      // Unlock audio context within user gesture, without triggering onPlay/visible playback
      const audio = audioRef.current;
      if (!audio) return;
      audio.muted = true;
      try { await audio.play(); } catch { /* ignore */ }
      audio.pause();
      audio.currentTime = 0;
      audio.muted = false;
    },
  }));

  const audioUrl = React.useMemo(() => {
    if (typeof audioFile === 'string') return audioFile;
    return URL.createObjectURL(audioFile);
  }, [audioFile]);

  useEffect(() => {
    return () => {
      if (audioUrl && audioUrl.startsWith('blob:')) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  const handleTimeUpdate = useCallback(() => {
    if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
  }, []);

  const handleLoadedMetadata = useCallback(() => {
    if (audioRef.current) setDuration(audioRef.current.duration);
  }, []);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audioRef.current.currentTime = ratio * duration;
  }, [duration]);

  const togglePlay = () => {
    if (localPlaying) {
      audioRef.current?.pause();
      onPause();
    } else {
      audioRef.current?.play();
      onPlay();
    }
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="flex items-center gap-3 px-4 py-2 max-w-2xl mx-auto">
      <audio
        ref={audioRef}
        src={audioUrl}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onPlay={() => setLocalPlaying(true)}
        onPause={() => setLocalPlaying(false)}
        onEnded={() => { setLocalPlaying(false); onEnded(); }}
      />

      {/* Play/Pause */}
      <button
        onClick={togglePlay}
        className="w-8 h-8 flex items-center justify-center rounded-full bg-gray-900 text-white hover:bg-gray-700 transition-colors flex-shrink-0"
      >
        {localPlaying ? (
          <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
          </svg>
        ) : (
          <svg className="w-3 h-3 ml-0.5" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5,3 19,12 5,21" />
          </svg>
        )}
      </button>

      {/* Time */}
      <span className="text-xs text-gray-500 tabular-nums w-10 text-right flex-shrink-0">
        {formatTime(currentTime)}
      </span>

      {/* Progress bar */}
      <div
        className="flex-1 h-1.5 bg-gray-200 rounded-full cursor-pointer group relative"
        onClick={handleSeek}
      >
        <div
          className="h-full bg-gray-900 rounded-full relative transition-[width] duration-75"
          style={{ width: `${progress}%` }}
        >
          <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-gray-900 rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
      </div>

      {/* Duration */}
      <span className="text-xs text-gray-400 tabular-nums w-10 flex-shrink-0">
        {formatTime(duration)}
      </span>
    </div>
  );
});

export default CustomAudioPlayer;
