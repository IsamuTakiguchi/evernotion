import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;

let db: DB | null = null;

export function dataDir(): string {
  const dir = process.env.EVERNOTION_DATA_DIR
    ? path.resolve(process.env.EVERNOTION_DATA_DIR)
    : path.join(process.cwd(), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function filesDir(): string {
  const dir = path.join(dataDir(), 'files');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function migrationsDir(): string {
  // Resolve relative to this module so it works from .next builds too.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'migrations'),
    path.join(process.cwd(), 'lib', 'db', 'migrations'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error('migrations directory not found');
}

function migrate(database: DB) {
  database.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(
    database.prepare('SELECT name FROM _migrations').all().map((r) => (r as { name: string }).name),
  );
  const dir = migrationsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    database.exec('BEGIN');
    try {
      database.exec(sql);
      database.prepare('INSERT INTO _migrations(name) VALUES (?)').run(file);
      database.exec('COMMIT');
    } catch (err) {
      database.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    }
  }
}

export function getDb(): DB {
  if (db) return db;
  const file = path.join(dataDir(), 'evernotion.db');
  const database = new Database(file);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('synchronous = NORMAL');
  migrate(database);
  db = database;
  return db;
}
