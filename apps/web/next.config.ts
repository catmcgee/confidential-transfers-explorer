import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  // Enable WebSocket proxying for development
  async rewrites() {
    return [];
  },
};

export default nextConfig;
