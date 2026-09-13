import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Emits a self-contained server with only the traced dependencies, which is
  // what the container image runs.
  output: 'standalone',

  serverExternalPackages: [
    'better-sqlite3',
    'pdfjs-dist',
    'tesseract.js',
    '@napi-rs/canvas',
    '@huggingface/transformers',
    'onnxruntime-node',
    'sharp',
  ],

  // These are read from disk at runtime rather than imported, so dependency
  // tracing cannot see them and would otherwise leave them out of the
  // standalone build — the server would then start and fail on first request
  // with "migrations directory not found".
  outputFileTracingIncludes: {
    '/**': [
      './lib/db/migrations/**',
      './public/pdfjs/**',

      // Native assets that tracing misses, because nothing imports them by
      // path — they are resolved by the addon or downloaded-at-runtime loader.
      // Without these the standalone server starts cleanly and then fails only
      // when a feature is used: semantic search dies with
      // "libonnxruntime.so.1: cannot open shared object file", and OCR silently
      // produces nothing.
      //
      // The CUDA and TensorRT execution providers are deliberately NOT here:
      // libonnxruntime_providers_cuda.so alone is 302MB and no container this
      // runs in has a GPU. .npmrc also skips fetching them at install time.
      './node_modules/onnxruntime-node/bin/napi-v6/**/libonnxruntime.so*',
      './node_modules/onnxruntime-node/bin/napi-v6/**/libonnxruntime_providers_shared.so',
      './node_modules/tesseract.js-core/**',
      './node_modules/tesseract.js/src/**',

      // tesseract.js runs its recogniser in a separate Node worker, so the
      // modules that worker requires are invisible to tracing. Missing them
      // does not fail the build or the boot — OCR just dies at use time with
      // "Cannot find module 'bmp-js'" from inside the worker.
      './node_modules/bmp-js/**',
      './node_modules/idb-keyval/**',
      './node_modules/is-url/**',
      './node_modules/node-fetch/**',
      './node_modules/regenerator-runtime/**',
      './node_modules/wasm-feature-detect/**',
      './node_modules/zlibjs/**',
    ],
  },

  // NOTE: dependency tracing also sweeps in the project root, so a local
  // `data/` directory would be baked into the build — the developer's own
  // notes database and uploaded PDFs. outputFileTracingExcludes does not
  // prevent this in Next 16, so .dockerignore keeps `data/` out of the image
  // build context instead, and the container mounts a volume for it at runtime.
};

export default nextConfig;
