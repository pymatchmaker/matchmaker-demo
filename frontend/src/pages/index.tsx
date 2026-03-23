import React from 'react';
import { useRouter } from 'next/router';
import Head from 'next/head';
import FileUpload from '../components/FileUpload';

const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000';

const IndexPage: React.FC = () => {
  const router = useRouter();

  const onFileUpload = async (data: {
    file_id: string;
    file_content: string;
    hasPerformanceFile: boolean;
    performanceFile?: File;
    fileName?: string;
    alignment?: Array<{time: number; position: number}>;
    isPdf?: boolean;
    pixelMapping?: any;
  }) => {
    const perfName = data.performanceFile?.name || '';
    const perfInputType = /\.(mid|midi)$/i.test(perfName) ? 'midi' : 'audio';

    sessionStorage.setItem(`score_${data.file_id}`, JSON.stringify({
      file_content: data.file_content,
      file_name: data.fileName || '',
      has_performance_file: data.hasPerformanceFile,
      performance_input_type: data.hasPerformanceFile ? perfInputType : null,
      alignment: data.alignment || null,
      is_pdf: data.isPdf || false,
      pixel_mapping: data.pixelMapping || null,
    }));
    router.push(`/score/${data.file_id}`);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100 flex flex-col">
      <Head>
        <title>Matchmaker - Real-time Score Following</title>
      </Head>

      {/* Nav */}
      <nav className="flex items-center justify-between px-8 py-5 relative z-10">
        <span className="text-sm font-medium text-gray-700">Score Following <span className="text-gray-400 font-normal">with Matchmaker</span></span>
        <a
          href="https://github.com/pymatchmaker/matchmaker"
          target="_blank"
          rel="noopener noreferrer"
          className="text-gray-400 hover:text-gray-900 transition-colors"
        >
          <svg className="w-5 h-5" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
          </svg>
        </a>
      </nav>

      {/* Hero */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 -mt-16">
        <div className="text-center mb-10">
          <h1 className="text-5xl font-bold tracking-tight text-gray-900">
            Score Following App
          </h1>
          <p className="text-lg text-gray-400 mt-2">
            with <a href="https://github.com/pymatchmaker/matchmaker" target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:text-gray-700 underline underline-offset-2">Matchmaker</a>
          </p>
        </div>

        <div className="w-full max-w-xl">
          <FileUpload backendUrl={backendUrl} onFileUpload={onFileUpload} />
        </div>
      </div>

      {/* Footer */}
      <div className="text-center py-6 text-xs text-gray-400">
        Supports MusicXML, MEI, and PDF formats
      </div>
    </div>
  );
};

export default IndexPage;
