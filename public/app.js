'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const TYPES = [
  ['inbox', '未分类'], ['reading', '读书'], ['material', '素材'], ['idea', '小说思路'],
  ['reference', '资料'], ['character', '人物'], ['scene', '场景对话'], ['other', '其他']
];
const TYPE_LABEL = Object.fromEntries(TYPES);
const STATUS = [['idea', '构思'], ['outlining', '搭大纲'], ['drafting', '写草稿'], ['done', '已成稿']];
const TABS = [['write', '写作'], ['overview', '概览'], ['outline', '大纲'], ['characters', '人物'], ['draft', '版本稿'], ['material', '素材']];
const CHAR_FIELDS = [['name', '姓名'], ['desire', '欲望'], ['fear', '恐惧'], ['secret', '秘密'],
  ['phrase', '口头禅'], ['relations', '与谁的关系'], ['arc', '变化弧光'], ['note', '备注']];
const CH_STATUS = [['idea', '待写'], ['draft', '初稿'], ['revising', '修改中'], ['done', '定稿']];
const CH_LABEL = Object.fromEntries(CH_STATUS);

const state = {
  view: 'inbox', type: '', tag: '', q: '', stats: null, cards: [], works: [],
  workId: null, detail: null, tab: 'write', draftId: null, matCards: null, matQ: '', quickDraft: '',
  chapterId: null, focusMode: false, writeSide: 'material',
  wr: { status: null, books: [], selected: new Set(), preview: null, message: '', pasteText: '', pasteBook: '', keyInput: '' },
  mail: { status: null, form: {}, message: '', preview: null, previewLabel: '', pasteText: '', wrMarker: '#记', wrMode: 'private+marker' },
  insights: null, insightsRange: 'all', insightsDomain: null
};
const initialView = location.hash.replace(/^#/, '');
if (['inbox', 'cards', 'works', 'review', 'insights', 'weread', 'backup', 'mail'].includes(initialView)) state.view = initialView;

function captureQuickDraft() {
  const t = $('#qc-text');
  if (t) state.quickDraft = t.value;
}

function focusQuickCapture() {
  const q = $('#qc-text');
  if (q) { q.focus(); if (q.scrollIntoView) q.scrollIntoView({ block: 'nearest' }); return; }
  const t = $('#capture-input');
  if (t) t.focus();
}

function quickCaptureHtml() {
  return '<div class="quick-capture">' +
    '<div class="qc-head"><div>' +
    '<div class="qc-title">✎ 随手记一条</div>' +
    '<div class="qc-sub">想到就写，不用先想放哪。<b>#标签 @作品 ^来源</b> 都可省略，之后靠搜索找得回来。</div>' +
    '</div><span class="qc-key">按 N 随时开始记</span></div>' +
    '<textarea id="qc-text" rows="2" placeholder="此刻在想什么？可以是一句话、一段对话、一个没成形的念头…">' + esc(state.quickDraft) + '</textarea>' +
    '<div class="qc-foot">' +
    '<select id="qc-type">' + TYPES.map(([k, v]) => '<option value="' + k + '" ' + (k === 'inbox' ? 'selected' : '') + '>' + v + '</option>').join('') + '</select>' +
    '<span class="muted">Ctrl / ⌘ + Enter 保存，保存后仍停在这里，可以连着记</span>' +
    '<button class="btn-accent qc-submit" data-act="qc-save">记下 ↵</button>' +
    '</div></div>';
}

function captureWrInputs() {
  const t = $('#wr-paste'); if (t) state.wr.pasteText = t.value;
  const b = $('#wr-paste-book'); if (b) state.wr.pasteBook = b.value;
  const k = $('#wr-key'); if (k) state.wr.keyInput = k.value;
}

const esc = s => String(s === undefined || s === null ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const statusLabel = k => (STATUS.find(x => x[0] === k) || ['', k])[1];
const fmt = iso => String(iso || '').slice(5, 16).replace('T', ' ');

async function api(path, method = 'GET', data) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (data !== undefined) opt.body = JSON.stringify(data);
  const r = await fetch('/api' + path, opt);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || '请求失败');
  return j;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1900);
}

function fieldHtml(f, value) {
  const v = esc(value);
  if (f.type === 'textarea') return '<label class="field"><span>' + esc(f.label) + '</span><textarea name="' + f.name + '">' + v + '</textarea></label>';
  if (f.type === 'select') return '<label class="field"><span>' + esc(f.label) + '</span><select name="' + f.name + '">' +
    f.options.map(([k, lab]) => '<option value="' + esc(k) + '" ' + (String(value) === String(k) ? 'selected' : '') + '>' + esc(lab) + '</option>').join('') + '</select></label>';
  return '<label class="field"><span>' + esc(f.label) + '</span><input type="' + (f.type || 'text') + '" name="' + f.name + '" value="' + v + '"></label>';
}

function openModal(title, fields, values, onSubmit) {
  const root = $('#modal-root');
  root.hidden = false;
  root.innerHTML = '<div class="modal-mask"></div><div class="modal">' +
    '<div class="modal-head">' + esc(title) + '<button data-act="close-modal">×</button></div>' +
    '<form id="modal-form">' + fields.map(f => fieldHtml(f, values[f.name])).join('') +
    '<div class="modal-foot"><button type="button" data-act="close-modal">取消</button><button type="submit" class="btn-accent">保存</button></div></form></div>';
  root.querySelector('#modal-form').onsubmit = async ev => {
    ev.preventDefault();
    const data = {};
    for (const f of fields) {
      const inp = root.querySelector('[name="' + f.name + '"]');
      data[f.name] = inp ? inp.value : '';
    }
    try { await onSubmit(data); root.hidden = true; await render(); }
    catch (err) { toast(err.message || '保存失败'); }
  };
}

async function getCard(id) {
  const all = await api('/cards?limit=1000');
  return all.find(c => String(c.id) === String(id));
}

function cardHtml(c) {
  return '<article class="card" data-id="' + c.id + '">' +
    '<div class="card-top"><span class="type-tag">' + esc(TYPE_LABEL[c.type] || c.type) + '</span>' +
    (c.source ? '<span class="src">^ ' + esc(c.source) + '</span>' : '') +
    '<span class="time">' + fmt(c.created_at) + '</span>' +
    '<span class="card-actions"><button data-act="edit-card" data-id="' + c.id + '">编辑</button>' +
    '<button data-act="link-card" data-id="' + c.id + '">挂到作品</button>' +
    '<button data-act="del-card" data-id="' + c.id + '">删除</button></span></div>' +
    '<div class="card-body">' + esc(c.content) + '</div>' +
    '<div class="card-foot">' + (c.tags ? c.tags.split(',').map(t => '<span class="tag" data-act="filter-tag" data-tag="' + esc(t) + '">#' + esc(t) + '</span>').join('') : '') +
    (c.work_ids && c.work_ids.length ? '<span class="linked">已挂 ' + c.work_ids.length + ' 部作品</span>' : '') + '</div></article>';
}
const emptyHtml = t => '<div class="empty">' + esc(t) + '</div>';

function renderNav() {
  if (!$('#type-nav').children.length) {
    $('#type-nav').innerHTML = TYPES.map(([k, v]) => '<button class="nav-item sub" data-type="' + k + '">' + v + '</button>').join('');
  }
  $$('.nav-item[data-view]').forEach(b => b.classList.toggle('active', state.view === b.dataset.view));
  $$('#type-nav .nav-item').forEach(b => b.classList.toggle('active', state.view === 'cards' && state.type === b.dataset.type));
  $('#badge-inbox').textContent = state.stats ? state.stats.unlinked : 0;
  if (state.stats) {
    $('#side-stats').innerHTML = '卡片 ' + state.stats.cards + ' · 作品 ' + state.stats.works + '<br>今日新增 ' + state.stats.today;
    $('#db-path').textContent = state.stats.db;
  }
}

async function render() {
  // 任何重绘前先把编辑器里没落盘的字存下去，否则 innerHTML 重建会丢稿
  await flushEditor();
  try {
    captureQuickDraft();
    captureWrInputs();
    captureMailInputs();
    if (location.hash !== '#' + state.view) history.replaceState(null, '', '#' + state.view);
    state.stats = await api('/stats');
    renderNav();
    if (state.view === 'inbox') await renderCardList(true);
    else if (state.view === 'cards') await renderCardList(false);
    else if (state.view === 'works') await renderWorks();
    else if (state.view === 'review') await renderReview();
    else if (state.view === 'insights') await renderInsights();
    else if (state.view === 'weread') await renderWeread();
    else if (state.view === 'mail') await renderMail();
    else if (state.view === 'backup') renderBackup();
  } catch (e) { toast(e.message || '加载失败'); }
}

function filterBar(tags) {
  return '<div class="filter-bar"><span class="lbl">类型</span>' +
    '<button class="chip ' + (state.type ? '' : 'on') + '" data-act="filter-type" data-type="">全部</button>' +
    TYPES.map(([k, v]) => '<button class="chip ' + (state.type === k ? 'on' : '') + '" data-act="filter-type" data-type="' + k + '">' + v + '</button>').join('') +
    (state.q || state.tag ? '<button class="chip" data-act="clear-filter">清除筛选 ×</button>' : '') +
    '</div><div class="filter-bar"><span class="lbl">标签</span>' +
    (tags.length ? tags.slice(0, 24).map(t => '<button class="chip ' + (state.tag === t.tag ? 'on' : '') + '" data-act="filter-tag" data-tag="' + esc(t.tag) + '">#' + esc(t.tag) + ' ' + t.count + '</button>').join('') : '<span class="muted">还没有标签</span>') +
    '</div>';
}

async function renderCardList(isInbox) {
  const p = new URLSearchParams();
  if (isInbox) p.set('unlinked', '1');
  else {
    if (state.type) p.set('type', state.type);
    if (state.tag) p.set('tag', state.tag);
    if (state.q) p.set('q', state.q);
  }
  const [cards, tags] = await Promise.all([api('/cards?' + p.toString()), api('/tags')]);
  state.cards = cards;
  $('#content').innerHTML = '<div class="page-head"><h2>' + (isInbox ? '收件箱' : '卡片库') + '</h2><p>' +
    (isInbox ? '还没归到作品里的碎片。允许永远不整理，搜索能找回来就行。'
      : '全部碎片，按类型与标签筛。当前显示 ' + cards.length + ' 条，库里共 ' +
        (state.stats ? state.stats.cards : cards.length) + ' 张（可用搜索找更早的）。') + '</p></div>' +
    quickCaptureHtml() +
    (isInbox ? '' : filterBar(tags)) +
    '<div class="card-list">' + (cards.length ? cards.map(cardHtml).join('') :
      (isInbox && state.stats.cards
        ? '<div class="empty">收件箱是空的，已有 ' + state.stats.cards + ' 张卡片都归到作品里了。<br><br><button class="btn" data-act="goto-cards">去卡片库看看</button></div>'
        : emptyHtml('这里还没有卡片，在上面记一条试试。'))) + '</div>';
}

