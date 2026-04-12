module.exports = {
  devIndicators: false,
  env: {
    NEXT_PUBLIC_BACKEND_URL: process.env.NEXT_PUBLIC_BACKEND_URL,
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // 클라이언트 사이드에서 Node.js 모듈을 사용하지 않도록 설정
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
        module: false,
        stream: false,
        util: false,
        buffer: false,
        process: false,
      };
      
      // Verovio WASM 모듈의 module import를 무시하도록 설정
      const webpack = require('webpack');
      config.plugins = config.plugins || [];
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /^module$/,
          require.resolve('./webpack-module-shim.js')
        )
      );
    }
    return config;
  },
};