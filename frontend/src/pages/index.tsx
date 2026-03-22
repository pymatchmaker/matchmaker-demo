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
  }) => {
    // Store score content in sessionStorage for immediate rendering on the score page
    sessionStorage.setItem(`score_${data.file_id}`, JSON.stringify({
      file_content: data.file_content,
      file_name: data.fileName || '',
      has_performance_file: data.hasPerformanceFile,
    }));

    router.push(`/score/${data.file_id}`);
  };

  return (
    <div className="min-h-screen flex flex-col">
      <Head>
        <title>Score Following App</title>
      </Head>

      <div className="text-center mt-24 -mb-8">
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
        <div className="max-w-2xl mx-auto pt-16 px-8">
          <FileUpload backendUrl={backendUrl} onFileUpload={onFileUpload} />
        </div>
      </div>
    </div>
  );
};

export default IndexPage;