async function renderReview() {
  const cards = await api('/review?n=5');
  state.cards = cards;
  $('#content').innerHTML = '<div class="page-head"><h2>回顾</h2><p>随机翻几张旧卡片。让它重新浮上来，比多记十条更有用。</p></div>' +
    '<div style="margin-bottom:14px"><button class="btn" data-act="review-refresh">换一批</button></div>' +
    '<div class="card-list">' + (cards.length ? cards.map(cardHtml).join('') : emptyHtml('卡片池还是空的，先去记几条。')) + '</div>';
}

function renderBackup() {
  $('#content').innerHTML = '<div class="page-head"><h2>备份与导入</h2><p>数据就是一个 SQLite 文件，复制走就是完整备份。</p></div>' +
    '<div class="panel"><h3>导出全量 JSON</h3><p>包含卡片、作品、大纲、人物、草稿与关联关系，可留档或迁移。</p><button class="btn-accent" data-act="export">导出备份</button></div>' +
    '<div class="panel"><h3>合并导入</h3><p>选择之前导出的 JSON，追加卡片与作品；原有数据不会被覆盖。</p><input type="file" id="import-file" accept=".json"><br><button class="btn" data-act="import" style="margin-top:10px">合并导入</button></div>' +
    '<div class="panel"><h3>扫描本地成稿</h3><p>把 03-成稿 目录里的 .md 导入成作品与第一稿，不改动原文件；已导入过的会跳过。</p><button class="btn" data-act="scan-local">扫描 03-成稿</button></div>' +
    '<div class="panel"><h3>数据库文件</h3><p>' + esc(state.stats.db) + '</p></div>';
}

function insBarRow(label, value, maxVal, note, attrs) {
  const w = Math.max(2, Math.round(value / Math.max(maxVal, 1) * 100));
  return '<div class="bar-row ' + (attrs ? 'clickable' : '') + '"' + (attrs || '') + '>' +
    '<span class="bar-label" title="' + esc(label) + '">' + esc(label) + '</span>' +
    '<span class="bar-track"><span class="bar-fill" style="width:' + w + '%"></span></span>' +
    '<span class="bar-num">' + value + '</span>' +
    (note ? '<span class="bar-note">' + esc(note) + '</span>' : '') + '</div>';
}

function insMiniBars(values, labels, showEvery) {
  const m = Math.max(1, ...values);
  return '<div class="mini-bars">' + values.map((v, i) =>
    '<div class="mini-bar-col" title="' + esc(labels[i]) + '：' + v + ' 张">' +
    '<div class="mini-bar-area"><span class="mini-bar" style="height:' + Math.max(2, Math.round(v / m * 100)) + '%"></span></div>' +
    '<small>' + (i % showEvery === 0 ? esc(labels[i]) : '') + '</small></div>').join('') + '</div>';
}

async function renderInsights() {
  const d = await api('/insights?range=' + encodeURIComponent(state.insightsRange));
  state.insights = d;
  const o = d.overview;
  const stat = (n, k, s) => '<div class="stat-card"><div class="n">' + n + '</div><div class="k">' + k + '</div>' +
    (s ? '<div class="s">' + s + '</div>' : '') + '</div>';

  const signalsHtml = d.signals.map(s =>
    '<div class="signal"><h4>' + s.icon + ' ' + esc(s.title) + '</h4><p>' + esc(s.text) +
    '</p><div class="ev">依据 · ' + esc(s.evidence) + '</div></div>').join('');

  const RANGES = [['all', '全部'], ['365', '近一年'], ['90', '近 90 天'], ['30', '近 30 天']];
  const rangeHtml = '<div class="range-bar">' +
    '<span class="muted">时间范围（按素材原始记录时间，不是导入时间）</span>' +
    RANGES.map(([k, v]) => '<button class="chip ' + (state.insightsRange === k ? 'on' : '') +
      '" data-act="insight-range" data-range="' + k + '">' + v + '</button>').join('') +
    '<button class="btn" data-act="insight-report" style="margin-left:auto">导出 Markdown 报告</button></div>';

  const c = d.comparison;
  let compareHtml = '';
  if (c) {
    const cmpCell = (label, a, b) => '<div class="cmp-cell"><span>' + label + '</span><b>' + a +
      '</b><small>上期 ' + b + '</small></div>';
    const wordChips = (list, sign) => list.length
      ? list.map(x => '<span class="topic" data-act="insight-q" data-q="' + esc(x.word) + '">' +
        esc(x.word) + '<b>' + (sign > 0 ? '+' : '') + x.delta + '%</b></span>').join('')
      : '<span class="muted">无明显变化</span>';
    compareHtml = '<div class="ins-sec"><h3>与上一个 ' + c.days + ' 天对比 · 兴趣往哪移了</h3>' +
      '<p class="hint">本期 ' + c.current.start + ' ~ ' + c.current.end + '，上期 ' + c.previous.start + ' ~ ' +
      c.previous.end + '。升温 / 降温按「词覆盖卡片的占比差」计算，单位是百分点，不是次数。</p>' +
      '<div class="cmp-grid">' +
      cmpCell('卡片', c.current.cards, c.previous.cards) +
      cmpCell('自己的想法', c.current.thoughts, c.previous.thoughts) +
      cmpCell('涉及书籍', c.current.books, c.previous.books) + '</div>' +
      '<div class="cmp-words"><div><b>升温</b> ' + wordChips(c.rising, 1) + '</div>' +
      '<div><b>降温</b> ' + wordChips(c.falling, -1) + '</div>' +
      (c.newBooks.length ? '<div><b>新出现的书</b> ' + c.newBooks.map(b =>
        '<span class="topic" data-act="insight-q" data-q="' + esc(b) + '">《' + esc(b) + '》</span>').join('') + '</div>' : '') +
      '</div>' +
      (!c.enough ? '<p class="hint" style="margin:10px 0 0">两期样本都不足 5 张，对比仅供参考，建议放宽时间范围。</p>' : '') +
      '</div>';
  }

  const u = d.unused;
  const unusedHtml = '<div class="ins-sec"><h3>可以动手的一批 · 未加工素材</h3>' +
    '<p class="hint">共 ' + u.count + ' 张摘录既没写过自己的想法、也没挂到任何作品，分布在 ' + u.books +
    ' 本书里。下面按书各挑了一条 —— 随手挑一张补一句自己的判断，就把输入变成了输出。点条目可回卡片库看原文。</p>' +
    (u.byBook.length ? '<div class="unused-books">' + u.byBook.map(b =>
      '<span class="tag" data-act="insight-q" data-q="' + esc(b.title) + '">《' + esc(b.title) + '》 ' + b.count + '</span>').join('') + '</div>' : '') +
    '<div class="drill-list">' + u.samples.map(s =>
      '<div class="drill-item clickable" data-act="insight-q" data-q="' + esc(String(s.excerpt).slice(0, 12)) + '">' +
      '<span class="drill-src">' + esc(s.source || '未标注来源') + '</span>' +
      '<span class="drill-text">' + esc(s.excerpt) + '…</span></div>').join('') + '</div></div>';

  const maxBook = Math.max(1, ...d.topBooks.map(b => b.cards));
  const booksHtml = d.topBooks.length
    ? d.topBooks.map(b => insBarRow(b.title, b.cards, maxBook, '想法 ' + b.thoughts,
      ' data-act="insight-q" data-q="' + esc(b.title) + '" title="点开看这本书的卡片"')).join('')
    : '<p class="muted">还没有带书名的卡片</p>';

  const topicsHtml = d.topics.length
    ? '<div class="topic-cloud">' + d.topics.map(t =>
      '<span class="topic" data-act="insight-q" data-q="' + esc(t.word) + '" title="覆盖 ' + t.count + ' 张卡片，点开核对">' +
      esc(t.word) + '<b>' + t.count + '</b></span>').join('') + '</div>'
    : '<p class="muted">卡片还不够，暂时提不出主题词</p>';

  // 三层共用同一刻度（全部方向里最大的摘录数），长度才可直接比较、也才谈得上「逐级收窄」
  const maxC = Math.max(1, ...d.domains.map(x => x.cards));
  const insLine = (label, val, max, color) =>
    '<div class="domain-line"><span class="dl">' + label + '</span><span class="dt">' +
    '<span class="df" style="width:' + Math.max(2, Math.round(val / max * 100)) + '%;background:' + color + '"></span>' +
    '</span><span class="dn">' + val + '</span></div>';
  const domainsHtml = d.domains.length ? d.domains.map(x => {
    const open = state.insightsDomain === x.key;
    const samples = open ? '<div class="drill-list">' + x.samples.map(s =>
      '<div class="drill-item clickable" data-act="insight-q" data-q="' + esc(String(s.excerpt).slice(0, 12)) + '">' +
      '<span class="drill-src">' + esc(s.source || '未标注来源') + (s.myThought ? ' · 我的想法' : '') + '</span>' +
      '<span class="drill-text">' + esc(s.excerpt) + '…</span></div>').join('') + '</div>' : '';
    return '<div class="domain-block"><div class="domain-row clickable" data-act="insight-domain" data-key="' +
      esc(x.key) + '" title="点开看支撑这个方向的卡片">' +
      '<div class="domain-name">' + (open ? '▾ ' : '▸ ') + esc(x.label) + '</div><div class="domain-lines">' +
      insLine('摘录 / 输入', x.cards, maxC, 'var(--accent)') +
      insLine('自己的想法', x.myThoughts, maxC, 'var(--blue)') +
      insLine('已挂作品', x.linked, maxC, 'var(--green)') +
      '</div></div>' + samples + '</div>';
  }).join('') : '<p class="muted">暂无可归类的内容</p>';

  const typeMax = Math.max(1, ...d.types.map(t => t.count));
  const typesHtml = d.types.map(t => insBarRow(t.label, t.count, typeMax, '',
    ' data-act="insight-type" data-type="' + esc(t.type) + '" title="筛选这个类型"')).join('');
  const tagMax = Math.max(1, ...d.tags.map(t => t.count));
  const tagsHtml = d.tags.slice(0, 16).map(t => insBarRow('#' + t.tag, t.count, tagMax, '',
    ' data-act="insight-tag" data-tag="' + esc(t.tag) + '" title="筛选这个标签"')).join('') || '<p class="muted">还没有标签</p>';

  const hours = d.rhythm.hours, weekdays = d.rhythm.weekdays, months = d.rhythm.months;
  const hourBars = insMiniBars(hours, hours.map((_, i) => i + '时'), 3);
  const weekBars = insMiniBars(weekdays, ['周日', '周一', '周二', '周三', '周四', '周五', '周六'], 1);
  const monthBars = insMiniBars(months.map(m => m.count), months.map(m => m.month), 1);

  $('#content').innerHTML =
    '<div class="page-head"><h2>洞察 · 我积累了什么</h2>' +
    '<p>只呈现数据痕迹：注意力反复落在哪、有没有变成自己的话、有没有长进作品。可切换时间范围、点开任意方向看支撑它的卡片、导出报告留档。它能帮你看清长期投入，但不能替你判断天赋。</p></div>' +
    rangeHtml +

    '<div class="stat-grid">' +
    stat(o.cards, state.insightsRange === 'all' ? '卡片总数' : '区间卡片数', '其中读书导入 ' + o.imported + ' · 自己手记 ' + o.selfWritten) +
    stat(o.books, '涉及书籍', '前 3 本占 ' + o.top3Share + '%') +
    stat(o.myThoughts, '带自己想法的卡片', '占读书卡片 ' + o.ideaRate + '%') +
    stat(o.draftWords, '最新草稿字数', o.works + ' 部作品 · ' + o.outline + ' 个大纲节点') +
    stat(o.activeDays, '有记录的天数', '跨度 ' + o.spanDays + ' 天 · 最长连续 ' + o.bestStreak + ' 天') +
    stat(o.tags, '不同标签', '已挂到作品的卡片 ' + o.linkRate + '%') +
    '</div>' +

    '<div class="signal-grid">' + signalsHtml + '</div>' +
    compareHtml +

    '<div class="ins-sec"><h3>阅读版图 · 卡片最多的书</h3>' +
    '<p class="hint">这是最直观的一层：你把时间真正花在了哪些书上。条形长度是卡片数，右侧是其中带自己想法的条数。</p>' +
    booksHtml + '</div>' +

    '<div class="ins-sec"><h3>方向沉淀 · 从摘录到成稿</h3>' +
    '<p class="hint">按关键词粗分（一张卡可属多个方向，仅供参照）。看三层是否逐级收窄：反复出现 → 有自己的想法 → 已经用进作品。三层都厚的方向，更可能已经从兴趣变成能力（三条共用同一刻度，可直接比长度）。<b>点任一行可展开代表卡片核对证据。</b></p>' +
    domainsHtml + '</div>' +
    unusedHtml +

    '<div class="ins-sec"><h3>主题指纹 · 正文里反复出现的词</h3>' +
    '<p class="hint">只统计正文，已排除系统标签、章节编号、通用虚词与切词碎片；数字是「覆盖了多少张卡片」，不是出现次数。点词可回卡片库核对。</p>' +
    topicsHtml + '</div>' +

    '<div class="ins-2col">' +
    '<div class="ins-sec"><h3>一天里什么时候在记</h3><p class="hint">按本机时区，记录时间沿用素材原始时间。</p>' + hourBars + '</div>' +
    '<div class="ins-sec"><h3>星期分布</h3><p class="hint">周六/周日高低常能看出是碎片时间还是整块时间。</p>' + weekBars + '</div>' +
    '</div>' +

    '<div class="ins-sec"><h3>近 12 个月</h3><p class="hint">看积累是持续的还是集中爆发。</p>' + monthBars + '</div>' +

    '<div class="ins-2col">' +
    '<div class="ins-sec"><h3>卡片类型</h3><p class="hint">点一行可跳到卡片库筛选。</p>' + typesHtml + '</div>' +
    '<div class="ins-sec"><h3>高频标签</h3><p class="hint">点一行可跳到卡片库筛选。</p>' + tagsHtml + '</div>' +
    '</div>' +

    '<p class="muted" style="margin-top:16px">卡片、书籍、主题与时间节律按所选时间范围统计；作品、大纲、人物卡与草稿字数为全库口径。数据来自本机 SQLite，实时计算，不联网、不上传；生成于 ' + esc(fmt(d.generated_at)) + '。</p>';
}

