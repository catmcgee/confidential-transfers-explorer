import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Enable WebSocket proxying for development
  async rewrites() {
    return [];
  },
  // Enable WebAssembly for @solana/zk-sdk
  webpack: (config, { isServer }) => {
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      layers: true,
    };

    // Fix "Cannot read properties of undefined (reading 'call')" for WASM chunks
    if (!isServer) {
      config.output = {
        ...config.output,
        webassemblyModuleFilename: 'static/wasm/[modulehash].wasm',
        environment: {
          ...config.output?.environment,
          asyncFunction: true,
        },
      };
    }

    return config;
  },
};

export default nextConfig;
