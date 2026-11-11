CREATE TABLE IF NOT EXISTS cards (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  content      TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'inbox',
  source       TEXT NOT NULL DEFAULT '',
  tags         TEXT NOT NULL DEFAULT '',
  external_id  TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_type ON cards(type);
CREATE INDEX IF NOT EXISTS idx_cards_created ON cards(created_at DESC);

CREATE TABLE IF NOT EXISTS works (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  genre         TEXT NOT NULL DEFAULT '',
  logline       TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'idea',
  target_words  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS links (
  card_id     INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  work_id     INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  slot        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  PRIMARY KEY (card_id, work_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_links_work ON links(work_id);

CREATE TABLE IF NOT EXISTS outline (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id     INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  parent_id   INTEGER,
  title       TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS characters (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id     INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  desire      TEXT NOT NULL DEFAULT '',
  fear        TEXT NOT NULL DEFAULT '',
  secret      TEXT NOT NULL DEFAULT '',
  phrase      TEXT NOT NULL DEFAULT '',
  relations   TEXT NOT NULL DEFAULT '',
  arc         TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id     INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL DEFAULT 1,
  title       TEXT NOT NULL DEFAULT '',
  content     TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'version',   -- chapter=章节 / version=整稿版本
  sort_order  INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'draft',    -- idea / draft / revising / done
  synopsis    TEXT NOT NULL DEFAULT '',         -- 本章要发生什么
  updated_at  TEXT NOT NULL
);
-- 注意：引用新增列的索引在 db.js 迁移完成后创建（旧库此时还没有这些列）

-- 每日净增字数：自动保存时按差值记账，用于写作进度与码字节律
CREATE TABLE IF NOT EXISTS word_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id     INTEGER NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  day         TEXT NOT NULL,
  words       INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  UNIQUE(work_id, day)
);
