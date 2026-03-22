import React, { useRef, useState } from 'react';

interface FileUploadProps {
  backendUrl: string;
  onFileUpload: (data: { 
    file_id: string;
    file_content: string;
    hasPerformanceFile: boolean;
    performanceFile?: File;
    fileName?: string;
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
      const formData = new FormData();
      formData.append('file', scoreFile);
      
      if (audioFile) {
        formData.append('performance_file', audioFile);
      }

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
        fileName: scoreFile.name
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
    <div className="space-y-8">
      {/* Score Upload Section */}
      <div 
        className={`p-8 border-2 border-dashed rounded-lg text-center
          ${isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-300'}
          hover:border-blue-400 transition-colors duration-200`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) setScoreFile(file);
        }}
      >
        <div className="text-lg font-semibold mb-2 text-gray-700">Sheet Music Score (MusicXML or MEI)</div>
        <p className="text-sm text-gray-500 mb-4">
          Drag and drop your score file here, or click to select
        </p>
        <button
          onClick={() => scoreInputRef.current?.click()}
          className="bg-blue-500 text-white px-6 py-2 rounded-md hover:bg-blue-600 transition-colors"
        >
          Select Score File
        </button>
        <input
          ref={scoreInputRef}
          type="file"
          accept=".xml,.musicxml,.mei"
          onChange={(e) => e.target.files?.[0] && setScoreFile(e.target.files[0])}
          className="hidden"
        />
        {scoreFile && (
          <div className="text-sm text-gray-600">
            Selected: {scoreFile.name}
          </div>
        )}
      </div>

      {/* Audio Upload Section (Optional) */}
      <div className="p-8 border-2 border-dashed rounded-lg text-center border-gray-300">
        <div className="text-lg font-semibold mb-2 text-gray-700">Performance File (Optional)</div>
        <p className="text-sm text-gray-500 mb-4">
          Upload a performance file (audio or midi) for simulation mode
        </p>
        <button
          onClick={() => audioInputRef.current?.click()}
          className="bg-gray-500 text-white px-6 py-2 rounded-md hover:bg-gray-600 transition-colors"
        >
          Select Performance File
        </button>
        <input
          ref={audioInputRef}
          type="file"
          accept="audio/*"
          onChange={(e) => e.target.files?.[0] && setAudioFile(e.target.files[0])}
          className="hidden"
        />
        {audioFile && (
          <div className="text-sm text-gray-600">
            Selected: {audioFile.name}
          </div>
        )}
      </div>

      {/* Upload Button and Progress */}
      <div className="text-center">
        {isUploading ? (
          <div className="space-y-4">
            <div className="w-full max-w-xs mx-auto bg-gray-200 rounded-full h-2.5 overflow-hidden">
              <div 
                className="bg-blue-500 h-full transition-all duration-500 ease-out"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
            <div className="text-sm text-gray-600">
              {uploadProgress < 50 ? 'Uploading score...' : 'Processing score...'}
            </div>
          </div>
        ) : (
          <button
            onClick={handleUpload}
            disabled={!scoreFile || isUploading}
            className={`group relative px-8 py-3 rounded-md text-white font-medium
              ${scoreFile && !isUploading
                ? 'bg-green-500 hover:bg-green-600' 
                : 'bg-gray-300 cursor-not-allowed'}
              transition-all duration-200`}
          >
            <span className="flex items-center justify-center">
              {scoreFile && (
                <svg 
                  className="w-5 h-5 mr-2 transition-transform group-hover:rotate-[360deg] duration-500" 
                  fill="none" 
                  viewBox="0 0 24 24" 
                  stroke="currentColor"
                >
                  <path 
                    strokeLinecap="round" 
                    strokeLinejoin="round" 
                    strokeWidth={2} 
                    d="M9 13l3-3m0 0l3 3m-3-3v8"
                  />
                </svg>
              )}
              Upload and Start
            </span>
          </button>
        )}
      </div>
    </div>
  );
};

export default FileUpload;