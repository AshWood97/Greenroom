"""MoneyPrinter's API and Streamlit worker share member-local durable task state."""
import json
import os
import sqlite3
from pathlib import Path

ROOT = Path(os.environ['GREENROOM_PLUGIN_ROOT']).resolve()
ROOT.mkdir(parents=True, exist_ok=True)
DATABASE = ROOT / 'moneyprinter.sqlite3'

def connect():
    db = sqlite3.connect(DATABASE, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('CREATE TABLE IF NOT EXISTS task_state (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, params TEXT NOT NULL, stop_at TEXT NOT NULL, state TEXT NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS materials (id TEXT PRIMARY KEY, payload TEXT NOT NULL, task_id TEXT, local_file TEXT, error TEXT)')
    db.execute('CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, data TEXT NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS raw_materials (name TEXT PRIMARY KEY, data TEXT NOT NULL)')
    return db

class SqliteState:
    def update_task(self, task_id, state=4, progress=0, **kwargs):
        with connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT data FROM task_state WHERE id=?', (task_id,)).fetchone()
            data = json.loads(row['data']) if row else {}
            data.update(task_id=task_id, state=state, progress=min(100, int(progress)), **kwargs)
            if state == 1:
                from greenroom_delivery import freeze
                freeze(db, task_id, data)
            db.execute('INSERT OR REPLACE INTO task_state VALUES(?,?)', (task_id, json.dumps(data, ensure_ascii=False)))

    def get_task(self, task_id):
        with connect() as db:
            row = db.execute('SELECT data FROM task_state WHERE id=?', (task_id,)).fetchone()
            return json.loads(row['data']) if row else None

    def get_all_tasks(self, page=1, page_size=100):
        with connect() as db:
            total = db.execute('SELECT COUNT(*) FROM task_state').fetchone()[0]
            rows = db.execute('SELECT data FROM task_state ORDER BY rowid DESC LIMIT ? OFFSET ?', (page_size, (page-1)*page_size)).fetchall()
            return [json.loads(row['data']) for row in rows], total

    def list_task_ids(self, scan_count=100):
        with connect() as db:
            return [row['id'] for row in db.execute('SELECT id FROM task_state')]

    def patch_task(self, task_id, **kwargs):
        with connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT data FROM task_state WHERE id=?', (task_id,)).fetchone()
            if not row:
                return False
            data = json.loads(row['data'])
            data.update(**kwargs)
            db.execute('UPDATE task_state SET data=? WHERE id=?', (json.dumps(data, ensure_ascii=False), task_id))
            return True

    def delete_task(self, task_id):
        with connect() as db:
            db.execute('DELETE FROM task_state WHERE id=?', (task_id,))
            db.execute('DELETE FROM jobs WHERE id=?', (task_id,))
