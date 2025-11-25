import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['patchright', 'patchright-core', 'electron', 'ws'],
};

export default nextConfig;