function wrBookListHtml() {
  if (!state.wr.books.length) return '<p class="muted" style="margin:10px 0">还没加载书单，点「刷新书单」从微信读书拉取。</p>';
  return state.wr.books.map(b =>
    '<label class="wr-book"><input type="checkbox" data-wr-book="' + esc(b.bookId) + '" ' + (state.wr.selected.has(b.bookId) ? 'checked' : '') + '>' +
    '<span><b>' + esc(b.title) + '</b><small>' + esc(b.author) + '</small></span>' +
    '<span class="muted">划线 ' + b.noteCount + ' · 想法 ' + b.reviewCount + '</span></label>').join('');
}

function wrPreviewHtml() {
  const p = state.wr.preview;
  if (!p) return '';
  return '<div class="panel" style="margin-top:10px"><h3>预览 · ' + esc(p.book) + '</h3>' +
    '<p>识别 ' + p.cards + ' 条，预计新增 ' + p.added + ' 张读书卡片，重复 ' + p.skipped + ' 条。</p>' +
    (p.samples.map(c => '<div class="mini-card">' + esc(String(c.content).slice(0, 130)) +
      '<span class="t">' + esc(c.source) + '</span></div>').join('') || '<p class="muted">没有可新增的内容</p>') + '</div>';
}

async function renderWeread() {
  state.wr.status = await api('/weread/status');
  const s = state.wr.status;
  $('#content').innerHTML =
    '<div class="page-head"><h2>微信读书</h2><p>官方 Agent API · 只读 · API Key 只存本机 data/weread-config.json，不会发给除微信读书官方网关以外的任何地方。</p></div>' +
    '<div class="panel"><h3>1 · 连接账号</h3>' +
    '<p>到 <a href="' + esc(s.keyPage) + '" target="_blank" rel="noopener">微信读书官方页面</a> 用微信扫码获取 API Key（wrk- 开头）。当前：<b>' +
    (s.configured ? '已配置 ' + esc(s.keyHint) : '未配置') + '</b>。Key 只用于调用官方网关，不上传别处。</p>' +
    '<div class="row"><input id="wr-key" value="' + esc(state.wr.keyInput) + '" placeholder="wrk-..." style="flex:1">' +
    '<button class="btn" data-act="wr-save">保存 Key</button><button class="btn" data-act="wr-test">测试连接</button></div>' +
    (state.wr.message ? '<p style="margin-top:10px;color:var(--accent)">' + esc(state.wr.message) + '</p>' : '') + '</div>' +
    '<div class="panel"><h3>2 · 同步笔记与划线</h3>' +
    '<p>刷新书单后勾选同步。划线 → 读书卡片，想法 → 「原文 + 我的想法」读书卡片，自动带书名与章节；同一条不会重复导入。</p>' +
    '<div class="row"><button class="btn" data-act="wr-books">刷新书单</button>' +
    '<button class="btn" data-act="wr-select-all">全选</button>' +
    '<button class="btn-accent" data-act="wr-sync">同步到读书卡片</button>' +
    '<span class="muted">已选 <b id="wr-selected-count">' + state.wr.selected.size + '</b> 本</span></div>' +
    '<div id="wr-booklist">' + wrBookListHtml() + '</div></div>' +
    '<div class="panel"><h3>3 · 兜底：粘贴导入</h3>' +
    '<p>不想配 Key 或临时从 App 导出时，把复制的笔记贴进来。支持《书名》行、章节行、◆ / &gt; 划线行、想法：行，空行分段。</p>' +
    '<input id="wr-paste-book" value="' + esc(state.wr.pasteBook) + '" placeholder="书名（可留空，自动识别《》）" style="width:100%;margin-bottom:8px">' +
    '<textarea id="wr-paste" style="width:100%;min-height:130px" placeholder="粘贴微信读书导出的笔记文本…">' + esc(state.wr.pasteText) + '</textarea>' +
    '<div class="row" style="margin-top:8px"><button class="btn" data-act="wr-paste-preview">预览</button>' +
    '<button class="btn-accent" data-act="wr-paste-import">导入为读书卡片</button></div>' +
    '<div id="wr-preview">' + wrPreviewHtml() + '</div></div>';
}

function captureMailInputs() {
  if (state.view !== 'mail') return;
  const o = {};
  $$('[data-mail-field]').forEach(el => {
    o[el.dataset.mailField] = el.type === 'checkbox' ? el.checked : el.value;
  });
  state.mail.form = { ...state.mail.form, ...o };
  const t = $('#mail-paste'); if (t) state.mail.pasteText = t.value;
  const m = $('#wr-marker'); if (m) state.mail.wrMarker = m.value;
  const wm = $('#wr-mode'); if (wm) state.mail.wrMode = wm.value;
}
function readMailForm() { captureMailInputs(); return state.mail.form; }

function ideaSummary(title, r) {
  const latest = r.latestIdeaAt ? r.latestIdeaAt.slice(0, 10) : '无';
  const base = title + '：扫描 ' + (r.books || 0) + ' 本书 / ' + (r.totalReviews || r.scanned || 0) +
    ' 条想法（私密 ' + (r.privateAll || r.privateCount || 0) + ' 条，最新一条 ' + latest + '）；命中 ' +
    (r.matched || 0) + ' 条，新增 ' + (r.added || 0) + ' 张，跳过重复 ' + (r.skipped || 0) + ' 张。';
  return r.hint ? base + ' ' + r.hint : base;
}

function mailPreviewHtml() {
  const p = state.mail.preview;
  if (!p) return '';
  const head = p.scanned !== undefined ? '扫描 ' + p.scanned + ' 条' : '识别 ' + p.cards + ' 段';
  const matched = p.matched !== undefined ? p.matched : p.cards;
  return '<div class="panel" style="margin-top:10px"><h3>预览 · ' + esc(state.mail.previewLabel) + '</h3>' +
    '<p>' + head + '，匹配 ' + matched + ' 条，预计新增 ' + p.added + ' 张卡片，重复 ' + p.skipped + ' 张。预览不写入数据。</p>' +
    (p.samples.map(c => '<div class="mini-card">' + esc(String(c.content).slice(0, 140)) +
      '<span class="t">' + esc(c.source || '') + (c.tags ? ' · ' + esc(c.tags) : '') + '</span></div>').join('') ||
      '<p class="muted">没有可新增的内容</p>') + '</div>';
}

