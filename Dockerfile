# syntax=docker/dockerfile:1

# Debian slim rather than Alpine: better-sqlite3, sharp, @napi-rs/canvas and
# onnxruntime-node all ship glibc prebuilds. On musl they would fall back to
# compiling from source, or simply fail to load.
FROM node:22-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1

# ---------------------------------------------------------------- deps ------
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./

# --ignore-scripts is doing real work here, not just saving time.
#
# better-sqlite3 ships a binding.gyp alongside its prebuilt binaries, and npm
# treats the mere presence of that file as "build this from source" whenever a
# package declares no install script of its own. So a normal `npm ci` runs
# `node-gyp rebuild`, which needs Python and a C++ toolchain this image does
# not have, and the build fails — even though the prebuilt binary it needs is
# already sitting in the tarball and is what gets loaded at require time.
#
# Every native dependency here ships usable prebuilds the same way, so no
# install script needs to run. scripts/check-native.mjs verifies that in the
# next stage rather than trusting it.
RUN npm ci --ignore-scripts --no-audit --no-fund

# --------------------------------------------------------------- build ------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Fail the build here if a prebuilt binary is missing, rather than shipping an
# image whose search or OCR dies the first time someone uses it.
RUN node scripts/check-native.mjs

# Normally npm's postinstall; --ignore-scripts skipped it. Without the CMaps,
# Japanese PDFs extract as empty text and every page falls through to OCR.
RUN node scripts/copy-pdfjs-assets.mjs \
 && npx next build

# ---------------------------------------------------------------- run -------
FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production

# The volume is mounted here; everything the app persists lives under it.
ENV EVERNOTION_DATA_DIR=/data

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs \
 && mkdir -p /data && chown nextjs:nodejs /data

# `output: 'standalone'` emits a server plus only the traced dependencies.
# Static assets and public/ are not part of that trace and must come along
# separately — this is the documented standalone layout.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
