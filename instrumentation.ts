/**
 * Next.js runs register() once when the server starts.
 *
 * This is where the app provisions itself: migrations, first-run content,
 * recovery of any PDF ingest interrupted by a restart, and the one-time model
 * download. Doing it here rather than in a setup script means `npm run dev`
 * is the only command a new user has to type.
 */
export async function register() {
  // Also invoked for the edge runtime, which has no filesystem or SQLite.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { bootstrap } = await import('./lib/setup/bootstrap');
  bootstrap();
}
