'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, now } = require('./db');

const CONFIG_PATH = path.join(__dirname, 'data', 'mail-config.json');

const PRESETS = [
  { key: 'qq', label: 'QQ 邮箱', host: 'imap.qq.com', port: 993,
    help: '网页版 mail.qq.com → 设置 → 账号与安全 → 开启 IMAP/SMTP → 短信验证后拿到 16 位授权码（不是 QQ 密码）' },
  { key: '163', label: '163 邮箱', host: 'imap.163.com', port: 993,
    help: '网页版 → 设置 → POP3/SMTP/IMAP → 开启服务并获取授权码' },
  { key: 'outlook', label: 'Outlook', host: 'outlook.office365.com', port: 993,
    help: '使用账户密码；若开启了两步验证，需在微软账户里生成应用专用密码' },
  { key: 'gmail', label: 'Gmail', host: 'imap.gmail.com', port: 993,
    help: '设置里开启 IMAP，并使用应用专用密码' },
  { key: 'custom', label: '自定义 IMAP', host: '', port: 993, help: '' }
];

const DEFAULTS = {
  host: 'imap.qq.com', port: 993, user: '', password: '', folder: 'INBOX',
  marker: '#记', mode: 'marker', days: 30, type: 'idea', markSeen: false
};
const TYPES = ['inbox', 'reading', 'material', 'idea', 'reference', 'character', 'scene', 'other'];

function readConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; }
  catch (_) { return { ...DEFAULTS }; }
}

function status() {
  const c = readConfig();
  let dependency = true;
  try { require('imapflow'); require('mailparser'); } catch (_) { dependency = false; }
  return {
    configured: !!(c.host && c.user && c.password),
    dependency, presets: PRESETS,
    host: c.host, port: Number(c.port) || 993, user: c.user,
    passwordHint: c.password ? c.password.slice(0, 2) + '••••' + c.password.slice(-2) : '',
    folder: c.folder, marker: c.marker, mode: c.mode,
    days: Number(c.days) || 30, type: c.type, markSeen: !!c.markSeen
  };
}

function saveConfig(input) {
  const c = { ...readConfig() };
  for (const k of ['host', 'user', 'folder', 'marker', 'mode', 'type']) {
    if (input[k] !== undefined) c[k] = String(input[k]).trim();
  }
  for (const k of ['port', 'days']) {
    if (input[k] !== undefined && String(input[k]).trim() !== '') c[k] = Number(input[k]) || DEFAULTS[k];
  }
  if (input.markSeen !== undefined) c.markSeen = !!input.markSeen;
  if (input.password !== undefined && String(input.password).trim()) c.password = String(input.password).trim();
  if (input.clearPassword) c.password = '';
  if (!TYPES.includes(c.type)) c.type = 'idea';
  if (!['marker', 'flagged', 'self'].includes(c.mode)) c.mode = 'marker';
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), 'utf8');
  return status();
}

