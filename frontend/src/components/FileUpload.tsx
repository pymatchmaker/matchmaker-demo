import React, { useRef, useState, useEffect } from 'react';

interface FileUploadProps {
  backendUrl: string;
  onFileUpload: (data: {
    file_id: string;
    file_content: string;
    hasPerformanceFile: boolean;
    performanceFile?: File;
    fileName?: string;
    alignment?: Array<{time: number; position: number}>;
    isPdf?: boolean;
    pixelMapping?: any;
  }) => void;
}

const FileUpload: React.FC<FileUploadProps> = ({ backendUrl, onFileUpload }) => {
  const [scoreFile, setScoreFile] = useState<File | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [tempo, setTempo] = useState<string>('');
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dots, setDots] = useState('');
  const scoreInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const fakeProgressRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Animate dots and fake progress while uploading
  useEffect(() => {
    if (!isUploading) return;
    const dotTimer = setInterval(() => {
      setDots((d) => (d.length >= 3 ? '' : d + '.'));
    }, 500);
    return () => clearInterval(dotTimer);
  }, [isUploading]);

  useEffect(() => {
    if (!isUploading) {
      if (fakeProgressRef.current) {
        clearInterval(fakeProgressRef.current);
        fakeProgressRef.current = null;
      }
      return;
    }
    // Slowly increment progress while waiting (30 → 85 over time)
    fakeProgressRef.current = setInterval(() => {
      setUploadProgress((p) => {
        if (p >= 85) return p;
        // Slow down as it gets higher
        const increment = Math.max(0.3, (85 - p) * 0.02);
        return Math.min(85, p + increment);
      });
    }, 300);
    return () => {
      if (fakeProgressRef.current) {
        clearInterval(fakeProgressRef.current);
        fakeProgressRef.current = null;
      }
    };
  }, [isUploading]);

  const handleUpload = async () => {
    if (!scoreFile) return;

    setIsUploading(true);
    setUploadProgress(0);

    try {
      await fetch(`${backendUrl}/reset`, { method: 'POST' }).catch(() => {});
      sessionStorage.clear();

      const formData = new FormData();
      formData.append('file', scoreFile);
      if (audioFile) formData.append('performance_file', audioFile);
      if (tempo.trim()) formData.append('tempo', tempo.trim());

      setUploadProgress(5);

      const response = await fetch(`${backendUrl}/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error('Upload failed');

      const data = await response.json();

      let fileContent = '';
      if (!scoreFile.name.toLowerCase().endsWith('.pdf')) {
        fileContent = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target?.result as string);
          reader.readAsText(scoreFile);
        });
      }

      setUploadProgress(100);

      onFileUpload({
        file_id: data.file_id,
        file_content: fileContent,
        hasPerformanceFile: !!audioFile,
        performanceFile: audioFile || undefined,
        fileName: scoreFile.name,
        alignment: data.alignment || undefined,
        isPdf: data.is_pdf || false,
        pixelMapping: data.pixel_mapping || undefined,
      });

    } catch (error) {
      console.error('Upload error:', error);
      alert('Upload failed. Please try again.');
    } finally {
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  return (
    <div className="space-y-3">
      {/* Score drop zone */}
      <div
        className={`relative rounded-2xl border-2 border-dashed transition-all duration-200 cursor-pointer
          ${isDragging
            ? 'border-amber-400 bg-amber-50/50'
            : scoreFile
              ? 'border-emerald-300 bg-emerald-50/30'
              : 'border-stone-200 hover:border-stone-300 bg-white'}`}
        onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) setScoreFile(file);
        }}
        onClick={() => scoreInputRef.current?.click()}
      >
        <div className="flex flex-col items-center py-10 px-6">
          {scoreFile ? (
            <>
              <div className="w-10 h-10 rounded-full bg-emerald-50 flex items-center justify-center mb-3">
                <svg className="w-5 h-5 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-sm font-medium text-stone-800">{scoreFile.name}</p>
              <p className="text-xs text-stone-400 mt-1">Click to change</p>
            </>
          ) : (
            <>
              <div className="w-10 h-10 rounded-full bg-stone-100 flex items-center justify-center mb-3">
                <svg className="w-5 h-5 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 18V5l12-2v13M9 18c0 1.1-1.3 2-3 2s-3-.9-3-2 1.3-2 3-2 3 .9 3 2zm12-2c0 1.1-1.3 2-3 2s-3-.9-3-2 1.3-2 3-2 3 .9 3 2z" />
                </svg>
              </div>
              <p className="text-sm text-stone-600">Drop your score file here</p>
              <p className="text-xs text-stone-400 mt-1">or click to browse</p>
            </>
          )}
        </div>
        <input
          ref={scoreInputRef}
          type="file"
          accept=".xml,.musicxml,.mei,.pdf"
          onChange={(e) => e.target.files?.[0] && setScoreFile(e.target.files[0])}
          className="hidden"
        />
      </div>

      {/* Performance file - compact row */}
      <div
        className="flex items-center justify-between rounded-xl border border-stone-200 bg-white px-4 py-3 cursor-pointer hover:border-stone-300 transition-colors"
        onClick={() => audioInputRef.current?.click()}
      >
        <div className="flex items-center gap-3">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${audioFile ? 'bg-emerald-50' : 'bg-stone-100'}`}>
            {audioFile ? (
              <svg className="w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            )}
          </div>
          <div>
            <p className="text-sm text-stone-600">
              {audioFile ? audioFile.name : 'Add performance file'}
            </p>
            <p className="text-xs text-stone-400">
              {audioFile ? 'Click to change' : 'Optional — for simulation mode'}
            </p>
          </div>
        </div>
        <svg className="w-4 h-4 text-stone-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        <input
          ref={audioInputRef}
          type="file"
          accept="audio/*,.mid,.midi"
          onChange={(e) => e.target.files?.[0] && setAudioFile(e.target.files[0])}
          className="hidden"
        />
      </div>

      {/* Tempo (optional) */}
      <div className="flex items-center rounded-xl border border-stone-200 bg-white px-4 py-3">
        <div className="flex items-center gap-3 flex-1">
          <div className="w-8 h-8 rounded-lg bg-stone-100 flex items-center justify-center">
            <svg className="w-4 h-4 text-stone-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2" />
              <circle cx="12" cy="12" r="9" strokeLinecap="round" />
            </svg>
          </div>
          <div className="flex-1">
            <p className="text-xs text-stone-400 mb-0.5">Tempo (quarter-note BPM)</p>
            <input
              type="number"
              min="20"
              max="300"
              placeholder="auto-detect or 120"
              value={tempo}
              onChange={(e) => setTempo(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              className="w-full text-sm text-stone-700 bg-transparent outline-none placeholder:text-stone-300"
            />
          </div>
        </div>
      </div>

      {/* Submit */}
      {isUploading ? (
        <div className="pt-2">
          <div className="w-full bg-stone-100 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-amber-500 h-full rounded-full transition-all duration-500 ease-out"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
          <p className="text-xs text-stone-400 text-center mt-2">
            <span>{uploadProgress < 50 ? 'Uploading' : 'Processing score'}</span>
            <span className="inline-block w-4 text-left">{dots}</span>
          </p>
        </div>
      ) : (
        <button
          onClick={handleUpload}
          disabled={!scoreFile}
          className={`w-full py-3 rounded-xl text-sm font-medium tracking-wide transition-all duration-200
            ${scoreFile
              ? 'bg-stone-800 text-white hover:bg-stone-700 shadow-sm'
              : 'bg-stone-100 text-stone-400 cursor-not-allowed'}`}
        >
          Upload Score
        </button>
      )}
    </div>
  );
};

export default FileUpload;
