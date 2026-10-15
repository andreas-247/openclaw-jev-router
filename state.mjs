// Plugin-owned storage. Does not access OpenClaw's trusted shared-state API/database.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function openStore({ path = join(process.env.OPENCLAW_STATE_DIR ?? join(homedir(), '.openclaw'), 'plugin-state', 'jarvis-codex-router', 'router.sqlite'), namespace, maxEntries = 1000, defaultTtlMs = 0 }) {
  const filename = path instanceof URL ? fileURLToPath(path) : path;
  if (typeof namespace !== 'string' || !namespace || !Number.isInteger(maxEntries) || maxEntries < 1) throw Error('Invalid store options');
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const access = task => {
    const db = new DatabaseSync(filename);
    try {
      chmodSync(filename, 0o600);
      db.exec('PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS state (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated INTEGER NOT NULL, expires INTEGER, PRIMARY KEY(namespace,key))');
      return task(db);
    } finally { db.close(); }
  };
  // Open lazily on first operation; every handle closes before returning (safe across reloads).
  return {
    lookup(key) {
      return access(db => {
        const row = db.prepare('SELECT value FROM state WHERE namespace=? AND key=? AND (expires IS NULL OR expires>?)').get(namespace, key, Date.now());
        return row ? JSON.parse(row.value) : undefined;
      });
    },
    register(key, value, options = {}) {
      const raw = JSON.stringify(value), now = Date.now();
      if (Buffer.byteLength(raw) > 65536) throw Error('Store value too large');
      return access(db => {
        db.exec('BEGIN IMMEDIATE');
        try {
          options.assertCurrent?.();
          db.prepare('DELETE FROM state WHERE namespace=? AND expires IS NOT NULL AND expires<=?').run(namespace, now);
          db.prepare('INSERT INTO state(namespace,key,value,updated,expires) VALUES(?,?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value, updated=excluded.updated, expires=excluded.expires').run(namespace, key, raw, now, defaultTtlMs ? now + defaultTtlMs : null);
          db.prepare('DELETE FROM state WHERE namespace=? AND key IN (SELECT key FROM state WHERE namespace=? ORDER BY updated DESC, rowid DESC LIMIT -1 OFFSET ?)').run(namespace, namespace, maxEntries);
          db.exec('COMMIT');
          return value;
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      });
    },
  };
}
