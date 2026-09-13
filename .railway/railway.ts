/**
 * Railway Infrastructure as Code.
 *
 * This replaces `railway.toml`. Config as Code is deprecated — existing files
 * keep working until 2026-12-01, but *new services cannot opt into it*, so a
 * service created today would silently ignore every setting in that file:
 * no healthcheck, no restart policy, no replica cap.
 *
 * Unlike `railway.toml`, this file can also declare the volume, which is the
 * one setting the app cannot survive without.
 *
 * Applying it needs the CLI — a git-connected deploy does NOT pick it up:
 *
 *     npx railway config plan    # show what would change
 *     npx railway config apply   # apply it
 *
 * Everything here can equally be set by hand in the dashboard; see README.
 */
import { defineRailway, github, project, service, volume } from 'railway/iac';

export default defineRailway((ctx) => {
  /**
   * The database, uploaded PDFs and the search index live here.
   *
   * Without this the container filesystem is ephemeral and every note is
   * destroyed on the next deploy. 2GB is roughly 10k notes plus a few thousand
   * pages of PDF; the models are baked into the image, so none of it is spent
   * on them.
   */
  const data = volume('evernotion-data', { sizeMB: 2048 });

  const app = service('evernotion', {
    // Omit `branch` so Railway follows the repository's default branch.
    source: github('IsamuTakiguchi/evernotion'),

    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },

    deploy: {
      // /api/health is reachable without a session precisely so this works.
      healthcheckPath: '/api/health',
      // The models ship in the image, so startup is fast; this is headroom for
      // a cold machine rather than a download window.
      healthcheckTimeout: 120,
      restartPolicyType: 'ON_FAILURE',
      restartPolicyMaxRetries: 3,
      // Not a choice: Railway does not allow replicas on a service with a
      // volume. It happens to be what SQLite wants anyway — one writer, and an
      // in-process ingest queue that a second instance would race.
      numReplicas: 1,
    },

    // The mount path the app reads from. Railway mounts volumes as root and
    // *not* as an overlay, so the image's build-time ownership is hidden;
    // docker-entrypoint.sh takes ownership here before dropping privileges.
    volumeMounts: { '/data': data },
  });

  return project(ctx.projectName ?? 'evernotion', { resources: [app] });
});
