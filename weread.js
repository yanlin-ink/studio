'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, now } = require('./db');

const GATEWAY = 'https://i.weread.qq.com/api/agent/gateway';
const SKILL_VERSION = '1.0.5';
const CONFIG_PATH = path.join(__dirname, 'data', 'weread-config.json');
const KEY_PAGE = 'https://weread.qq.com/r/weread-skills';

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { return {}; }
}
function apiKey() { return String(readConfig().api_key || '').trim(); }
function status() {
  const k = apiKey();
  return { configured: !!k, keyHint: k ? k.slice(0, 7) + '…' + k.slice(-4) : '', keyPage: KEY_PAGE };
}
function saveConfig(key) {
  const k = String(key || '').trim();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ api_key: k, updated_at: now() }, null, 2), 'utf8');
  return status();
}

async function gateway(apiName, params = {}) {
  const k = apiKey();
  if (!k) throw new Error('还没有配置微信读书 API Key');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let res;
  try {
    res = await fetch(GATEWAY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + k },
      body: JSON.stringify({ api_name: apiName, skill_version: SKILL_VERSION, ...params }),
      signal: ctrl.signal
    });
  } catch (e) {
    throw new Error('连接微信读书失败：' + (e.name === 'AbortError' ? '请求超时' : e.message));
  } finally { clearTimeout(timer); }

  let data;
  try { data = await res.json(); }
  catch (_) { throw new Error('微信读书返回了非 JSON 内容（HTTP ' + res.status + '）'); }
  if (!res.ok) throw new Error('微信读书接口错误 ' + res.status + '：' + (data.errmsg || data.errlog || '鉴权失败，请检查 API Key'));
  if (data.upgrade_info) throw new Error('微信读书 Skill 需要升级：' + (data.upgrade_info.message || '请重新下载官方技能包'));
  if (data.errcode && Number(data.errcode) !== 0) throw new Error('微信读书返回错误：' + (data.errmsg || data.errcode));
  return data;
}

function tsToIso(t) {
  const n = Number(t || 0);
  if (!n) return now();
  const ms = n < 1e12 ? n * 1000 : n;
  try { return new Date(ms).toISOString(); } catch (_) { return now(); }
}
const delay = ms => new Promise(r => setTimeout(r, ms));
const asArray = v => Array.isArray(v) ? v : [];

async function listBooks() {
  const books = [];
  let lastSort;
  for (let page = 0; page < 50; page++) {
    const params = { count: 100 };
    if (lastSort !== undefined) params.lastSort = lastSort;
    const d = await gateway('/user/notebooks', params);
    const arr = asArray(d.books);
    for (const b of arr) {
      books.push({
        bookId: String(b.bookId || ''),
        title: (b.book && b.book.title) || '未命名书籍',
        author: (b.book && b.book.author) || '',
        noteCount: Number(b.noteCount || 0),
        reviewCount: Number(b.reviewCount || 0),
        bookmarkCount: Number(b.bookmarkCount || 0),
        sort: b.sort
      });
    }
    if (String(d.hasMore) === '1' && arr.length && arr[arr.length - 1].sort !== undefined) {
      lastSort = arr[arr.length - 1].sort;
    } else break;
  }
  return books;
}

async function fetchBookNotes(book, diag) {
  const items = [];
  const chapterMap = new Map();

  const hl = await gateway('/book/bookmarklist', { bookId: book.bookId });
  for (const c of asArray(hl.chapters)) chapterMap.set(String(c.chapterUid), c.title || '');
  for (const u of asArray(hl.updated)) {
    const text = String(u.markText || '').trim();
    if (!text) continue;
    items.push({
      external_id: 'weread:hl:' + u.bookmarkId,
      content: text,
      chapter: chapterMap.get(String(u.chapterUid)) || '',
      kind: 'highlight',
      created_at: tsToIso(u.createTime)
    });
  }

  // 官方回包的 hasMore / synckey 在单页装不下时不可靠：实测某书 totalCount=110，
  // count=100 只回 100 条且 hasMore=0，拿 synckey 翻页返回 0 条；
  // 但把 count 调大即可一次拿全（count=200 返回 110 条）。
  // 所以先按较大的 count 请求，仍不足则按 totalCount 再要一次。
  const base = { bookid: book.bookId, synckey: 0 };
  let d = await gateway('/review/list/mine', { ...base, count: 300 });
  let arr = asArray(d.reviews);
  const total = Number(d.totalCount || 0);
  if (total > arr.length) {
    const retry = await gateway('/review/list/mine', { ...base, count: total + 50 });
    const arr2 = asArray(retry.reviews);
    if (arr2.length > arr.length) arr = arr2;
  }
  if (diag) diag.totalReviews += arr.length;

  for (const r of arr) {
    const v = r.review || r;
    const at = tsToIso(v.createTime);
    const priv = v.isPrivate === true || Number(v.isPrivate) === 1;
    if (diag) {
      if (at > diag.latestIdeaAt) diag.latestIdeaAt = at;
      if (priv) diag.privateAll++;
    }
    let idea = String(v.content || '').trim();
    if (!idea) idea = String(v.htmlContent || '').replace(/<[^>]+>/g, '').trim();
    const abstract = String(v.abstract || '').trim();
    if (!idea && !abstract) continue;   // 纯评分等无正文条目，没有可存的内容
    const rid = v.reviewId || r.reviewId || (v.range || '') + ':' + idea.slice(0, 20);
    items.push({
      external_id: 'weread:rv:' + rid,
      content: abstract ? '【划线】' + abstract + '\n\n【我的想法】' + idea : idea,
      raw_content: idea,
      is_private: priv,
      chapter: v.chapterName || chapterMap.get(String(v.chapterUid)) || '',
      kind: 'review',
      created_at: at
    });
  }
  return items;
}

