/** @type {import('next').NextConfig} */
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3000';

const nextConfig = {
  // @storefront/shared ships TypeScript source rather than a build step, so
  // Next has to compile it alongside the app.
  transpilePackages: ['@storefront/shared'],

  // The dashboard is a browser client of an API on another port. Rewriting
  // /api/* onto it keeps every fetch same-origin, so the API needs no CORS
  // configuration and no browser-facing surface it would not otherwise have.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_BASE_URL}/:path*` }];
  },
};

export default nextConfig;