async function renderMail() {
  captureMailInputs();
  const s = await api('/mail/status');
  state.mail.status = s;
  const f = {
    preset: 'qq', host: s.host, port: s.port, user: s.user, password: '',
    folder: s.folder, marker: s.marker, mode: s.mode, days: s.days,
    type: s.type, markSeen: s.markSeen, splitMode: 'auto',
    ...state.mail.form
  };
  f.password = '';
  state.mail.form = f;
  const preset = (s.presets || []).find(p => p.key === f.preset);
  const presetOptions = (s.presets || []).map(p =>
    '<option value="' + esc(p.key) + '" ' + (f.preset === p.key ? 'selected' : '') + '>' + esc(p.label) + '</option>').join('');
  const modeOptions = [['marker', '主题含标记词 或 星标'], ['flagged', '仅星标 / 标记词'], ['self', '全部自发邮件（最省事）']]
    .map(([k, v]) => '<option value="' + k + '" ' + (f.mode === k ? 'selected' : '') + '>' + v + '</option>').join('');
  const typeOptions = TYPES.map(([k, v]) =>
    '<option value="' + k + '" ' + (f.type === k ? 'selected' : '') + '>' + v + '</option>').join('');

  $('#content').innerHTML =
    '<div class="page-head"><h2>手机同步</h2><p>手机不用装任何东西：在微信读书发想法、发一封邮件给自己，或先记在记事本/微信里，回到电脑点一下同步。所有凭据只存本机 data/ 目录，不会发给第三方。</p></div>' +
    (state.mail.message ? '<div class="panel" style="border-color:var(--accent)"><p style="color:var(--accent);margin:0">' + esc(state.mail.message) + '</p></div>' : '') +
    mailPreviewHtml() +
    (!s.dependency ? '<div class="panel"><h3>邮件依赖未安装</h3><p>微信读书与粘贴导入不受影响；要用邮件同步，请在 studio 目录执行一次 <b>npm install</b> 后重启服务。</p></div>' : '') +

    '<div class="panel"><h3>0 · 最省事：在微信读书的书里发「私密想法」</h3>' +
    '<p>手机打开微信读书，<b>在某本书的阅读页</b>写想法并把可见范围设为「私密」——私密本身就是标记，不用再打 #记。回来点同步，创作台把它收成「小说思路」卡片；公开想法也可以开头带标记词 <b>#记</b> 被挑中。</p>' +
    '<p class="muted">注意：官方 Agent API 只提供「按书查询的个人想法 / 点评」，<b>不返回独立发布的帖子 / 动态</b>。如果你是在想法区、书评广场单独发帖，接口里查不到，请复制帖子文本用第 3 块粘贴导入。预览会显示官方接口里最新一条想法的日期，可用来判断是不是索引延迟。</p>' +
    '<div class="row">' +
    '<select id="wr-mode" style="width:250px">' +
    [['private+marker', '私密想法 + 带 #记 的想法（推荐）'], ['private', '仅私密想法'], ['marker', '仅带标记词'], ['all', '全部个人想法（已导入的会跳过）']]
      .map(([k, v]) => '<option value="' + k + '" ' + (state.mail.wrMode === k ? 'selected' : '') + '>' + v + '</option>').join('') +
    '</select>' +
    '<input id="wr-marker" value="' + esc(state.mail.wrMarker) + '" placeholder="#记" style="width:100px" title="标记词，仅「标记」模式生效">' +
    '<button class="btn" data-act="wr-idea-preview">预览</button>' +
    '<button class="btn-accent" data-act="wr-idea-sync">同步随手记</button>' +
    '</div><p class="muted" style="margin-bottom:0">随手记与常规读书笔记分开存，同一条想法不会重复导入。</p></div>' +

    '<div class="panel"><h3>1 · 邮箱连接（只配一次）</h3>' +
    '<p>手机上用系统自带的「邮件」App 给自己发一封信就行。<span id="mail-preset-help">' + esc((preset && preset.help) || '') + '</span></p>' +
    '<div class="row">' +
    '<label class="field" style="flex:1"><span>服务商</span><select data-mail-field="preset" id="mail-preset">' + presetOptions + '</select></label>' +
    '<label class="field" style="flex:1"><span>IMAP 服务器</span><input data-mail-field="host" value="' + esc(f.host) + '"></label>' +
    '<label class="field" style="width:110px"><span>端口</span><input data-mail-field="port" type="number" value="' + esc(f.port) + '"></label>' +
    '</div><div class="row">' +
    '<label class="field" style="flex:1"><span>邮箱地址</span><input data-mail-field="user" value="' + esc(f.user) + '" placeholder="you@qq.com"></label>' +
    '<label class="field" style="flex:1"><span>授权码 / 应用专用密码（留空 = 不修改）</span><input data-mail-field="password" type="password" value="" placeholder="16 位授权码"></label>' +
    '<label class="field" style="width:130px"><span>文件夹</span><input data-mail-field="folder" value="' + esc(f.folder) + '"></label>' +
    '</div><div class="row">' +
    '<button class="btn" data-act="mail-save">保存配置</button>' +
    '<button class="btn" data-act="mail-test">测试连接</button>' +
    '<button class="btn" data-act="mail-clear">清除本机授权码</button>' +
    '<span class="muted">当前：' + (s.configured ? '已配置 ' + esc(s.user) + ' ' + esc(s.passwordHint) : '未配置') + '</span></div></div>' +

    '<div class="panel"><h3>2 · 邮件标记与同步</h3>' +
    '<p>发信给自己，主题里带上标记词（或直接把想法写在主题里、正文留空），也可以在邮件 App 里给邮件加星标。只扫描「自己发给自己的邮件」，不会收别人的来信。同步按邮件 UID 去重。</p>' +
    '<div class="row">' +
    '<label class="field" style="flex:1"><span>标记词</span><input data-mail-field="marker" value="' + esc(f.marker) + '"></label>' +
    '<label class="field" style="flex:1"><span>匹配方式</span><select data-mail-field="mode">' + modeOptions + '</select></label>' +
    '<label class="field" style="width:120px"><span>回看天数</span><input data-mail-field="days" type="number" value="' + esc(f.days) + '"></label>' +
    '<label class="field" style="flex:1"><span>存成什么卡片</span><select data-mail-field="type">' + typeOptions + '</select></label>' +
    '</div><div class="row">' +
    '<button class="btn" data-act="mail-preview">预览</button>' +
    '<button class="btn-accent" data-act="mail-sync">同步到卡片</button>' +
    '<label class="muted" style="display:flex;align-items:center;gap:5px"><input type="checkbox" data-mail-field="markSeen" ' + (f.markSeen ? 'checked' : '') + '> 同步后把邮件标记为已读</label></div></div>' +

    '<div class="panel"><h3>3 · 兜底：记事本 / 微信 / 备忘录直接粘贴</h3>' +
    '<p>不想配邮箱也行。手机随手记在任意 App 里，回家全选复制贴进来，一行或一段一条卡片；同样支持 #标签 @作品 ^来源。按内容去重，重复粘贴不会重复入库。</p>' +
    '<textarea id="mail-paste" style="width:100%;min-height:130px" placeholder="一行一条，或用空行分段…">' + esc(state.mail.pasteText) + '</textarea>' +
    '<div class="row" style="margin-top:8px">' +
    '<select data-mail-field="splitMode"><option value="auto"' + (f.splitMode === 'auto' ? ' selected' : '') + '>自动切分</option>' +
    '<option value="line"' + (f.splitMode === 'line' ? ' selected' : '') + '>每行一条</option>' +
    '<option value="block"' + (f.splitMode === 'block' ? ' selected' : '') + '>每段一条</option></select>' +
    '<button class="btn" data-act="mail-paste-preview">预览</button>' +
    '<button class="btn-accent" data-act="mail-paste-import">导入为卡片</button></div></div>';
}

// ── 写作台：自动保存状态机 ────────────────────────────────────
// 关键约束：整个应用靠重建 innerHTML 渲染，而重绘会打断输入、丢光标。
// 所以保存只做 PATCH + 改几个数字节点，绝不触发 render；重绘前先 flush。
const editor = { id: null, timer: null, dirty: false, cache: null, saving: false };

