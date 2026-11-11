'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { db, DB_PATH, now, localDay } = require('./db');
const weread = require('./weread');
const mail = require('./mail');
const insights = require('./insights');

const PORT = Number(process.env.PORT || 7373);
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
// 成稿目录：默认取上一层（与 01~05 目录同级，现有用法不变）；
// 独立 clone 本仓库时，可把 03-成稿 放在仓库内，或用 CONTENT_ROOT 环境变量指定。
// 这些目录只存放个人内容，不随代码上传（见 .gitignore）。
const CONTENT_ROOT = process.env.CONTENT_ROOT
  ? path.resolve(process.env.CONTENT_ROOT)
  : (fs.existsSync(path.join(__dirname, '..', '03-成稿')) ? path.join(__dirname, '..') : __dirname);
const TYPES = ['inbox', 'reading', 'material', 'idea', 'reference', 'character', 'scene', 'other'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function send(res, code, payload, mime) {
  res.writeHead(code, { 'Content-Type': mime || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(Buffer.isBuffer(payload) || typeof payload === 'string' ? payload : JSON.stringify(payload));
}
const ok = (res, data) => send(res, 200, data === undefined ? { ok: true } : data);
const fail = (res, e) => send(res, 400, { error: String((e && e.message) || e) });

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法的 JSON')); }
    });
    req.on('error', reject);
  });
}

function patch(table, id, data, fields) {
  const keys = fields.filter(k => Object.prototype.hasOwnProperty.call(data, k));
  if (!keys.length) return false;
  const sets = keys.map(k => k + '=?').join(',');
  const args = keys.map(k => (data[k] === undefined ? null : data[k]));
  db.prepare('UPDATE ' + table + ' SET ' + sets + ', updated_at=? WHERE id=?').run(...args, now(), Number(id));
  return true;
}

