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
# .npmrc sets onnxruntime-node-install-cuda=skip, which keeps a 302MB CUDA
# execution provider out of an image that will never see a GPU.
# --ignore-scripts is not an option here: sharp and the native addons need
# their install scripts to place the right prebuild.
RUN npm ci --no-audit --no-fund

# --------------------------------------------------------------- build ------
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Copies pdf.js CMaps into public/ — without them Japanese PDFs extract as
# empty text. Normally run by postinstall, which npm ci already skipped past.
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
