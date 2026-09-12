import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: [
    'better-sqlite3',
    'pdfjs-dist',
    'tesseract.js',
    '@napi-rs/canvas',
    '@huggingface/transformers',
    'onnxruntime-node',
    'sharp',
  ],
};

export default nextConfig;