function liveWords(s) { return String(s || '').replace(/\s/g, '').length; }
function setSaveState(txt, cls) {
  const el = $('#save-state');
  if (el) { el.textContent = txt; el.className = 'save-state ' + (cls || ''); }
}
function collectEditor() {
  const c = $('#chapter-content');
  if (!c) return null;
  const t = $('#chapter-title'), s = $('#chapter-synopsis');
  return { content: c.value, title: t ? t.value : '', synopsis: s ? s.value : '' };
}
function markDirty() {
  editor.cache = collectEditor();
  if (!editor.cache) return;
  editor.dirty = true;
  setSaveState('● 未保存', 'dirty');
  const el = $('#ed-words');
  if (el) el.textContent = liveWords(editor.cache.content).toLocaleString('zh-CN') + ' 字';
  clearTimeout(editor.timer);
  editor.timer = setTimeout(() => { editor.timer = null; saveEditorNow(); }, 1200);
}
async function saveEditorNow() {
  if (!editor.id || !editor.dirty) return;
  if (editor.saving) {
    clearTimeout(editor.timer);
    editor.timer = setTimeout(() => { editor.timer = null; saveEditorNow(); }, 400);
    return;
  }
  const snap = editor.cache;
  if (!snap) { editor.dirty = false; return; }
  // 防止标题被一次异常的空值静默清空（清空章节名没有意义，却很难察觉）
  const oldUnit = state.detail && state.detail.drafts.find(x => String(x.id) === String(editor.id));
  const payload = { content: snap.content, title: snap.title, synopsis: snap.synopsis };
  if (!String(payload.title).trim() && oldUnit && oldUnit.title) payload.title = oldUnit.title;
  editor.saving = true;
  editor.dirty = false;
  setSaveState('保存中…', 'saving');
  try {
    const r = await api('/drafts/' + editor.id + '/save', 'POST', payload);
    const d = state.detail;
    if (d) {
      const unit = d.drafts.find(x => String(x.id) === String(editor.id));
      if (unit) { unit.content = payload.content; unit.title = payload.title; unit.synopsis = payload.synopsis; }
      const p = d.progress;
      if (p) {
        p.words = Math.max(0, p.words + r.delta);
        p.today_words = r.today_words;
        p.pct = p.target > 0 ? Math.min(100, Math.round(p.words / p.target * 100)) : 0;
        const tw = $('#today-words'); if (tw) tw.textContent = Math.max(0, p.today_words).toLocaleString('zh-CN');
        const wt = $('#total-words'); if (wt) wt.textContent = p.words.toLocaleString('zh-CN');
        const pf = $('#progress-fill'); if (pf) pf.style.width = p.pct + '%';
        const pt = $('#progress-text'); if (pt) pt.textContent = p.target ? '（' + p.pct + '%）' : '';
      }
      const nm = document.querySelector('[data-ch-name="' + editor.id + '"]');
      if (nm) nm.textContent = payload.title || '未命名';
      const wc = document.querySelector('[data-ch-words="' + editor.id + '"]');
      if (wc) wc.textContent = r.words.toLocaleString('zh-CN');
    }
    setSaveState('✓ 已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), 'saved');
  } catch (e) {
    editor.dirty = true;
    setSaveState('保存失败 · 稍后重试', 'dirty');
    clearTimeout(editor.timer);
    editor.timer = setTimeout(() => { editor.timer = null; saveEditorNow(); }, 2500);
  } finally { editor.saving = false; }
}
async function flushEditor() {
  if (editor.timer) { clearTimeout(editor.timer); editor.timer = null; }
  if (!editor.dirty) return;
  await saveEditorNow();
  if (editor.dirty) { await new Promise(r => setTimeout(r, 150)); await saveEditorNow(); }
}
function bindEditor(unit) {
  if (editor.timer) { clearTimeout(editor.timer); editor.timer = null; }
  editor.id = unit ? Number(unit.id) : null;
  editor.cache = unit ? { content: unit.content || '', title: unit.title || '', synopsis: unit.synopsis || '' } : null;
  editor.dirty = false;
  editor.saving = false;
}
function insertIntoEditor(text) {
  const ta = $('#chapter-content');
  if (!ta) return;
  const s = ta.selectionStart, e = ta.selectionEnd;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.focus();
  ta.selectionStart = ta.selectionEnd = s + text.length;
  markDirty();
  toast('已插入，输入会自动保存');
}

function currentUnit(d) {
  const units = [...(d.chapters || []), ...(d.versions || [])];
  return units.find(x => String(x.id) === String(state.chapterId)) ||
    (d.chapters || [])[0] || (d.versions || [])[0] || null;
}

function chapterTreeHtml(d, unit) {
  const chRows = d.chapters.map((c, i) =>
    '<div class="ch-item ' + (unit && String(unit.id) === String(c.id) ? 'active ' : '') + esc(c.status || 'idea') + '" data-act="open-chapter" data-id="' + c.id + '">' +
    '<span class="ch-num">' + String(i + 1).padStart(2, '0') + '</span>' +
    '<div class="ch-body"><span class="ch-name" data-ch-name="' + c.id + '">' + esc(c.title || '未命名') + '</span>' +
    '<span class="ch-meta"><span data-ch-words="' + c.id + '">' + liveWords(c.content).toLocaleString('zh-CN') + '</span> 字 · ' + esc(CH_LABEL[c.status] || '待写') + '</span></div>' +
    '<span class="ch-ops"><button data-act="move-chapter" data-id="' + c.id + '" data-dir="-1" title="上移">↑</button>' +
    '<button data-act="move-chapter" data-id="' + c.id + '" data-dir="1" title="下移">↓</button></span></div>').join('');
  const verRows = d.versions.map(v =>
    '<div class="ch-item ver ' + (unit && String(unit.id) === String(v.id) ? 'active' : '') + '" data-act="open-chapter" data-id="' + v.id + '">' +
    '<span class="ch-num">稿</span><div class="ch-body"><span class="ch-name">' + esc(v.title || '第 ' + v.version + ' 稿') + '</span>' +
    '<span class="ch-meta">' + liveWords(v.content).toLocaleString('zh-CN') + ' 字 · 整稿</span></div></div>').join('');
  return '<div class="col-head"><span>章节 <b>' + d.chapters.length + '</b></span>' +
    '<button class="btn-mini" data-act="new-chapter">＋ 新章节</button></div>' +
    '<div class="ch-list">' + (chRows || '<p class="muted" style="padding:8px 4px">还没有章节。点「新章节」开写；<br>已有的整稿在下面，也能直接编辑。</p>') + '</div>' +
    (verRows ? '<div class="col-sub">整稿版本</div><div class="ch-list">' + verRows + '</div>' : '');
}

function writeSideHtml(d, unit) {
  const tab = state.writeSide;
  const head = '<div class="side-tabs">' + [['material', '本节素材'], ['characters', '人物'], ['all', '全部']].map(([k, v]) =>
    '<button class="side-tab ' + (tab === k ? 'active' : '') + '" data-act="write-side" data-side="' + k + '">' + v + '</button>').join('') + '</div>';
  let body = '';
  if (tab === 'characters') {
    body = (d.characters || []).map(ch =>
      '<div class="side-card"><div class="sc-title"><button data-act="insert-name" data-name="' + esc(ch.name) + '">' + esc(ch.name) + '</button></div>' +
      [['欲望', ch.desire], ['恐惧', ch.fear], ['秘密', ch.secret], ['口头禅', ch.phrase], ['弧光', ch.arc]].filter(x => x[1])
        .map(x => '<div class="sc-line"><span>' + x[0] + '</span>' + esc(x[1]) + '</div>').join('') + '</div>').join('') ||
      '<p class="muted">还没有人物卡，去「人物」页加一张。</p>';
  } else {
    const cards = tab === 'material'
      ? (d.cards || []).filter(c => !c.slot || c.slot === 'material' || (unit && c.slot === 'ch:' + unit.id))
      : (d.cards || []);
    body = cards.map(c =>
      '<div class="side-card"><div class="sc-quote">' + esc(String(c.content).slice(0, 150)) + '</div>' +
      '<div class="sc-foot"><span>' + esc(c.source || (TYPE_LABEL[c.type] || c.type)) + (c.slot && c.slot.indexOf('ch:') === 0 ? ' · 本节' : '') + '</span>' +
      '<button data-act="insert-card" data-id="' + c.id + '">插入</button></div></div>').join('') ||
      '<p class="muted">这里还没有素材。到「素材」页挂几条，写的时候就能随手插入。</p>';
  }
  return head + '<div class="side-scroll">' + body + '</div>';
}

function writeHtml(d) {
  const p = d.progress || {};
  const unit = currentUnit(d);
  const isChapter = unit && unit.kind === 'chapter';
  const units = [...d.chapters, ...d.versions];
  const idx = units.findIndex(x => unit && String(x.id) === String(unit.id));
  const top = '<div class="write-top"><div class="wt-progress">' +
    '<div class="wt-row"><span>全书进度</span><b><span id="total-words">' + (p.words || 0).toLocaleString('zh-CN') + '</span> 字</b>' +
    '<span class="muted">目标</span><input id="target-words" type="number" min="0" step="1000" value="' + (p.target || 0) + '" title="全书目标字数，回车或失焦保存">' +
    '<span class="muted">字</span><span id="progress-text" class="muted">' + (p.target ? '（' + p.pct + '%）' : '') + '</span></div>' +
    '<div class="progress-track"><div class="progress-fill" id="progress-fill" style="width:' + (p.pct || 0) + '%"></div></div></div>' +
    '<div class="wt-actions"><div class="wt-stat"><b id="today-words">' + Math.max(0, p.today_words || 0).toLocaleString('zh-CN') + '</b><span>今日净增</span></div>' +
    '<div class="wt-stat"><b>' + (p.streak || 0) + '</b><span>连续天数</span></div>' +
    '<button class="btn" data-act="export-book">导出全文</button>' +
    '<button class="btn" data-act="focus-mode">' + (state.focusMode ? '退出专注' : '专注写作') + '</button></div></div>';

  const middle = unit ? (
    '<div class="ed-head"><input id="chapter-title" value="' + esc(unit.title || '') + '" placeholder="这一节叫什么">' +
    '<span id="save-state" class="save-state saved">✓ 已保存</span></div>' +
    '<div class="ed-syn"><span>这一节要发生什么</span><textarea id="chapter-synopsis" rows="2" placeholder="一句话梗概，写的时候抬头就能看见">' + esc(unit.synopsis || '') + '</textarea></div>' +
    '<textarea id="chapter-content" class="chapter-content" spellcheck="false" placeholder="开始写…">' + esc(unit.content || '') + '</textarea>' +
    '<div class="ed-foot"><span id="ed-words">' + liveWords(unit.content).toLocaleString('zh-CN') + ' 字</span>' +
    '<span class="muted">输入即自动保存 · Ctrl+S 立即存</span>' +
    (isChapter ? '<select id="chapter-status">' + CH_STATUS.map(([k, v]) =>
      '<option value="' + k + '" ' + ((unit.status || 'idea') === k ? 'selected' : '') + '>' + v + '</option>').join('') + '</select>' : '<span class="muted">整稿版本</span>') +
    '<button class="btn" data-act="prev-chapter" ' + (idx <= 0 ? 'disabled' : '') + '>← 上一节</button>' +
    '<button class="btn" data-act="next-chapter" ' + (idx < 0 || idx >= units.length - 1 ? 'disabled' : '') + '>下一节 →</button>' +
    (isChapter ? '<button class="btn btn-quiet" data-act="del-chapter" data-id="' + unit.id + '">删除本节</button>' : '') +
    '</div>') :
    '<div class="write-empty"><h3>还没有正文</h3><p>新建第一章，或从左边大纲挑一个节拍「开写」。<br>正文按章节存，输入完自动保存，不用点按钮。</p>' +
    '<button class="btn-accent" data-act="new-chapter">＋ 新建第一章</button></div>';

  return top + '<div class="write-layout' + (state.focusMode ? ' focus' : '') + '">' +
    '<aside class="chapter-col">' + chapterTreeHtml(d, unit) + '</aside>' +
    '<section class="write-editor">' + middle + '</section>' +
    '<aside class="write-side" id="write-side">' + writeSideHtml(d, unit) + '</aside></div>';
}

async function renderWorks() {
  state.works = await api('/works');
  if (state.workId && !state.works.some(w => String(w.id) === String(state.workId))) state.workId = null;
  if (!state.workId && state.works.length) state.workId = state.works[0].id;
  let detail = '';
  if (state.workId) {
    state.detail = await api('/works/' + state.workId);
    detail = workDetailHtml(state.detail);
    bindEditor(state.tab === 'write' ? currentUnit(state.detail) : null);
  } else { state.detail = null; bindEditor(null); }
  $('#content').innerHTML = '<div class="work-layout"><div class="work-list">' +
    '<div class="list-head"><span>作品 ' + state.works.length + '</span><button data-act="new-work">＋ 新建</button></div>' +
    (state.works.map(w => '<button class="work-item ' + (String(w.id) === String(state.workId) ? 'active' : '') + '" data-act="view-work" data-id="' + w.id + '">' +
      esc(w.title) + '<small>' + statusLabel(w.status) + ' · ' + (w.word_count || 0).toLocaleString('zh-CN') + ' 字' +
      (w.chapter_count ? ' · ' + w.chapter_count + ' 章' : '') + '</small>' +
      (w.target_words > 0 ? '<span class="mini-progress"><i style="width:' + (w.pct || 0) + '%"></i></span>' : '') + '</button>').join('') ||
      '<div class="muted" style="padding:8px">还没有作品</div>') +
    '</div><div class="work-detail">' + (detail || '<div class="empty">从左侧选一部作品，或新建一部。<br>章节、大纲、人物、素材都会跟着这部作品走。</div>') + '</div></div>';
  if (state.focusEditor) {
    state.focusEditor = false;
    const ta = $('#chapter-content');
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
}

function workDetailHtml(d) {
  const w = d.work, p = d.progress || {};
  return '<div class="work-head"><input class="title-input" id="w-title" value="' + esc(w.title) + '">' +
    '<span class="status-pill">' + statusLabel(w.status) + '</span>' +
    '<span class="muted" style="font-size:11.5px">' + (p.chapter_count || 0) + ' 章 · ' + (p.words || 0).toLocaleString('zh-CN') + ' 字 · ' + d.cards.length + ' 素材</span></div>' +
    '<div class="tabs">' + TABS.map(([k, v]) => '<button class="tab ' + (state.tab === k ? 'active' : '') + '" data-act="switch-tab" data-tab="' + k + '">' + v + '</button>').join('') + '</div>' +
    '<div class="tab-body">' + tabBody(d) + '</div>';
}

function tabBody(d) {
  if (state.tab === 'write') return writeHtml(d);
  if (state.tab === 'overview') return overviewHtml(d);
  if (state.tab === 'outline') return outlineHtml(d);
  if (state.tab === 'characters') return charactersHtml(d);
  if (state.tab === 'draft') return draftHtml(d);
  if (state.tab === 'material') return materialHtml(d);
  return '';
}

function overviewHtml(d) {
  const w = d.work, p = d.progress || {};
  const recent = p.recent || [];
  const vals = recent.map(x => Math.max(0, x.words));
  const maxV = Math.max(1, ...vals);
  const bars = '<div class="mini-bars">' + vals.map((v, i) =>
    '<div class="mini-bar-col" title="' + esc(recent[i].day) + '：' + v + ' 字">' +
    '<div class="mini-bar-area"><span class="mini-bar" style="height:' + Math.max(2, Math.round(v / maxV * 100)) + '%"></span></div>' +
    '<small>' + (i % 4 === 0 ? esc(recent[i].day.slice(5).replace('-', '/')) : '') + '</small></div>').join('') + '</div>';
  const st = p.byStatus || {};
  const stat = (n, k, s) => '<div class="stat-card"><div class="n">' + n + '</div><div class="k">' + k + '</div>' +
    (s ? '<div class="s">' + s + '</div>' : '') + '</div>';
  return '<div class="stat-grid">' +
    stat((p.words || 0).toLocaleString('zh-CN') + ' 字', '正文已写', p.target ? '目标 ' + p.target.toLocaleString('zh-CN') + ' 字 · 完成 ' + p.pct + '%' : '还没设目标字数') +
    stat(p.chapter_count || 0, '章节', (st.done || 0) + ' 章定稿 · ' + (st.draft || 0) + ' 章初稿') +
    stat(Math.max(0, p.today_words || 0).toLocaleString('zh-CN'), '今日净增字数', '删改也计入，按当日净变化算') +
    stat((p.streak || 0) + ' 天', '连续动笔', d.outline.length + ' 个大纲节点 · ' + d.characters.length + ' 张人物卡 · ' + d.cards.length + ' 条素材') +
    '</div>' +
    '<div class="ins-sec"><h3>近 14 天码字</h3><p class="hint">每次自动保存记一次净增，方便看自己的写作节奏。</p>' + bars + '</div>' +
    '<div class="ins-sec"><h3>这部作品</h3>' +
    '<div class="grid-2">' +
    '<label class="field"><span>类型</span><input id="w-genre" value="' + esc(w.genre) + '" placeholder="短篇小说 / 长篇小说 / 散文"></label>' +
    '<label class="field"><span>阶段</span><select id="w-status">' + STATUS.map(([k, v]) => '<option value="' + k + '" ' + (w.status === k ? 'selected' : '') + '>' + v + '</option>').join('') + '</select></label>' +
    '</div><div class="grid-2">' +
    '<label class="field"><span>全书目标字数（0 = 不设）</span><input id="w-target" type="number" min="0" step="1000" value="' + (p.target || 0) + '"></label>' +
    '<label class="field"><span>关联素材</span><input value="' + d.cards.length + ' 条" disabled></label>' +
    '</div><label class="field"><span>一句话立意</span><textarea id="w-logline" style="min-height:80px" placeholder="这篇到底想写什么？一句话就够">' + esc(w.logline) + '</textarea></label>' +
    '<div class="row"><button class="btn-accent" data-act="save-work">保存</button>' +
    '<button class="btn" data-act="goto-write">去写作台 →</button>' +
    '<button class="btn" data-act="export-book">导出全文</button>' +
    '<span class="muted">章节、进度与码字统计都在「写作」页</span></div></div>';
}

function outlineHtml(d) {
  return '<p class="muted" style="margin:0 0 12px">先列节拍，点「开写」直接生成同名章节并跳到写作台，备注会变成章节梗概。</p>' +
    '<div class="outline-add"><input id="o-title" placeholder="章节 / 节拍标题"><input id="o-note" placeholder="这一节要发生什么（可选）"><button class="btn-accent" data-act="add-outline">添加</button></div>' +
    (d.outline.map((o, i) => '<div class="outline-row"><span class="num">' + String(i + 1).padStart(2, '0') + '</span>' +
      '<div class="txt"><b>' + esc(o.title) + '</b>' + (o.note ? '<div>' + esc(o.note) + '</div>' : '') + '</div>' +
      '<button class="btn-mini" data-act="start-outline" data-id="' + o.id + '" title="建同名章节并去写作台">开写 →</button>' +
      '<button data-act="move-outline" data-id="' + o.id + '" data-dir="-1" title="上移">↑</button>' +
      '<button data-act="move-outline" data-id="' + o.id + '" data-dir="1" title="下移">↓</button>' +
      '<button data-act="edit-outline" data-id="' + o.id + '">编辑</button>' +
      '<button data-act="del-outline" data-id="' + o.id + '">删</button></div>').join('') || '<p class="muted">还没有大纲，从上面加一条开始。</p>');
}

function charactersHtml(d) {
  return '<p class="muted" style="margin-bottom:12px">固定字段比空白页好填：欲望 / 恐惧 / 秘密 / 口头禅 / 关系 / 弧光。</p>' +
    '<button class="btn" data-act="add-character">＋ 新增人物</button>' +
    '<div class="char-grid" style="margin-top:14px">' + (d.characters.map(ch =>
      '<div class="char-card"><h4>' + esc(ch.name) + '</h4><dl>' +
      CHAR_FIELDS.slice(1).filter(([k]) => ch[k]).map(([k, v]) => '<div class="line"><dt>' + v + '：</dt><dd>' + esc(ch[k]) + '</dd></div>').join('') +
      '</dl><div class="ops"><button data-act="edit-character" data-id="' + ch.id + '">编辑</button>' +
      '<button data-act="del-character" data-id="' + ch.id + '">删除</button></div></div>').join('') || '<p class="muted">还没有人物卡</p>') + '</div>';
}

function draftHtml(d) {
  const drafts = d.drafts;
  if (!state.draftId || !drafts.some(x => String(x.id) === String(state.draftId))) {
    state.draftId = drafts.length ? String(drafts[0].id) : null;
  }
  const cur = drafts.find(x => String(x.id) === String(state.draftId)) || { content: '', title: '', version: 0 };
  return '<div class="draft-grid"><div class="editor-col">' +
    '<div class="draft-bar"><select id="draft-select">' +
    (drafts.map(x => '<option value="' + x.id + '" ' + (String(x.id) === String(state.draftId) ? 'selected' : '') + '>第 ' + x.version + ' 稿 · ' + esc(x.title || '正文') + '</option>').join('') || '<option value="">（暂无版本）</option>') +
    '</select><input id="draft-title" value="' + esc(cur.title) + '" placeholder="版本名" style="width:130px">' +
    '<button class="btn" data-act="new-draft">另存新版本</button>' +
    '<span class="word-count">' + cur.content.replace(/\s/g, '').length + ' 字</span></div>' +
    '<textarea id="draft-content" placeholder="在这里写正文…">' + esc(cur.content) + '</textarea>' +
    '<div class="draft-bar" style="margin-top:10px"><button class="btn-accent" data-act="save-draft">保存这一稿</button>' +
    '<span class="muted">另存新版本会保留旧稿不动</span></div></div>' +
    '<div class="side-col"><h4>已挂素材 · 点插入</h4>' +
    (d.cards.map(c => '<div class="mini-card"><span class="t">' + esc(String(c.content).slice(0, 90)) + '</span>' +
      '<button data-act="insert-card" data-id="' + c.id + '">插入正文</button></div>').join('') || '<p class="muted">到「素材」页挂几条</p>') + '</div></div>';
}

function materialHtml(d) {
  const unit = currentUnit(d);
  const chSlot = unit && unit.kind === 'chapter' ? 'ch:' + unit.id : '';
  const slotName = s => s === 'ch:' + (unit && unit.id) ? '本节 · ' + (unit.title || '') : (s || '通用');
  const linked = d.cards.map(c => '<div class="material-row"><div class="body">' + esc(c.content) +
    '<div class="meta">' + esc(TYPE_LABEL[c.type] || c.type) + (c.source ? ' · ^ ' + esc(c.source) : '') + ' · ' + esc(slotName(c.slot)) + '</div></div>' +
    '<button class="btn" data-act="unlink-card" data-id="' + c.id + '" data-slot="' + esc(c.slot) + '">取消</button></div>').join('');
  const candidates = (state.matCards || []).filter(c => !d.cards.some(x => String(x.id) === String(c.id)))
    .map(c => '<div class="material-row"><div class="body">' + esc(String(c.content).slice(0, 180)) +
      '<div class="meta">' + esc(TYPE_LABEL[c.type] || c.type) + '</div></div>' +
      '<button class="btn" data-act="attach-card" data-id="' + c.id + '" data-slot="material">挂上</button>' +
      (chSlot ? '<button class="btn" data-act="attach-card" data-id="' + c.id + '" data-slot="' + chSlot + '">挂到本节</button>' : '') +
      '</div>').join('');
  return '<p class="muted">从卡片池挑素材挂到这部作品。写作台右栏「本节素材」只显示通用素材和挂到当前章节的卡片，写长篇时不会被全库素材淹没。</p>' +
    '<div class="row" style="margin-bottom:16px"><input id="mat-q" value="' + esc(state.matQ) + '" placeholder="搜卡片内容 / 标签" style="flex:1"><button class="btn" data-act="mat-search">找卡片</button></div>' +
    '<h4 style="font-size:12.5px;color:var(--muted);margin:0 0 8px">已挂到这部作品（' + d.cards.length + '）</h4>' +
    '<div class="material-list">' + (linked || '<p class="muted">还没有挂任何素材</p>') + '</div>' +
    '<h4 style="font-size:12.5px;color:var(--muted);margin:22px 0 8px">候选卡片</h4>' +
    '<div class="material-list">' + (state.matCards ? (candidates || '<p class="muted">没有更多候选</p>') : '<p class="muted">点「找卡片」从池里筛一批出来</p>') + '</div>';
}

$('#capture-btn').onclick = capture;
$('#capture-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); capture(); } });
$('#global-search').addEventListener('keydown', e => {
  if (e.key === 'Enter') { state.q = e.target.value.trim(); state.type = ''; state.tag = ''; state.view = 'cards'; render(); }
});
$('.sidebar nav').addEventListener('click', e => {
  const b = e.target.closest('[data-view],[data-type]');
  if (!b) return;
  if (b.dataset.view) { state.view = b.dataset.view; state.tab = 'write'; state.matCards = null; }
  else { state.view = 'cards'; state.type = b.dataset.type; state.tag = ''; state.q = ''; }
  render();
});

async function submitCapture(which) {
  const quick = which === 'qc';
  const sel = quick ? '#qc-text' : '#capture-input';
  const typeSel = quick ? '#qc-type' : '#capture-type';
  const inp = $(sel), typeEl = $(typeSel);
  if (!inp) return;
  const text = inp.value.trim();
  if (!text) { inp.focus(); return; }
  try {
    await api('/cards', 'POST', { content: text, type: typeEl ? typeEl.value : 'inbox' });
    if (quick) state.quickDraft = '';
    inp.value = '';
    toast('记下了');
    await render();
    const again = $(sel);
    if (again) again.focus();       // 连续记录不用再点一次
  } catch (e) { toast(e.message); }
}
function capture() { return submitCapture('top'); }

// 编辑器输入：只标脏 + 防抖保存，绝不重绘页面
document.addEventListener('input', e => {
  if (['chapter-content', 'chapter-title', 'chapter-synopsis'].includes(e.target.id)) markDirty();
});
window.addEventListener('beforeunload', () => {
  if (!editor.dirty || !editor.cache || !editor.id) return;
  try {
    fetch('/api/drafts/' + editor.id + '/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(editor.cache), keepalive: true
    });
  } catch (_) { /* 页面已在关闭，交给下一次自动保存兜底 */ }
});

// 全局快捷键：不在输入态时按 N 开始记，/ 搜索；大输入框内 Ctrl/⌘+Enter 提交
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    flushEditor().then(() => toast('已保存'));
    return;
  }
  const tag = e.target && e.target.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && e.target && e.target.id === 'qc-text') {
    e.preventDefault(); submitCapture('qc'); return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'n' || e.key === 'N') { e.preventDefault(); focusQuickCapture(); }
  else if (e.key === '/') { e.preventDefault(); const s = $('#global-search'); if (s) s.focus(); }
});