function parseCapture(raw) {
  const tags = [], sources = [];
  let workTitle = '';
  const text = raw
    .replace(/#([^\s#@^]+)/g, (_, v) => { tags.push(v); return ''; })
    .replace(/@([^\s#@^]+)/g, (_, v) => { workTitle = v; return ''; })
    .replace(/\^([^\s#@^]+)/g, (_, v) => { sources.push(v); return ''; });
  return { content: text.trim(), tags: tags.join(','), source: sources.join(' '), workTitle };
}

function cardView(c) {
  const ids = c.work_ids === undefined || c.work_ids === null
    ? db.prepare('SELECT work_id FROM links WHERE card_id=?').all(c.id).map(x => x.work_id)
    : String(c.work_ids).split(',').filter(Boolean).map(Number);
  return { ...c, work_ids: ids };
}

function listCards(params) {
  let sql = 'SELECT c.*, (SELECT group_concat(l.work_id) FROM links l WHERE l.card_id=c.id) AS work_ids FROM cards c WHERE 1=1';
  const args = [];
  const q = (params.get('q') || '').trim();
  if (q) { sql += ' AND (c.content LIKE ? OR c.source LIKE ? OR c.tags LIKE ?)'; args.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
  const type = params.get('type');
  if (type && TYPES.includes(type)) { sql += ' AND c.type=?'; args.push(type); }
  const tag = (params.get('tag') || '').trim();
  if (tag) { sql += " AND (',' || c.tags || ',') LIKE ?"; args.push('%,' + tag + ',%'); }
  const work = params.get('work');
  if (work) { sql += ' AND EXISTS (SELECT 1 FROM links l WHERE l.card_id=c.id AND l.work_id=?)'; args.push(Number(work)); }
  if (params.get('unlinked') === '1') { sql += ' AND NOT EXISTS (SELECT 1 FROM links l WHERE l.card_id=c.id)'; }
  sql += ' ORDER BY c.created_at DESC, c.id DESC LIMIT ?';
  args.push(Math.min(1000, Math.max(1, Number(params.get('limit') || 300))));
  return db.prepare(sql).all(...args).map(cardView);
}

// ── 写作台：字数、进度与码字日志 ──────────────────────────────
const wordCount = s => String(s || '').replace(/\s/g, '').length;

function dayBefore(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(y, m - 1, d - n);
  const p = x => String(x).padStart(2, '0');
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
}

function workProgress(workId, work) {
  const rows = db.prepare('SELECT id,kind,content,status FROM drafts WHERE work_id=?').all(workId);
  const chapters = rows.filter(r => r.kind === 'chapter');
  const versions = rows.filter(r => r.kind !== 'chapter');
  // 有章节时只按章节计总字数，避免与整稿版本重复计数
  const source = chapters.length ? chapters : versions;
  const words = source.reduce((n, r) => n + wordCount(r.content), 0);
  const logs = new Map(db.prepare('SELECT day,words FROM word_log WHERE work_id=?').all(workId)
    .map(r => [r.day, Number(r.words) || 0]));
  const today = localDay();
  const recent = [];
  for (let i = 13; i >= 0; i--) {
    const day = dayBefore(today, i);
    recent.push({ day, words: logs.get(day) || 0 });
  }
  let streak = 0;
  // 今天还没动笔不算断，从昨天开始数连续记录日
  let cursor = (logs.get(today) || 0) > 0 ? 0 : 1;
  for (; cursor < 400; cursor++) {
    const v = logs.get(dayBefore(today, cursor)) || 0;
    if (v > 0) streak++;
    else if (cursor > 0 || (logs.get(today) || 0) === 0) break;
  }
  const byStatus = { idea: 0, draft: 0, revising: 0, done: 0 };
  for (const c of chapters) if (byStatus[c.status] !== undefined) byStatus[c.status]++;
  return {
    target: Number(work.target_words) || 0,
    words,
    chapter_count: chapters.length,
    version_count: versions.length,
    today_words: logs.get(today) || 0,
    streak,
    recent,
    byStatus,
    pct: Number(work.target_words) > 0 ? Math.min(100, Math.round(words / Number(work.target_words) * 100)) : 0
  };
}

function ensureWork(title) {
  const found = db.prepare('SELECT id FROM works WHERE title=?').get(title);
  if (found) return Number(found.id);
  const t = now();
  const info = db.prepare('INSERT INTO works (title,genre,logline,status,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(title, '', '', 'idea', t, t);
  return Number(info.lastInsertRowid);
}

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, pattern, fn });

route('GET', /^\/api\/stats$/, ({ res }) => {
  const one = sql => db.prepare(sql).get().n;
  const today = now().slice(0, 10);
  ok(res, {
    cards: one('SELECT COUNT(*) n FROM cards'),
    works: one('SELECT COUNT(*) n FROM works'),
    drafts: one('SELECT COUNT(*) n FROM drafts'),
    today: db.prepare('SELECT COUNT(*) n FROM cards WHERE substr(created_at,1,10)=?').get(today).n,
    inbox: db.prepare('SELECT COUNT(*) n FROM cards WHERE type=?').get('inbox').n,
    unlinked: one('SELECT COUNT(*) n FROM cards c WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.card_id=c.id)'),
    db: DB_PATH
  });
});

route('GET', /^\/api\/insights$/, ({ res, url }) =>
  ok(res, insights.compute({ range: url.searchParams.get('range') || 'all' })));
route('GET', /^\/api\/insights\/report$/, ({ res, url }) =>
  send(res, 200, insights.report({ range: url.searchParams.get('range') || 'all' }), 'text/markdown; charset=utf-8'));

route('GET', /^\/api\/tags$/, ({ res }) => {
  const counts = new Map();
  for (const row of db.prepare('SELECT tags FROM cards').all()) {
    for (const t of String(row.tags || '').split(',').map(s => s.trim()).filter(Boolean)) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  ok(res, [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count));
});

route('GET', /^\/api\/cards$/, ({ res, url }) => ok(res, listCards(url.searchParams)));

route('POST', /^\/api\/cards$/, ({ res, body }) => {
  const raw = String(body.content || '').trim();
  if (!raw) return fail(res, '内容不能为空');
  const p = parseCapture(raw);
  const content = p.content || raw;
  const type = TYPES.includes(body.type) ? body.type : 'inbox';
  const tags = String(body.tags || p.tags || '').split(/[,，]/).map(s => s.trim()).filter(Boolean).join(',');
  const source = String(body.source || p.source || '').trim();
  const t = now();
  const info = db.prepare('INSERT INTO cards (content,type,source,tags,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(content, type, source, tags, t, t);
  const id = Number(info.lastInsertRowid);
  let workId = body.work_id ? Number(body.work_id) : null;
  if (!workId && (p.workTitle || body.workTitle)) workId = ensureWork(String(p.workTitle || body.workTitle));
  if (workId) db.prepare('INSERT OR IGNORE INTO links (card_id,work_id,slot,created_at) VALUES (?,?,?,?)').run(id, workId, '', t);
  ok(res, cardView(db.prepare('SELECT * FROM cards WHERE id=?').get(id)));
});

route('PATCH', /^\/api\/cards\/(\d+)$/, ({ res, body, params }) => {
  const data = { ...body };
  if (data.tags !== undefined) data.tags = String(data.tags).split(/[,，]/).map(s => s.trim()).filter(Boolean).join(',');
  patch('cards', params[0], data, ['content', 'type', 'source', 'tags']);
  ok(res, cardView(db.prepare('SELECT * FROM cards WHERE id=?').get(Number(params[0]))));
});

route('DELETE', /^\/api\/cards\/(\d+)$/, ({ res, params }) => {
  db.prepare('DELETE FROM cards WHERE id=?').run(Number(params[0]));
  ok(res);
});

route('POST', /^\/api\/cards\/(\d+)\/link$/, ({ res, body, params }) => {
  db.prepare('INSERT OR IGNORE INTO links (card_id,work_id,slot,created_at) VALUES (?,?,?,?)')
    .run(Number(params[0]), Number(body.work_id), String(body.slot || ''), now());
  ok(res);
});

route('DELETE', /^\/api\/cards\/(\d+)\/link$/, ({ res, body, params }) => {
  db.prepare('DELETE FROM links WHERE card_id=? AND work_id=? AND slot=?')
    .run(Number(params[0]), Number(body.work_id), String(body.slot || ''));
  ok(res);
});

route('GET', /^\/api\/review$/, ({ res, url }) => {
  const n = Math.min(20, Math.max(1, Number(url.searchParams.get('n') || 3)));
  ok(res, db.prepare('SELECT * FROM cards ORDER BY RANDOM() LIMIT ?').all(n).map(cardView));
});

route('GET', /^\/api\/works$/, ({ res }) => {
  const list = db.prepare(`SELECT w.*,
    (SELECT COUNT(*) FROM links l WHERE l.work_id=w.id) card_count,
    (SELECT COUNT(*) FROM drafts d WHERE d.work_id=w.id) draft_count,
    (SELECT COUNT(*) FROM characters ch WHERE ch.work_id=w.id) character_count
    FROM works w ORDER BY w.updated_at DESC`).all();
  ok(res, list.map(w => {
    const p = workProgress(w.id, w);
    return { ...w, word_count: p.words, chapter_count: p.chapter_count, pct: p.pct };
  }));
});

route('POST', /^\/api\/works$/, ({ res, body }) => {
  const title = String(body.title || '').trim();
  if (!title) return fail(res, '作品名不能为空');
  const t = now();
  const info = db.prepare('INSERT INTO works (title,genre,logline,status,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(title, body.genre || '', body.logline || '', body.status || 'idea', t, t);
  ok(res, db.prepare('SELECT * FROM works WHERE id=?').get(Number(info.lastInsertRowid)));
});

route('GET', /^\/api\/works\/(\d+)$/, ({ res, params }) => {
  const id = Number(params[0]);
  const work = db.prepare('SELECT * FROM works WHERE id=?').get(id);
  if (!work) return fail(res, '作品不存在');
  const drafts = db.prepare('SELECT * FROM drafts WHERE work_id=? ORDER BY sort_order,id').all(id);
  ok(res, {
    work,
    outline: db.prepare('SELECT * FROM outline WHERE work_id=? ORDER BY sort_order,id').all(id),
    characters: db.prepare('SELECT * FROM characters WHERE work_id=? ORDER BY id').all(id),
    drafts,
    chapters: drafts.filter(x => x.kind === 'chapter'),
    versions: drafts.filter(x => x.kind !== 'chapter').sort((a, b) => b.version - a.version),
    cards: db.prepare('SELECT c.*, l.slot FROM links l JOIN cards c ON c.id=l.card_id WHERE l.work_id=? ORDER BY l.created_at DESC').all(id),
    progress: workProgress(id, work)
  });
});

route('PATCH', /^\/api\/works\/(\d+)$/, ({ res, body, params }) => {
  patch('works', params[0], body, ['title', 'genre', 'logline', 'status', 'target_words']);
  const w = db.prepare('SELECT * FROM works WHERE id=?').get(Number(params[0]));
  ok(res, { ...w, progress: workProgress(w.id, w) });
});

route('DELETE', /^\/api\/works\/(\d+)$/, ({ res, params }) => {
  db.prepare('DELETE FROM works WHERE id=?').run(Number(params[0]));
  ok(res);
});

const child = (table, fields) => {
  route('POST', new RegExp('^/api/works/(\\d+)/' + table + '$'), ({ res, body, params }) => {
    const t = now(), workId = Number(params[0]);
    const cols = ['work_id', ...fields, 'updated_at'];
    const vals = [workId, ...fields.map(f => (body[f] === undefined ? '' : body[f])), t];
    const info = db.prepare('INSERT INTO ' + table + ' (' + cols.join(',') + ') VALUES (' + cols.map(() => '?').join(',') + ')').run(...vals);
    ok(res, db.prepare('SELECT * FROM ' + table + ' WHERE id=?').get(Number(info.lastInsertRowid)));
  });
  route('PATCH', new RegExp('^/api/' + table + '/(\\d+)$'), ({ res, body, params }) => {
    patch(table, params[0], body, fields);
    ok(res, db.prepare('SELECT * FROM ' + table + ' WHERE id=?').get(Number(params[0])));
  });
  route('DELETE', new RegExp('^/api/' + table + '/(\\d+)$'), ({ res, params }) => {
    db.prepare('DELETE FROM ' + table + ' WHERE id=?').run(Number(params[0]));
    ok(res);
  });
};
child('outline', ['parent_id', 'title', 'note', 'sort_order']);
child('characters', ['name', 'desire', 'fear', 'secret', 'phrase', 'relations', 'arc', 'note']);
child('drafts', ['version', 'title', 'content', 'kind', 'sort_order', 'status', 'synopsis']);

// 写作台自动保存：一次请求完成「存正文 + 记今日净增字数」，避免编辑器重绘丢光标
route('POST', /^\/api\/drafts\/(\d+)\/save$/, ({ res, body, params }) => {
  const id = Number(params[0]);
  const row = db.prepare('SELECT * FROM drafts WHERE id=?').get(id);
  if (!row) return fail(res, '这一节不存在');
  const content = body.content === undefined ? row.content : String(body.content);
  const title = body.title === undefined ? row.title : String(body.title);
  const synopsis = body.synopsis === undefined ? (row.synopsis || '') : String(body.synopsis);
  const delta = wordCount(content) - wordCount(row.content);
  const t = now();
  db.prepare('UPDATE drafts SET content=?,title=?,synopsis=?,updated_at=? WHERE id=?')
    .run(content, title, synopsis, t, id);
  if (delta !== 0) {
    const day = localDay();
    db.prepare(`INSERT INTO word_log (work_id,day,words,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(work_id,day) DO UPDATE SET words=words+excluded.words, updated_at=excluded.updated_at`)
      .run(row.work_id, day, delta, t);
    db.prepare('UPDATE works SET updated_at=? WHERE id=?').run(t, row.work_id);
  }
  const log = db.prepare('SELECT words FROM word_log WHERE work_id=? AND day=?').get(row.work_id, localDay());
  ok(res, {
    id, ok: true, words: wordCount(content), delta, saved_at: t,
    today_words: log ? Number(log.words) : 0
  });
});

// 按章节顺序导出全书 Markdown（没有章节时导出整稿）
route('GET', /^\/api\/works\/(\d+)\/export\.md$/, ({ res, params }) => {
  const id = Number(params[0]);
  const w = db.prepare('SELECT * FROM works WHERE id=?').get(id);
  if (!w) return fail(res, '作品不存在');
  const all = db.prepare('SELECT * FROM drafts WHERE work_id=? ORDER BY sort_order,id').all(id);
  const chapters = all.filter(x => x.kind === 'chapter');
  const source = chapters.length ? chapters : all.filter(x => x.kind !== 'chapter').slice(0, 1);
  const lines = ['# ' + w.title, ''];
  if (w.genre || w.status) lines.push('> ' + [w.genre, ({ idea: '构思', outlining: '搭大纲', drafting: '写草稿', done: '已成稿' })[w.status]].filter(Boolean).join(' · '), '');
  if (w.logline) lines.push('> ' + w.logline, '');
  lines.push('---', '');
  for (const c of source) {
    if (chapters.length) lines.push('## ' + (c.title || '未命名章节'), '');
    if (String(c.content || '').trim()) lines.push(String(c.content).trim(), '');
  }
  lines.push('---', '', '_导出自创作台 · ' + now().slice(0, 10) + ' · 共 ' + wordCount(source.map(x => x.content).join('')) + ' 字_', '');
  send(res, 200, lines.join('\n'), 'text/markdown; charset=utf-8');
});

route('GET', /^\/api\/export$/, ({ res }) => {
  const tables = ['cards', 'links', 'works', 'outline', 'characters', 'drafts', 'word_log'];
  const dump = { exported_at: now(), version: 1 };
  for (const t of tables) dump[t] = db.prepare('SELECT * FROM ' + t).all();
  ok(res, dump);
});

route('POST', /^\/api\/import$/, ({ res, body }) => {
  let cards = 0, works = 0;
  const t = now();
  for (const w of (Array.isArray(body.works) ? body.works : [])) {
    db.prepare('INSERT INTO works (title,genre,logline,status,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(String(w.title || '未命名'), w.genre || '', w.logline || '', w.status || 'idea', w.created_at || t, t);
    works++;
  }
  for (const c of (Array.isArray(body.cards) ? body.cards : [])) {
    if (!c.content) continue;
    db.prepare('INSERT INTO cards (content,type,source,tags,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(String(c.content), c.type || 'inbox', c.source || '', c.tags || '', c.created_at || t, t);
    cards++;
  }
  ok(res, { cards, works, note: '已合并追加；原有数据未改动，关联关系未导入' });
});

route('POST', /^\/api\/scan-local$/, ({ res }) => {
  const dir = path.join(CONTENT_ROOT, '03-成稿');
  if (!fs.existsSync(dir)) return ok(res, { added: 0, message: '未找到 03-成稿 目录' });
  let added = 0;
  for (const f of fs.readdirSync(dir).filter(x => x.toLowerCase().endsWith('.md'))) {
    const title = f.replace(/\.md$/i, '');
    if (db.prepare('SELECT id FROM works WHERE title=?').get(title)) continue;
    const content = fs.readFileSync(path.join(dir, f), 'utf8');
    const t = now();
    const info = db.prepare('INSERT INTO works (title,genre,logline,status,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(title, '短篇小说', '', 'done', t, t);
    db.prepare('INSERT INTO drafts (work_id,version,title,content,updated_at) VALUES (?,?,?,?,?)')
      .run(Number(info.lastInsertRowid), 1, '正文', content, t);
    added++;
  }
  ok(res, { added, dir });
});

route('GET', /^\/api\/weread\/status$/, ({ res }) => ok(res, weread.status()));
route('POST', /^\/api\/weread\/config$/, ({ res, body }) => ok(res, weread.saveConfig(body.api_key)));
route('POST', /^\/api\/weread\/test$/, async ({ res }) => ok(res, await weread.testConnection()));
route('GET', /^\/api\/weread\/books$/, async ({ res }) => ok(res, await weread.listBooks()));
route('POST', /^\/api\/weread\/sync$/, async ({ res, body }) => ok(res, await weread.sync(body || {})));
route('POST', /^\/api\/weread\/ideas$/, async ({ res, body }) => ok(res, await weread.syncIdeas(body || {})));
route('POST', /^\/api\/weread\/paste$/, ({ res, body }) => ok(res, weread.pasteImport(body || {})));

route('GET', /^\/api\/mail\/status$/, ({ res }) => ok(res, mail.status()));
route('POST', /^\/api\/mail\/config$/, ({ res, body }) => ok(res, mail.saveConfig(body || {})));
route('POST', /^\/api\/mail\/test$/, async ({ res }) => ok(res, await mail.testConnection()));
route('POST', /^\/api\/mail\/sync$/, async ({ res, body }) => ok(res, await mail.sync(body || {})));
route('POST', /^\/api\/mail\/paste$/, ({ res, body }) => ok(res, mail.pasteImport(body || {})));

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://' + HOST + ':' + PORT);
    if (url.pathname.startsWith('/api/')) {
      const body = await parseBody(req);
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.pattern);
        if (m) return await r.fn({ req, res, url, body, params: m.slice(1).map(decodeURIComponent) });
      }
      return fail(res, '未知接口: ' + req.method + ' ' + url.pathname);
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    const root = path.resolve(PUBLIC_DIR);
    if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    return fail(res, e);
  }
});

server.listen(PORT, HOST, () => {
  console.log('创作台已启动: http://' + HOST + ':' + PORT);
  console.log('数据库: ' + DB_PATH);
});
