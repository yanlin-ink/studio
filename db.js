'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'studio.db');

const db = new DatabaseSync(DB_PATH);
try { db.prepare('PRAGMA journal_mode = WAL').run(); } catch (_) {}
db.exec('PRAGMA foreign_keys = ON;');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// 兼容旧库：external_id 用于外部来源去重（微信读书同步、粘贴导入）
const cardCols = db.prepare('PRAGMA table_info(cards)').all().map(c => c.name);
if (!cardCols.includes('external_id')) {
  db.exec("ALTER TABLE cards ADD COLUMN external_id TEXT NOT NULL DEFAULT ''");
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_external ON cards(external_id) WHERE external_id <> ''");

// 兼容旧库：写作台所需的新列。逐列检查，已存在的库平滑跳过，不改动任何原有数据。
function addColumn(table, column, ddl) {
  const cols = db.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name);
  if (!cols.includes(column)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl);
}
addColumn('works', 'target_words', 'target_words INTEGER NOT NULL DEFAULT 0');
addColumn('drafts', 'kind', "kind TEXT NOT NULL DEFAULT 'version'");
addColumn('drafts', 'sort_order', 'sort_order INTEGER NOT NULL DEFAULT 0');
addColumn('drafts', 'status', "status TEXT NOT NULL DEFAULT 'draft'");
addColumn('drafts', 'synopsis', "synopsis TEXT NOT NULL DEFAULT ''");

// 引用新列的索引必须等迁移完成后再建
db.exec('CREATE INDEX IF NOT EXISTS idx_drafts_work_kind ON drafts(work_id, kind, sort_order)');

const now = () => new Date().toISOString();
// 本地日期（YYYY-MM-DD），用于码字日志；不能用 UTC，否则东八区会错一天
const localDay = () => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};

module.exports = { db, DB_PATH, now, localDay };
