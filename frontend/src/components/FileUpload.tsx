import React, { useRef, useState } from 'react';

interface FileUploadProps {
  backendUrl: string;
  onFileUpload: (data: {
    file_id: string;
    file_content: string;
    hasPerformanceFile: boolean;
    performanceFile?: File;
    fileName?: string;
    alignment?: Array<{time: number; position: number}>;
  }) => void;
}

const FileUpload: React.FC<FileUploadProps> = ({ backendUrl, onFileUpload }) => {
  const [scoreFile, setScoreFile] = useState<File | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const scoreInputRef = useRef<HTMLInputElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async () => {
    if (!scoreFile) return;

    setIsUploading(true);
    setUploadProgress(0);

    try {
      // Clean up previous uploads before starting new one
      await fetch(`${backendUrl}/reset`, { method: 'POST' }).catch(() => {});

      const formData = new FormData();
      formData.append('file', scoreFile);
      if (audioFile) formData.append('performance_file', audioFile);

      setUploadProgress(30);

      const response = await fetch(`${backendUrl}/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) throw new Error('Upload failed');

      setUploadProgress(60);
      const data = await response.json();

      const fileContent = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target?.result as string);
        reader.readAsText(scoreFile);
      });

      setUploadProgress(100);

      onFileUpload({
        file_id: data.file_id,
        file_content: fileContent,
        hasPerformanceFile: !!audioFile,
        performanceFile: audioFile || undefined,
        fileName: scoreFile.name,
        alignment: data.alignment || undefined,
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
            ? 'border-blue-400 bg-blue-50/50'
            : scoreFile
              ? 'border-green-300 bg-green-50/30'
              : 'border-gray-200 hover:border-gray-300 bg-white'}`}
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
              <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center mb-3">
                <svg className="w-5 h-5 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-sm font-medium text-gray-900">{scoreFile.name}</p>
              <p className="text-xs text-gray-400 mt-1">Click to change</p>
            </>
          ) : (
            <>
              <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center mb-3">
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 18V5l12-2v13M9 18c0 1.1-1.3 2-3 2s-3-.9-3-2 1.3-2 3-2 3 .9 3 2zm12-2c0 1.1-1.3 2-3 2s-3-.9-3-2 1.3-2 3-2 3 .9 3 2z" />
                </svg>
              </div>
              <p className="text-sm font-medium text-gray-700">Drop your score file here</p>
              <p className="text-xs text-gray-400 mt-1">or click to browse</p>
            </>
          )}
        </div>
        <input
          ref={scoreInputRef}
          type="file"
          accept=".xml,.musicxml,.mei"
          onChange={(e) => e.target.files?.[0] && setScoreFile(e.target.files[0])}
          className="hidden"
        />
      </div>

      {/* Performance file - compact row */}
      <div
        className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-3 cursor-pointer hover:border-gray-300 transition-colors"
        onClick={() => audioInputRef.current?.click()}
      >
        <div className="flex items-center gap-3">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${audioFile ? 'bg-green-100' : 'bg-gray-100'}`}>
            {audioFile ? (
              <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            )}
          </div>
          <div>
            <p className="text-sm text-gray-700">
              {audioFile ? audioFile.name : 'Add performance file'}
            </p>
            <p className="text-xs text-gray-400">
              {audioFile ? 'Click to change' : 'Optional - for simulation mode'}
            </p>
          </div>
        </div>
        <svg className="w-4 h-4 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
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

      {/* Submit */}
      {isUploading ? (
        <div className="pt-2">
          <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
            <div
              className="bg-blue-500 h-full rounded-full transition-all duration-500 ease-out"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
          <p className="text-xs text-gray-400 text-center mt-2">
            {uploadProgress < 50 ? 'Uploading...' : 'Processing score...'}
          </p>
        </div>
      ) : (
        <button
          onClick={handleUpload}
          disabled={!scoreFile}
          className={`w-full py-3 rounded-xl text-sm font-medium transition-all duration-200
            ${scoreFile
              ? 'bg-gray-900 text-white hover:bg-gray-800 shadow-sm'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed'}`}
        >
          Start Score Following
        </button>
      )}
    </div>
  );
};

export default FileUpload;
