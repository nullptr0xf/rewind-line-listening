import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // better-sqlite3 is a native addon: keep it out of the bundler so it is
  // require()d from node_modules at runtime instead.
  serverExternalPackages: ['better-sqlite3'],
}

export default nextConfig
