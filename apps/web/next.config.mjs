/** @type {import('next').NextConfig} */
export default {
  // PGlite ships WASM and postgres.js opens raw sockets: both must stay real
  // runtime requires rather than being bundled.
  serverExternalPackages: ['@electric-sql/pglite', 'postgres', '@aws-sdk/client-kms'],

  // @lcp/db is TypeScript source, compiled by Next rather than pre-built.
  transpilePackages: ['@lcp/db'],

  webpack: (config) => {
    // The db package uses NodeNext-style '.js' specifiers that actually resolve
    // to '.ts' files. Node and tsx handle that natively; webpack needs telling.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};
