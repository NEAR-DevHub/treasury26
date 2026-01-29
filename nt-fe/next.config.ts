import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['thread-stream', 'pino', 'geoip-lite'],
  transpilePackages: ['@hot-labs/near-connect'],
};

export default nextConfig;