function buildCard(it, book) {
  const title = String(book.title || '微信读书导入');
  const tagTitle = title.replace(/[,，]/g, ' ');
  return {
    external_id: it.external_id,
    content: it.content,
    type: 'reading',
    source: '《' + title + '》' + (it.chapter ? ' · ' + it.chapter : ''),
    tags: ['微信读书', it.kind === 'review' ? '想法' : '划线', tagTitle].join(','),
    created_at: it.created_at || now(),
    updated_at: now()
  };
}

function dedupeStats(cards) {
  const existing = new Set(db.prepare("SELECT external_id FROM cards WHERE external_id <> ''").all().map(r => r.external_id));
  return cards.filter(c => !existing.has(c.external_id));
}

function insertCards(cards) {
  const stmt = db.prepare('INSERT OR IGNORE INTO cards (external_id,content,type,source,tags,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
  let added = 0, skipped = 0;
  const samples = [];
  for (const c of cards) {
    const info = stmt.run(c.external_id, c.content, c.type, c.source, c.tags, c.created_at, c.updated_at);
    if (Number(info.changes) > 0) { added++; if (samples.length < 5) samples.push(c); }
    else skipped++;
  }
  return { added, skipped, samples };
}

async function testConnection() {
  const d = await gateway('/user/notebooks', { count: 1 });
  return { ok: true, totalBookCount: d.totalBookCount, totalNoteCount: d.totalNoteCount };
}

async function sync(options = {}) {
  const all = await listBooks();
  const ids = asArray(options.bookIds).map(String);
  const wanted = (!ids.length || ids.includes('all')) ? all : all.filter(b => ids.includes(b.bookId));
  if (!wanted.length) return { books: 0, cards: 0, added: 0, skipped: 0, samples: [], dryRun: !!options.dryRun };
  const cards = [];
  for (const b of wanted) {
    for (const it of await fetchBookNotes(b)) cards.push(buildCard(it, b));
    await delay(120);
  }
  if (options.dryRun) {
    const fresh = dedupeStats(cards);
    return {
      books: wanted.length, cards: cards.length, added: fresh.length,
      skipped: cards.length - fresh.length, samples: fresh.slice(0, 5), dryRun: true
    };
  }
  return { books: wanted.length, cards: cards.length, ...insertCards(cards), dryRun: false };
}

// 把微信读书当成手机随手记入口：只挑带标记词的个人想法，落成「小说思路」卡片。
// external_id 复用常规同步的 weread:rv: 前缀，同一条想法不会被导入两次。
async function syncIdeas(options = {}) {
  const marker = String(options.marker || '#记').trim();
  const modes = ['private', 'marker', 'private+marker', 'all'];
  const mode = modes.includes(options.mode) ? options.mode : 'private+marker';
  const type = options.type || 'idea';
  const all = await listBooks();
  const ids = asArray(options.bookIds).map(String);
  const picked = (!ids.length || ids.includes('all')) ? all : all.filter(b => ids.includes(b.bookId));
  // 只查确实有想法/点评的书，避免逐本空跑
  const wanted = picked.filter(b => Number(b.reviewCount || 0) > 0).slice(0, 300);

  const diag = { mode, books: wanted.length, totalReviews: 0, scanned: 0, privateCount: 0, privateAll: 0, latestIdeaAt: '', marker };
  const empty = { ...diag, matched: 0, added: 0, skipped: 0, samples: [], hint: '微信读书官方接口里没有查到带笔记的书。', dryRun: !!options.dryRun };
  if (!wanted.length) return empty;

  const cards = [];
  for (const b of wanted) {
    for (const it of await fetchBookNotes(b, diag)) {
      if (it.kind !== 'review') continue;
      diag.scanned++;
      if (it.is_private) diag.privateCount++;

      const raw = String(it.raw_content || it.content);
      const byMarker = !!marker && raw.includes(marker);
      const byPrivate = it.is_private;
      const hit = mode === 'all' ? true
        : mode === 'private' ? byPrivate
          : mode === 'marker' ? byMarker
            : (byPrivate || byMarker);
      if (!hit) continue;

      const title = String(b.title || '微信读书');
      const content = (byMarker ? String(it.content).replace(marker, '').trim() : String(it.content).trim()) || raw;
      if (!content) continue;
      // 独立命名空间：同一条想法可以同时作为「读书卡片」和「随手记卡片」存在，
      // 否则已被常规同步导入的想法会被去重逻辑吃掉，表现为「同步了 0 条」。
      cards.push({
        external_id: 'weread:idea:' + String(it.external_id).replace(/^weread:rv:/, ''),
        content,
        type,
        source: '微信读书想法 · 《' + title + '》' + (it.chapter ? ' · ' + it.chapter : ''),
        tags: ['微信读书想法', '随手记', it.is_private ? '私密' : '公开', title.replace(/[,，]/g, ' ')].join(','),
        created_at: it.created_at || now(),
        updated_at: now()
      });
    }
    await delay(100);
  }

  // 官方 Agent API 只暴露「按书查的个人想法/点评」，不返回独立发布的帖子/动态。
  // 把最新想法时间回传，方便一眼判断是筛选太严，还是官方接口里根本没有新内容。
  const latest = diag.latestIdeaAt ? diag.latestIdeaAt.slice(0, 10) : '无';
  const hint = cards.length ? '' :
    '官方接口里最新一条想法是 ' + latest + '。如果发的是「独立帖子 / 动态」而不是书里的想法，官方接口不返回帖子内容，请用第 3 块粘贴导入。';
  const base = { ...diag, matched: cards.length, hint };
  if (options.dryRun) {
    const fresh = dedupeStats(cards);
    return { ...base, added: fresh.length, skipped: cards.length - fresh.length, samples: fresh.slice(0, 5), dryRun: true };
  }
  return { ...base, ...insertCards(cards), dryRun: false };
}

// 兜底：解析从 App / 网页版复制出来的笔记文本
function parsePasted(text, fallbackBook) {
  const lines = String(text || '').split(/\r?\n/);
  let book = String(fallbackBook || '').trim();
  let chapter = '', justGotBook = false;
  const items = [];
  let buffer = [];
  const flush = () => {
    const c = buffer.join('\n').trim();
    buffer = [];
    if (c) items.push({ kind: 'highlight', content: c, chapter });
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); justGotBook = false; continue; }
    const bm = line.match(/^《(.+?)》/);
    if (bm && !book) { book = bm[1]; justGotBook = true; continue; }
    if (justGotBook && line.length < 30 && !/[。！？，、；：]/.test(line)) { justGotBook = false; continue; }
    justGotBook = false;
    const h = line.match(/^#{1,3}\s+(.*)$/);
    if (h) {
      flush();
      if (!book) book = h[1].replace(/[《》]/g, '');
      else chapter = h[1];
      continue;
    }
    if (line.length < 40 && /^(第.{1,10}[章节篇部]|Chapter\s*\d+|[一二三四五六七八九十]+、|\d+[.、]\s*\S)/.test(line)) {
      flush(); chapter = line; continue;
    }
    const idea = line.match(/^(?:想法|我的想法|批注|笔记|书评|点评|※|\/\/)[:：]?\s*(.*)$/);
    if (idea && idea[1]) { flush(); items.push({ kind: 'review', content: idea[1], chapter }); continue; }
    const mark = line.match(/^(?:◆|>|【划线】|【原文】|▍|·)\s*(.*)$/);
    if (mark) { flush(); if (mark[1]) items.push({ kind: 'highlight', content: mark[1], chapter }); continue; }
    if (/^[-=*]{3,}$/.test(line)) { flush(); continue; }
    buffer.push(line);
  }
  flush();
  return { book, items };
}

function pasteImport(options = {}) {
  const parsed = parsePasted(options.text, options.book);
  const bookTitle = parsed.book || '微信读书导入';
  const cards = parsed.items.map((it, i) => {
    const hash = crypto.createHash('sha1')
      .update(bookTitle + '|' + it.chapter + '|' + it.content + '|' + i)
      .digest('hex').slice(0, 16);
    return buildCard({
      external_id: 'weread:paste:' + hash, content: it.content,
      chapter: it.chapter, kind: it.kind, created_at: now()
    }, { title: bookTitle });
  });
  if (options.dryRun) {
    const fresh = dedupeStats(cards);
    return {
      book: bookTitle, cards: cards.length, added: fresh.length,
      skipped: cards.length - fresh.length, samples: fresh.slice(0, 5), dryRun: true
    };
  }
  return { book: bookTitle, cards: cards.length, ...insertCards(cards), dryRun: false };
}

module.exports = { status, saveConfig, testConnection, listBooks, sync, syncIdeas, pasteImport, parsePasted };