// 与顶部捕获框一致的行内语法：#标签 @作品 ^来源
function parseInline(raw) {
  const tags = [], sources = [];
  let workTitle = '';
  const text = String(raw || '')
    .replace(/#([^\s#@^]+)/g, (_, v) => { tags.push(v); return ''; })
    .replace(/@([^\s#@^]+)/g, (_, v) => { workTitle = v; return ''; })
    .replace(/\^([^\s#@^]+)/g, (_, v) => { sources.push(v); return ''; });
  return { content: text.replace(/[ \t]{2,}/g, ' ').trim(), tags, sources, workTitle };
}

const cleanTag = t => String(t || '').replace(/[,，]/g, ' ').trim();

function buildCard(o) {
  const p = parseInline(o.content);
  const text = p.content || String(o.content || '').trim();
  if (!text) return null;
  const tags = [...(o.baseTags || ['邮件同步']), ...(o.tags || []), ...p.tags].map(cleanTag).filter(Boolean);
  return {
    external_id: o.externalId,
    content: text,
    type: TYPES.includes(o.type) ? o.type : 'idea',
    source: String(o.source || p.sources.join(' ') || '邮件同步').slice(0, 120),
    tags: [...new Set(tags)].join(','),
    workTitle: p.workTitle,
    created_at: o.createdAt || now(),
    updated_at: now()
  };
}

function existingIds(cards) {
  const seen = new Set(db.prepare("SELECT external_id FROM cards WHERE external_id <> ''").all().map(r => r.external_id));
  return cards.filter(c => !seen.has(c.external_id));
}

function insertCards(cards) {
  const stmt = db.prepare('INSERT OR IGNORE INTO cards (external_id,content,type,source,tags,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
  const findWork = db.prepare('SELECT id FROM works WHERE title=?');
  const addWork = db.prepare('INSERT INTO works (title,genre,logline,status,created_at,updated_at) VALUES (?,?,?,?,?,?)');
  const addLink = db.prepare('INSERT OR IGNORE INTO links (card_id,work_id,slot,created_at) VALUES (?,?,?,?)');
  let added = 0, skipped = 0;
  const samples = [];
  for (const c of cards) {
    const info = stmt.run(c.external_id, c.content, c.type, c.source, c.tags, c.created_at, c.updated_at);
    if (Number(info.changes) < 1) { skipped++; continue; }
    added++;
    if (samples.length < 5) samples.push({ content: c.content.slice(0, 130), source: c.source, tags: c.tags });
    if (c.workTitle) {
      let w = findWork.get(c.workTitle);
      if (!w) {
        const t = now();
        w = { id: Number(addWork.run(c.workTitle, '', '', 'idea', t, t).lastInsertRowid) };
      }
      addLink.run(Number(info.lastInsertRowid), Number(w.id), '', now());
    }
  }
  return { added, skipped, samples };
}

const isoDate = d => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : now());

function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .trim();
}

function cleanText(raw) {
  let s = String(raw || '').replace(/\r\n?/g, '\n');
  s = s.split(/\n--\s*\n/)[0];
  return s.split('\n')
    .filter(l => !/^\s*>/.test(l))
    .filter(l => !/^(发自我的 ?iPhone|发自我的 ?手机|Sent from my|从我的.*发送|在.*写道|On .*wrote:|-{2,}原始邮件)/i.test(l.trim()))
    .map(l => l.replace(/\s+$/, ''))
    .join('\n').trim();
}

async function openClient(c) {
  let ImapFlow, simpleParser;
  try {
    ({ ImapFlow } = require('imapflow'));
    ({ simpleParser } = require('mailparser'));
  } catch (_) {
    throw new Error('缺少邮件依赖：请在 studio 目录执行一次 npm install');
  }
  if (!c.host || !c.user || !c.password) throw new Error('还没配置完整：需要 IMAP 服务器、邮箱地址和授权码');
  const client = new ImapFlow({
    host: c.host, port: Number(c.port) || 993, secure: true,
    auth: { user: c.user, pass: c.password },
    logger: false,
    connectionTimeout: 20000, greetingTimeout: 20000, socketTimeout: 30000
  });
  try { await client.connect(); }
  catch (e) { throw new Error('连接邮箱失败：' + (e.message || e)); }
  return { client, simpleParser };
}

// 只扫描「自己发给自己的邮件」，避免误收他人来信
async function collect(c) {
  const { client, simpleParser } = await openClient(c);
  const items = [];
  let scanned = 0, total = 0;
  try {
    const lock = await client.getMailboxLock(c.folder || 'INBOX');
    try {
      const since = new Date(Date.now() - (Number(c.days) || 30) * 86400000);
      const uids = await client.search({ since, from: c.user }, { uid: true });
      total = (uids || []).length;
      for (const uid of (uids || []).slice(-300)) {
        const msg = await client.fetchOne(uid,
          { uid: true, flags: true, envelope: true, source: true }, { uid: true });
        if (!msg) continue;
        scanned++;
        const parsed = await simpleParser(msg.source);
        const subject = String(parsed.subject || '').trim();
        const flags = msg.flags ? [...msg.flags].map(String) : [];
        const flagged = flags.some(f => f.toLowerCase() === '\\flagged');
        const marker = String(c.marker || '').trim();
        const hasMarker = !!marker && (
          subject.toLowerCase().includes(marker.toLowerCase()) ||
          String(parsed.text || '').trim().startsWith(marker)
        );
        const matched = c.mode === 'self' ? true : (hasMarker || flagged);
        if (!matched) continue;
        const body = cleanText(parsed.text || htmlToText(parsed.html));
        const subjectClean = marker ? subject.replace(new RegExp(escapeRe(marker), 'gi'), '').trim() : subject.trim();
        const content = body || subjectClean || subject;
        if (!content) continue;
        items.push({
          externalId: 'mail:' + String(c.user).toLowerCase() + ':' + String(uid),
          content, createdAt: isoDate(parsed.date),
          source: '邮件 · ' + (subject || isoDate(parsed.date)).slice(0, 40),
          tags: [flagged ? '星标' : (hasMarker ? '标记邮件' : '自发邮件')]
        });
        if (c.markSeen) {
          try { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); } catch (_) {}
        }
      }
    } finally { lock.release(); }
  } catch (e) {
    throw new Error('读取邮件失败：' + (e.message || e));
  } finally {
    await client.logout().catch(() => {});
  }
  return { scanned, total, items };
}

const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function testConnection() {
  const c = readConfig();
  const { client } = await openClient(c);
  try {
    const lock = await client.getMailboxLock(c.folder || 'INBOX');
    let exists = 0;
    try { exists = client.mailbox ? Number(client.mailbox.exists || 0) : 0; }
    finally { lock.release(); }
    return { ok: true, folder: c.folder || 'INBOX', exists, marker: c.marker, mode: c.mode };
  } finally { await client.logout().catch(() => {}); }
}

async function sync(options = {}) {
  const c = readConfig();
  const { scanned, total, items } = await collect(c);
  const cards = items.map(it => buildCard({
    externalId: it.externalId, content: it.content, type: c.type,
    source: it.source, tags: it.tags, createdAt: it.createdAt
  })).filter(Boolean);
  if (options.dryRun) {
    const fresh = existingIds(cards);
    return {
      scanned, total, matched: cards.length, added: fresh.length,
      skipped: cards.length - fresh.length,
      samples: fresh.slice(0, 5).map(x => ({ content: x.content.slice(0, 130), source: x.source, tags: x.tags })),
      dryRun: true
    };
  }
  return { scanned, total, matched: cards.length, ...insertCards(cards), dryRun: false };
}

// 兜底：记事本 / 微信 / 备忘录复制出来的纯文本，一段或一行一条卡片
function splitPasted(text, mode = 'auto') {
  const s = String(text || '').replace(/\r\n?/g, '\n')
    .split('\n').filter(l => !/^\s*[-=*_—·]{3,}\s*$/.test(l)).join('\n');
  let chunks;
  if (mode === 'line') chunks = s.split('\n');
  else if (mode === 'block') chunks = s.split(/\n\s*\n+/);
  else chunks = /\n\s*\n/.test(s) ? s.split(/\n\s*\n+/) : s.split('\n');
  return chunks
    .map(x => x.trim())
    .map(x => x.replace(/^[-•*·▸]\s+/, '').replace(/^\d+[.、)]\s*/, '').trim())
    .filter(x => x.length >= 1 && !/^[-=*_—·\s]+$/.test(x));
}

function pasteImport(options = {}) {
  const chunks = splitPasted(options.text, options.splitMode);
  const type = TYPES.includes(options.type) ? options.type : 'idea';
  const cards = chunks.map(c => buildCard({
    externalId: 'paste:' + crypto.createHash('sha1').update(c).digest('hex').slice(0, 20),
    content: c, type, source: options.source || '随手记粘贴', baseTags: ['随手记']
  })).filter(Boolean);
  if (options.dryRun) {
    const fresh = existingIds(cards);
    return {
      cards: cards.length, added: fresh.length, skipped: cards.length - fresh.length,
      samples: fresh.slice(0, 5).map(x => ({ content: x.content.slice(0, 130), source: x.source, tags: x.tags })),
      dryRun: true
    };
  }
  return { cards: cards.length, ...insertCards(cards), dryRun: false };
}

module.exports = {
  status, saveConfig, testConnection, sync, pasteImport,
  splitPasted, parseInline, buildCard, PRESETS
};
