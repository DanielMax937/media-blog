import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['electron', 'ws', 'ssh2', 'ssh2-sftp-client'],
};

export default nextConfig;
