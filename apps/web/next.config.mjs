/** @type {import('next').NextConfig} */
const nextConfig = {
  // @storefront/shared ships TypeScript source rather than a build step, so
  // Next has to compile it alongside the app.
  transpilePackages: ['@storefront/shared'],
};

export default nextConfig;
