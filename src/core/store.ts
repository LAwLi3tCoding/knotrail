import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Project, TaskSnapshot, TaskEvent } from '../shared/contracts.js';
export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export class Store {
  readonly db: DatabaseSync;
  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'state.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS values_store (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, value TEXT NOT NULL);`);
  }
  list(): TaskSnapshot[] { return this.db.prepare('SELECT snapshot FROM tasks').all().map(r => JSON.parse(r.snapshot as string)); }
  get(taskId: string): TaskSnapshot { const row = this.db.prepare('SELECT snapshot FROM tasks WHERE id=?').get(taskId); if (!row) throw new Error('Task not found'); return JSON.parse(row.snapshot as string); }
  put(s: TaskSnapshot): void { this.db.prepare('INSERT INTO tasks VALUES (?,?) ON CONFLICT(id) DO UPDATE SET snapshot=excluded.snapshot').run(s.task.id, JSON.stringify(s)); }
  // ponytail: one JSON snapshot per personal task; normalize events if histories exceed tens of thousands of rows.
  update(taskId: string, change: (s: TaskSnapshot) => void): TaskSnapshot {
    this.db.exec('BEGIN IMMEDIATE');
    try { const s = this.get(taskId); change(s); s.task.updatedAt = now(); this.put(s); this.db.exec('COMMIT'); return s; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  event(s: TaskSnapshot, kind: string, text: string, extra: Partial<TaskEvent> = {}): void {
    s.events.push({ id: id(), taskId: s.task.id, taskRevision: s.task.revision, planId: s.task.activePlanId, seq: ++s.lastSequence, kind, text, createdAt: now(), ...extra });
  }
  projects(): Project[] { return this.db.prepare('SELECT value FROM projects').all().map(r => JSON.parse(r.value as string)); }
  project(p: Project): Project { const old = this.projects().find(item => item.path === p.path); if (old) return old; this.db.prepare('INSERT INTO projects VALUES (?,?,?)').run(p.id,p.path,JSON.stringify(p)); return p; }
  value<T>(key: string): T | undefined { const row = this.db.prepare('SELECT value FROM values_store WHERE key=?').get(key); return row ? JSON.parse(row.value as string) : undefined; }
  set(key: string, value: unknown): void { this.db.prepare('INSERT INTO values_store VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  request<T>(requestId: string, fingerprint: string): T | undefined { const row = this.db.prepare('SELECT fingerprint,value FROM requests WHERE id=?').get(requestId); if (!row) return undefined; if (row.fingerprint !== fingerprint) throw new Error('Request ID reused with different arguments'); return JSON.parse(row.value as string); }
  saveRequest(requestId: string, fingerprint: string, value: unknown): void { this.db.prepare('INSERT INTO requests VALUES (?,?,?)').run(requestId,fingerprint,JSON.stringify(value)); }
  close(): void { this.db.close(); }
}