document.addEventListener('change', async e => {
  if (e.target.id === 'target-words') {
    const v = Math.max(0, Number(e.target.value) || 0);
    try {
      const r = await api('/works/' + state.workId, 'PATCH', { target_words: v });
      const p = state.detail && state.detail.progress;
      if (p) {
        p.target = v;
        p.pct = v > 0 ? Math.min(100, Math.round(p.words / v * 100)) : 0;
        const f = $('#progress-fill'); if (f) f.style.width = p.pct + '%';
        const t = $('#progress-text'); if (t) t.textContent = v ? '（' + p.pct + '%）' : '';
      }
      if (state.detail) state.detail.work.target_words = v;
      toast('目标字数已保存');
      void r;
    } catch (err) { toast(err.message); }
    return;
  }
  if (e.target.id === 'chapter-status') {
    const v = e.target.value;
    try {
      await api('/drafts/' + editor.id, 'PATCH', { status: v });
      const u = state.detail && state.detail.chapters.find(x => String(x.id) === String(editor.id));
      if (u) u.status = v;
      const item = document.querySelector('.ch-item.active');
      if (item) {
        item.className = item.className.replace(/\b(idea|draft|revising|done)\b/g, '').trim() + ' ' + v;
        const meta = item.querySelector('.ch-meta');
        if (meta) meta.innerHTML = meta.innerHTML.replace(/· .*$/, '· ' + (CH_LABEL[v] || '待写'));
      }
      toast('本节状态：' + (CH_LABEL[v] || v));
    } catch (err) { toast(err.message); }
    return;
  }
  if (e.target.id === 'mail-preset') {
    const p = ((state.mail.status && state.mail.status.presets) || []).find(x => x.key === e.target.value);
    if (p && p.host) {
      const h = document.querySelector('[data-mail-field="host"]');
      const po = document.querySelector('[data-mail-field="port"]');
      if (h) h.value = p.host;
      if (po) po.value = p.port;
      const help = $('#mail-preset-help'); if (help) help.textContent = p.help || '';
      captureMailInputs();
    }
  }
  if (e.target.id === 'draft-select') { state.draftId = e.target.value; await render(); }
  if (e.target.dataset && e.target.dataset.wrBook !== undefined) {
    const id = e.target.dataset.wrBook;
    if (e.target.checked) state.wr.selected.add(id); else state.wr.selected.delete(id);
    const c = $('#wr-selected-count'); if (c) c.textContent = state.wr.selected.size;
  }
});

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act, id = b.dataset.id;
  let needRender = true;
  try {
    switch (act) {
      case 'close-modal': $('#modal-root').hidden = true; needRender = false; break;

      case 'qc-save': { await submitCapture('qc'); needRender = false; break; }

      case 'insight-q': {
        state.q = b.dataset.q || ''; state.type = ''; state.tag = ''; state.view = 'cards';
        const s = $('#global-search'); if (s) s.value = state.q;
        break;
      }
      case 'insight-tag': {
        state.tag = b.dataset.tag || ''; state.q = ''; state.type = ''; state.view = 'cards';
        const s = $('#global-search'); if (s) s.value = '';
        break;
      }
      case 'insight-type': {
        state.type = b.dataset.type || ''; state.q = ''; state.tag = ''; state.view = 'cards';
        const s = $('#global-search'); if (s) s.value = '';
        break;
      }
      case 'insight-range': {
        state.insightsRange = b.dataset.range || 'all';
        state.insightsDomain = null;
        break;
      }
      case 'insight-domain': {
        state.insightsDomain = state.insightsDomain === b.dataset.key ? null : b.dataset.key;
        break;
      }
      case 'insight-report': {
        const r = await fetch('/api/insights/report?range=' + encodeURIComponent(state.insightsRange));
        if (!r.ok) throw new Error('报告生成失败');
        const text = await r.text();
        const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = '创作洞察-' + new Date().toISOString().slice(0, 10) + '.md';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        toast('报告已下载'); needRender = false; break;
      }

      case 'edit-card': {
        const c = await getCard(id);
        if (!c) throw new Error('卡片不存在');
        openModal('编辑卡片', [
          { name: 'content', label: '内容', type: 'textarea' },
          { name: 'type', label: '类型', type: 'select', options: TYPES },
          { name: 'source', label: '来源（书名 / 页码 / 链接）' },
          { name: 'tags', label: '标签（逗号分隔）' }
        ], c, async d => { await api('/cards/' + id, 'PATCH', d); toast('已更新'); });
        needRender = false; break;
      }

      case 'del-card': {
        if (!confirm('删除这张卡片？不可撤销。')) { needRender = false; break; }
        await api('/cards/' + id, 'DELETE'); toast('已删除'); break;
      }

      case 'link-card': {
        const works = await api('/works');
        if (!works.length) { toast('还没有作品，先到「作品」页新建一部'); needRender = false; break; }
        openModal('挂到作品', [
          { name: 'work_id', label: '选择作品', type: 'select', options: works.map(w => [String(w.id), w.title]) },
          { name: 'slot', label: '用途', type: 'select', options: [['', '通用'], ['outline', '大纲'], ['character', '人物'], ['draft', '草稿'], ['material', '素材']] }
        ], {}, async d => { await api('/cards/' + id + '/link', 'POST', { work_id: Number(d.work_id), slot: d.slot }); toast('已挂上'); });
        needRender = false; break;
      }

      case 'filter-type': state.type = b.dataset.type; state.view = 'cards'; break;
      case 'filter-tag': state.tag = b.dataset.tag; state.type = ''; state.view = 'cards'; break;
      case 'clear-filter': state.type = ''; state.tag = ''; state.q = ''; $('#global-search').value = ''; break;
      case 'goto-cards': state.view = 'cards'; break;

      case 'new-work': {
        openModal('新建作品', [
          { name: 'title', label: '作品名' },
          { name: 'genre', label: '类型（短篇小说 / 散文 / 随笔…）' },
          { name: 'logline', label: '一句话立意', type: 'textarea' },
          { name: 'status', label: '阶段', type: 'select', options: STATUS }
        ], { status: 'idea' }, async d => {
          const w = await api('/works', 'POST', d);
          state.workId = w.id; state.tab = 'write'; state.draftId = null; state.matCards = null;
          state.chapterId = null;
          toast('已新建');
        });
        needRender = false; break;
      }

      case 'view-work': state.workId = Number(id); state.tab = 'write'; state.draftId = null; state.matCards = null; state.chapterId = null; break;
      case 'switch-tab': state.tab = b.dataset.tab; break;

      case 'open-chapter': state.chapterId = Number(id); state.focusEditor = true; break;

      case 'new-chapter': {
        const n = state.detail.chapters.length;
        const created = await api('/works/' + state.workId + '/drafts', 'POST', {
          kind: 'chapter', version: n + 1, title: '第 ' + (n + 1) + ' 章', content: '',
          sort_order: n, status: 'idea', synopsis: ''
        });
        state.chapterId = String(created.id); state.focusEditor = true;
        break;
      }

      case 'move-chapter': {
        const list = state.detail.chapters;
        const i = list.findIndex(x => String(x.id) === String(id)), j = i + Number(b.dataset.dir);
        if (j < 0 || j >= list.length) { needRender = false; break; }
        await api('/drafts/' + list[i].id, 'PATCH', { sort_order: j });
        await api('/drafts/' + list[j].id, 'PATCH', { sort_order: i });
        break;
      }

      case 'del-chapter': {
        if (!confirm('删除这一节？正文会一并删除，不可撤销。')) { needRender = false; break; }
        await flushEditor();
        await api('/drafts/' + id, 'DELETE');
        bindEditor(null);
        state.chapterId = null;
        toast('已删除'); break;
      }

      case 'prev-chapter':
      case 'next-chapter': {
        const units = [...state.detail.chapters, ...state.detail.versions];
        const cur = state.chapterId || (units[0] && units[0].id);
        const i = units.findIndex(x => String(x.id) === String(cur));
        const j = i + (act === 'prev-chapter' ? -1 : 1);
        if (j < 0 || j >= units.length) { needRender = false; break; }
        state.chapterId = String(units[j].id); state.focusEditor = true; break;
      }

      case 'write-side': {
        state.writeSide = b.dataset.side;
        const side = $('#write-side');
        if (side) side.innerHTML = writeSideHtml(state.detail, currentUnit(state.detail));
        needRender = false; break;
      }

      case 'focus-mode': {
        state.focusMode = !state.focusMode;
        const lay = document.querySelector('.write-layout');
        if (lay) lay.classList.toggle('focus', state.focusMode);
        b.textContent = state.focusMode ? '退出专注' : '专注写作';
        needRender = false; break;
      }

      case 'insert-name': insertIntoEditor(b.dataset.name || ''); needRender = false; break;

      case 'export-book': {
        const r = await fetch('/api/works/' + state.workId + '/export.md');
        if (!r.ok) throw new Error('导出失败');
        const text = await r.text();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
        a.download = (state.detail.work.title || '正文') + '.md';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 3000);
        toast('全文已导出'); needRender = false; break;
      }

      case 'save-work': {
        const t = $('#w-target');
        await api('/works/' + state.workId, 'PATCH', {
          title: $('#w-title').value, genre: $('#w-genre').value,
          logline: $('#w-logline').value, status: $('#w-status').value,
          target_words: Math.max(0, Number(t ? t.value : 0) || 0)
        });
        toast('已保存'); break;
      }

      case 'goto-write': state.tab = 'write'; state.focusEditor = true; break;

      case 'start-outline': {
        const o = state.detail.outline.find(x => String(x.id) === String(id));
        if (!o) { needRender = false; break; }
        let ch = state.detail.chapters.find(x => x.title === o.title);
        if (!ch) {
          const n = state.detail.chapters.length;
          ch = await api('/works/' + state.workId + '/drafts', 'POST', {
            kind: 'chapter', version: n + 1, title: o.title, content: '',
            sort_order: n, status: 'idea', synopsis: o.note || ''
          });
        }
        state.chapterId = String(ch.id); state.tab = 'write'; state.focusEditor = true;
        toast('已开写：' + o.title); break;
      }

      case 'add-outline': {
        const t = $('#o-title').value.trim();
        if (!t) { toast('先写个标题'); needRender = false; break; }
        await api('/works/' + state.workId + '/outline', 'POST',
          { title: t, note: $('#o-note').value, parent_id: 0, sort_order: state.detail.outline.length });
        break;
      }

      case 'edit-outline': {
        const o = state.detail.outline.find(x => String(x.id) === String(id));
        openModal('编辑大纲节点', [{ name: 'title', label: '标题' }, { name: 'note', label: '备注', type: 'textarea' }], o,
          async d => { await api('/outline/' + id, 'PATCH', d); toast('已更新'); });
        needRender = false; break;
      }

      case 'del-outline': {
        if (!confirm('删除这个大纲节点？')) { needRender = false; break; }
        await api('/outline/' + id, 'DELETE'); break;
      }

      case 'move-outline': {
        const list = state.detail.outline;
        const i = list.findIndex(x => String(x.id) === String(id)), j = i + Number(b.dataset.dir);
        if (j < 0 || j >= list.length) { needRender = false; break; }
        await api('/outline/' + list[i].id, 'PATCH', { sort_order: j });
        await api('/outline/' + list[j].id, 'PATCH', { sort_order: i });
        break;
      }

      case 'add-character': {
        openModal('新增人物', CHAR_FIELDS.map(([n, l]) => ({ name: n, label: l, type: n === 'note' ? 'textarea' : 'text' })), {},
          async d => { await api('/works/' + state.workId + '/characters', 'POST', d); toast('已新增'); });
        needRender = false; break;
      }

      case 'edit-character': {
        const ch = state.detail.characters.find(x => String(x.id) === String(id));
        openModal('编辑人物', CHAR_FIELDS.map(([n, l]) => ({ name: n, label: l, type: n === 'note' ? 'textarea' : 'text' })), ch,
          async d => { await api('/characters/' + id, 'PATCH', d); toast('已更新'); });
        needRender = false; break;
      }

      case 'del-character': {
        if (!confirm('删除这张人物卡？')) { needRender = false; break; }
        await api('/characters/' + id, 'DELETE'); break;
      }

      case 'save-draft': {
        if (!state.draftId) { toast('先点「另存新版本」'); needRender = false; break; }
        await api('/drafts/' + state.draftId, 'PATCH', { content: $('#draft-content').value, title: $('#draft-title').value });
        toast('这一稿已保存'); break;
      }

      case 'new-draft': {
        const versions = state.detail.drafts.map(x => Number(x.version) || 0);
        const next = (versions.length ? Math.max(...versions) : 0) + 1;
        const created = await api('/works/' + state.workId + '/drafts', 'POST',
          { version: next, title: '第 ' + next + ' 稿', content: $('#draft-content').value,
            kind: 'version', sort_order: next, status: 'draft', synopsis: '' });
        state.draftId = String(created.id);
        toast('已存为第 ' + next + ' 稿'); break;
      }

      case 'insert-card': {
        const c = (state.detail && state.detail.cards || []).find(x => String(x.id) === String(id));
        if (!c) { needRender = false; break; }
        if ($('#chapter-content')) insertIntoEditor(c.content);
        else {
          const ta = $('#draft-content');
          if (ta) { ta.value += (ta.value ? '\n\n' : '') + c.content; ta.focus(); toast('已插入正文'); }
        }
        needRender = false; break;
      }

      case 'mat-search': {
        state.matQ = $('#mat-q').value.trim();
        state.matCards = await api('/cards?q=' + encodeURIComponent(state.matQ) + '&limit=40');
        break;
      }

      case 'attach-card': {
        const slot = b.dataset.slot || 'material';
        await api('/cards/' + id + '/link', 'POST', { work_id: state.workId, slot });
        toast(slot.indexOf('ch:') === 0 ? '已挂到本节' : '已挂到这部作品'); break;
      }

      case 'unlink-card': {
        await api('/cards/' + id + '/link', 'DELETE', { work_id: state.workId, slot: b.dataset.slot || '' });
        toast('已取消'); break;
      }

      case 'review-refresh': break;

      case 'export': {
        const data = await api('/export');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '创作台备份-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        toast('已导出'); needRender = false; break;
      }

      case 'import': {
        const f = $('#import-file').files[0];
        if (!f) { toast('先选一个 JSON 文件'); needRender = false; break; }
        const data = JSON.parse(await f.text());
        const r = await api('/import', 'POST', data);
        toast('已导入 ' + r.cards + ' 张卡片 / ' + r.works + ' 部作品');
        break;
      }

      case 'scan-local': {
        const r = await api('/scan-local', 'POST', {});
        toast(r.added ? '导入了 ' + r.added + ' 篇成稿' : (r.message || '没有新的成稿'));
        break;
      }

      case 'wr-save': {
        const k = $('#wr-key').value.trim();
        if (!k) { toast('先填入 API Key'); needRender = false; break; }
        await api('/weread/config', 'POST', { api_key: k });
        state.wr.keyInput = '';
        state.wr.message = 'API Key 已保存到本机。可以点「测试连接」验证。';
        break;
      }

      case 'wr-test': {
        const r = await api('/weread/test', 'POST', {});
        state.wr.message = '连接成功：有笔记的书 ' + (r.totalBookCount ?? '?') + ' 本，笔记合计 ' + (r.totalNoteCount ?? '?') + ' 条。';
        break;
      }

      case 'wr-books': {
        state.wr.books = await api('/weread/books');
        state.wr.selected = new Set(state.wr.books.map(b => b.bookId));
        state.wr.message = '找到 ' + state.wr.books.length + ' 本有笔记的书，已默认全选。';
        break;
      }

      case 'wr-select-all': {
        state.wr.selected = new Set(state.wr.books.map(b => b.bookId));
        break;
      }

      case 'wr-sync': {
        if (!state.wr.selected.size) { toast('先刷新并勾选书单'); needRender = false; break; }
        const r = await api('/weread/sync', 'POST', { bookIds: [...state.wr.selected] });
        state.wr.message = '同步完成：新增 ' + r.added + ' 张读书卡片，跳过重复 ' + r.skipped + ' 张（共 ' + r.books + ' 本书）。';
        break;
      }

      case 'wr-paste-preview': {
        const text = $('#wr-paste').value;
        if (!text.trim()) { toast('先粘贴笔记文本'); needRender = false; break; }
        state.wr.preview = await api('/weread/paste', 'POST', { text, book: $('#wr-paste-book').value, dryRun: true });
        state.wr.message = '预览：预计新增 ' + state.wr.preview.added + ' 张读书卡片。';
        break;
      }

      case 'wr-paste-import': {
        const text = $('#wr-paste').value;
        if (!text.trim()) { toast('先粘贴笔记文本'); needRender = false; break; }
        const r = await api('/weread/paste', 'POST', { text, book: $('#wr-paste-book').value, dryRun: false });
        state.wr.message = '导入完成：新增 ' + r.added + ' 张读书卡片，跳过重复 ' + r.skipped + ' 张。';
        break;
      }

      case 'wr-idea-preview': {
        const marker = ($('#wr-marker') && $('#wr-marker').value.trim()) || '#记';
        const mode = ($('#wr-mode') && $('#wr-mode').value) || 'private+marker';
        state.mail.wrMarker = marker;
        state.mail.wrMode = mode;
        const r = await api('/weread/ideas', 'POST', { marker, mode, dryRun: true });
        state.mail.preview = r;
        state.mail.previewLabel = '微信读书随手记';
        state.mail.message = ideaSummary('预览（未写入数据）', r);
        break;
      }

      case 'wr-idea-sync': {
        const marker = ($('#wr-marker') && $('#wr-marker').value.trim()) || '#记';
        const mode = ($('#wr-mode') && $('#wr-mode').value) || 'private+marker';
        state.mail.wrMarker = marker;
        state.mail.wrMode = mode;
        const r = await api('/weread/ideas', 'POST', { marker, mode });
        state.mail.preview = null;
        state.mail.message = ideaSummary('同步完成', r);
        break;
      }

      case 'mail-save': {
        await api('/mail/config', 'POST', readMailForm());
        state.mail.form.password = '';
        state.mail.preview = null;
        state.mail.message = '邮箱配置已保存到本机。点「测试连接」确认能连上。';
        break;
      }

      case 'mail-clear': {
        await api('/mail/config', 'POST', { clearPassword: true });
        state.mail.message = '已清除本机保存的授权码。';
        break;
      }

      case 'mail-test': {
        await api('/mail/config', 'POST', readMailForm());
        const r = await api('/mail/test', 'POST', {});
        state.mail.message = '连接成功：' + r.folder + ' 共 ' + r.exists + ' 封邮件；当前标记词「' + r.marker + '」。';
        break;
      }

      case 'mail-preview': {
        await api('/mail/config', 'POST', readMailForm());
        state.mail.preview = await api('/mail/sync', 'POST', { dryRun: true });
        state.mail.previewLabel = '邮件同步';
        state.mail.message = '预览完成，没有写入任何卡片。';
        break;
      }

      case 'mail-sync': {
        await api('/mail/config', 'POST', readMailForm());
        const r = await api('/mail/sync', 'POST', {});
        state.mail.preview = null;
        state.mail.message = '同步完成：扫描 ' + r.scanned + ' 封，匹配 ' + r.matched + ' 封，新增 ' + r.added + ' 张卡片，跳过重复 ' + r.skipped + ' 张。';
        break;
      }

      case 'mail-paste-preview': {
        const f = readMailForm();
        const text = $('#mail-paste').value;
        if (!text.trim()) { toast('先粘贴文本'); needRender = false; break; }
        state.mail.preview = await api('/mail/paste', 'POST', { text, type: f.type, splitMode: f.splitMode, dryRun: true });
        state.mail.previewLabel = '随手记粘贴';
        state.mail.message = '预览：预计新增 ' + state.mail.preview.added + ' 张卡片。';
        break;
      }

      case 'mail-paste-import': {
        const f = readMailForm();
        const text = $('#mail-paste').value;
        if (!text.trim()) { toast('先粘贴文本'); needRender = false; break; }
        const r = await api('/mail/paste', 'POST', { text, type: f.type, splitMode: f.splitMode });
        const t = $('#mail-paste'); if (t) t.value = '';
        state.mail.pasteText = '';
        state.mail.preview = null;
        state.mail.message = '导入完成：新增 ' + r.added + ' 张卡片，跳过重复 ' + r.skipped + ' 张。';
        needRender = true; break;
      }

      default: needRender = false;
    }
  } catch (err) { toast(err.message || '操作失败'); needRender = false; }
  if (needRender) await render();
});

render();
