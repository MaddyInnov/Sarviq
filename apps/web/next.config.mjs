/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export → out/ dir. The API serves this directory (dev) or an
  // embedded gzip asset map (single-binary distribution). No server-side
  // features: all data fetching is client-side against the API.
  output: 'export',
};

export default nextConfig;
