'use strict';
// 洞察分析：只做「数据观察」，不做能力测评。
// 所有结论都附带可核对的数字；擅长与否由使用者自己判断。
const { db } = require('./db');

const TYPE_LABEL = {
  inbox: '未分类', reading: '读书', material: '素材', idea: '小说思路',
  reference: '资料', character: '人物', scene: '场景对话', other: '其他'
};

// 方向字典：按关键词粗分，可解释、可质疑。命中即计数，一张卡可属于多个方向。
const DOMAINS = [
  { key: 'history', label: '历史 · 制度 · 权力', words: ['历史', '王朝', '皇帝', '朝廷', '政权', '官制', '士族', '科举', '奏折', '诸侯', '三国', '诸葛亮', '曹操', '刘备', '资治通鉴', '史记', '魏晋', '南北朝', '明代', '清代', '宋代', '唐代', '兴平', '建安', '军事', '战争'] },
  { key: 'literature', label: '文学 · 叙事 · 人物', words: ['小说', '文学', '叙事', '情节', '写作', '作家', '散文', '诗歌', '修辞', '红楼梦', '对白', '文本', '创作', '章回', '写作课'] },
  { key: 'mind', label: '心理 · 认知 · 决策', words: ['心理', '认知', '记忆', '决策', '情绪', '意识', '直觉', '注意力', '大脑', '动机', '焦虑', '偏见', '系统1', '系统2'] },
  { key: 'society', label: '社会 · 文化 · 关系', words: ['社会', '文化', '人类', '家庭', '城市', '经济', '教育', '群体', '身份', '婚姻', '阶层', '性别', '乡土', '民俗', '共同体'] },
  { key: 'method', label: '方法 · 系统 · 工具', words: ['方法', '工具', '模型', '框架', '效率', '设计', '数据', '流程', '技术', '管理', '策略', '自动化', '测试', '系统'] },
  { key: 'philosophy', label: '哲学 · 价值 · 意义', words: ['哲学', '存在', '自由', '道德', '信仰', '死亡', '命运', '真理', '伦理', '宗教', '荒诞', '虚无', '意义', '生死'] }
];

// 中文无分词库，用 2~4 字连续片段 + 首尾虚词过滤 + 子串去重，取「出现在多少张卡片」而非总次数。
const STOP_HEAD = new Set('的了是也在和就都而及或与这那之其为以于不我你他她它们个很到说着要会能可被把从对还再又更最没无啊呢吧吗嗯哦呀么些各每该此有并但却才只已所让使给像比等如若虽因'.split(''));
const STOP_TAIL = new Set('的了是也在和就都而及或与这那之其为以于不我你他她它们个很到说着要会能可被把从对还再又更最没无啊呢吧吗嗯哦呀么些各每该此有上下中里外时后来去过'.split(''));

function localParts(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = n => String(n).padStart(2, '0');
  return {
    hour: d.getHours(),
    weekday: d.getDay(),
    month: d.getFullYear() + '-' + p(d.getMonth() + 1),
    day: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
  };
}

function pad2(n) { return String(n).padStart(2, '0'); }
function dateStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

// 时间范围按「素材原始记录时间」切分（不是导入时间），并给出紧邻的前一个等长时段用于对比。
function rangeBounds(range) {
  const days = Number(range);
  if (!Number.isFinite(days) || days <= 0) return null;
  const end = new Date(); end.setHours(23, 59, 59, 999);
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  const prevEnd = new Date(start.getTime() - 86400000);
  const prevStart = new Date(prevEnd.getTime() - (days - 1) * 86400000);
  return { days, start: dateStr(start), end: dateStr(end), prevStart: dateStr(prevStart), prevEnd: dateStr(prevEnd) };
}

// 主题词占比（不做最低频次过滤），用于两期差值比较
function topicRates(list) {
  const df = new Map();
  for (const c of list) {
    const text = String(c.content || '').slice(0, 400).replace(/【划线】|【我的想法】/g, ' ');
    const seen = new Set();
    for (const seg of text.split(/[^\u4e00-\u9fa5]+/).filter(s => s.length >= 2)) {
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= seg.length; i++) {
          const w = seg.slice(i, i + n);
          if (STOP_HEAD.has(w[0]) || STOP_TAIL.has(w[w.length - 1])) continue;
          if (GENERIC.has(w) || NUMERIC_WORD.test(w)) continue;
          seen.add(w);
        }
      }
    }
    for (const w of seen) df.set(w, (df.get(w) || 0) + 1);
  }
  const total = Math.max(1, list.length);
  return { rates: new Map([...df].map(([w, c]) => [w, c / total])), counts: df, total: list.length };
}

function cleanLen(s) { return String(s || '').replace(/\s/g, '').length; }
function excerpt(s, n = 90) {
  return String(s || '').replace(/【划线】|【我的想法】/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
}
function isImported(c) { return String(c.external_id || '').startsWith('weread:'); }
function isMyThought(c) {
  const t = String(c.tags || '');
  return String(c.content || '').includes('【我的想法】') || t.includes('想法') || t.includes('随手记');
}
function bookTitle(source) {
  const m = String(source || '').match(/《([^》]+)》/);
  return m ? m[1] : '';
}

// 通用词：出现频繁但不指向任何主题
const GENERIC = new Set(['自己', '一种', '一个', '没有', '这样', '那样', '因为', '所以', '但是', '如果', '虽然',
  '可以', '这个', '那个', '什么', '怎么', '如何', '我们', '他们', '它们', '时候', '现在', '已经', '还是',
  '不是', '就是', '可能', '应该', '需要', '非常', '其实', '一直', '只是', '只有', '所有', '许多', '这些',
  '那些', '之后', '之前', '之间', '不同', '相同', '如此', '一切', '东西', '事情', '地方', '问题', '方式',
  '结果', '开始', '最后', '先生', '女士', '父亲', '母亲', '孩子', '划线', '想法', '微信读书', '人民文学']);
// 纯功能/语法词：抽象概念词（意义、价值、生命、时间…）保留，它们能反映阅读气质；
// 但「一样、知道、必须、插图」这类不指向任何主题，去掉。
const FUNCTION_WORDS = new Set(['插图', '一样', '一个人', '知道', '别人', '真正', '任何', '必须', '一定',
  '另一', '似乎', '忽然', '仿佛', '终于', '于是', '因此', '即使', '尽管', '更加', '十分', '相当',
  '完全', '基本', '主要', '一般', '特别', '尤其', '甚至', '仍然', '已经', '曾经', '正在', '将要',
  '其中', '对于', '关于', '通过', '根据', '以及', '或者', '并且', '然而', '不能', '不会', '永远',
  '这些', '那些', '其实', '只有', '所有', '许多', '不同', '相同', '一切']);
for (const w of FUNCTION_WORDS) GENERIC.add(w);
// 章节编号：第一 / 十二 / 第十 / 七十 等
const NUMERIC_WORD = /^[一二三四五六七八九十百零两0-9第章节卷篇部回]+$/;

// 人名/书名的滑动窗口碎片（如「阿尔 / 尔卡 / 卡蒂 / 蒂奥」）只保留一个
function dedupeDiffs(list, limit) {
  const out = [];
  for (const x of list) {
    if (out.some(y => commonSubLen(x.word, y.word) >= 2 && Math.abs(x.delta - y.delta) < 0.8)) continue;
    out.push(x);
    if (out.length >= limit) break;
  }
  return out;
}

function commonSubLen(a, b) {
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
}

function extractTopics(cards, limit = 28) {
  const df = new Map();
  for (const c of cards) {
    // 只看正文：tags / source 里的「微信读书」「划线」「人民文学版」是系统标签，不是主题。
    // 书名有独立的阅读版图榜，不参与此处，避免滑动窗口把书名切成一堆碎片。
    const text = String(c.content || '').slice(0, 500)
      .replace(/【划线】|【我的想法】/g, ' ');
    const seen = new Set();
    for (const seg of text.split(/[^\u4e00-\u9fa5]+/).filter(s => s.length >= 2)) {
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= seg.length; i++) {
          const w = seg.slice(i, i + n);
          if (STOP_HEAD.has(w[0]) || STOP_TAIL.has(w[w.length - 1])) continue;
          if (GENERIC.has(w) || NUMERIC_WORD.test(w)) continue;
          seen.add(w);
        }
      }
    }
    for (const w of seen) df.set(w, (df.get(w) || 0) + 1);
  }
  const minDf = Math.max(3, Math.round(cards.length / 400));
  const ranked = [...df]
    .filter(([w, c]) => c >= minDf && w.length >= 2 && c / Math.max(cards.length, 1) <= 0.30)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);

  const picked = [];
  for (const [w, c] of ranked) {
    // 同一串文字的滑动窗口碎片（如「魏晋南北 / 晋南北朝」）只留一个
    if (picked.some(([p, pc]) => p !== w && commonSubLen(p, w) >= 2 && Math.abs(c - pc) <= Math.max(2, pc * 0.15))) continue;
    picked.push([w, c]);
    if (picked.length >= limit) break;
  }
  return picked.map(([word, count]) => ({ word, count }));
}

function pct(n, total) { return total ? Math.round(n * 1000 / total) / 10 : 0; }

let cache = { key: '', at: 0, value: null };

function compute(options = {}) {
  const range = String(options.range || 'all');
  const allCards = db.prepare('SELECT id,content,type,source,tags,external_id,created_at FROM cards').all();
  const bounds = rangeBounds(range);
  const inRange = (c, a, b) => {
    const p = localParts(c.created_at);
    return !!p && p.day >= a && p.day <= b;
  };
  const cards = bounds ? allCards.filter(c => inRange(c, bounds.start, bounds.end)) : allCards;
  const prevCards = bounds ? allCards.filter(c => inRange(c, bounds.prevStart, bounds.prevEnd)) : [];
  const works = db.prepare('SELECT id,title,genre,status,created_at FROM works').all();
  const drafts = db.prepare('SELECT work_id,version,content FROM drafts').all();
  const outline = db.prepare('SELECT id FROM outline').all();
  const characters = db.prepare('SELECT id FROM characters').all();
  const links = db.prepare('SELECT card_id FROM links').all();

  // 轻量缓存键：行数 + 最新创建时间；同页反复刷新不重算中文词频
  const lastCreated = cards.reduce((m, c) => String(c.created_at) > m ? String(c.created_at) : m, '');
  const key = [range, cards.length, works.length, drafts.length, links.length, lastCreated].join('|');
  if (cache.key === key && Date.now() - cache.at < 60000) return cache.value;

  const linked = new Set(links.map(l => l.card_id));
  const typeCounts = new Map();
  const tagCounts = new Map();
  const bookMap = new Map();
  const hours = Array(24).fill(0);
  const weekdays = Array(7).fill(0);
  const monthMap = new Map();
  const days = new Set();
  let imported = 0, myThoughts = 0, privateIdeas = 0, selfWritten = 0;

  for (const c of cards) {
    typeCounts.set(c.type, (typeCounts.get(c.type) || 0) + 1);
    for (const t of String(c.tags || '').split(',').map(s => s.trim()).filter(Boolean)) {
      tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
    }
    const book = bookTitle(c.source);
    if (book) {
      if (!bookMap.has(book)) bookMap.set(book, { title: book, cards: 0, thoughts: 0, highlights: 0 });
      const b = bookMap.get(book);
      b.cards++;
      if (isMyThought(c)) b.thoughts++; else b.highlights++;
    }
    if (isImported(c)) imported++; else selfWritten++;
    if (isMyThought(c)) myThoughts++;
    if (String(c.tags || '').includes('私密')) privateIdeas++;

    const p = localParts(c.created_at);
    if (p) {
      hours[p.hour]++;
      weekdays[p.weekday]++;
      monthMap.set(p.month, (monthMap.get(p.month) || 0) + 1);
      days.add(p.day);
    }
  }

  // 草稿按作品取最新版本，避免多版本重复计字
  const latestDraft = new Map();
  for (const d of drafts) {
    if (!latestDraft.has(d.work_id) || Number(d.version) > Number(latestDraft.get(d.work_id).version)) {
      latestDraft.set(d.work_id, d);
    }
  }
  const draftWords = [...latestDraft.values()].reduce((s, d) => s + cleanLen(d.content), 0);

  const topBooks = [...bookMap.values()].sort((a, b) => b.cards - a.cards).slice(0, 12);
  const totalBookCards = [...bookMap.values()].reduce((s, b) => s + b.cards, 0);
  const top3 = pct(topBooks.slice(0, 3).reduce((s, b) => s + b.cards, 0), totalBookCards);

  const types = [...typeCounts].map(([type, count]) => ({ type, label: TYPE_LABEL[type] || type, count }))
    .sort((a, b) => b.count - a.count);
  const tags = [...tagCounts].map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count).slice(0, 30);
  const topics = extractTopics(cards);

  const domains = DOMAINS.map(d => ({ ...d, cards: 0, myThoughts: 0, linked: 0, samples: [] }));
  const samplePool = new Map(domains.map(d => [d.key, []]));
  for (const c of cards) {
    const text = String(c.content || '') + ' ' + String(c.source || '') + ' ' + String(c.tags || '');
    for (const d of domains) {
      if (!d.words.some(w => text.includes(w))) continue;
      d.cards++;
      if (isMyThought(c)) d.myThoughts++;
      if (linked.has(c.id)) d.linked++;
      samplePool.get(d.key).push(c);
    }
  }
  for (const d of domains) {
    // 下钻样本优先给「自己写过想法」的卡片，其次取较新的
    d.samples = samplePool.get(d.key)
      .sort((a, b) => (Number(isMyThought(b)) - Number(isMyThought(a))) ||
        String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 4)
      .map(c => ({ id: c.id, excerpt: excerpt(c.content), source: c.source, created_at: c.created_at, myThought: isMyThought(c) }));
  }
  const domainList = domains.map(({ words, ...rest }) => rest)
    .filter(d => d.cards > 0).sort((a, b) => b.cards - a.cards);

  const dayList = [...days].sort();
  const firstDay = dayList[0] || '', lastDay = dayList[dayList.length - 1] || '';
  const spanDays = firstDay ? Math.round((new Date(lastDay) - new Date(firstDay)) / 86400000) + 1 : 0;
  let streak = 0, bestStreak = 0, prev = null;
  for (const d of dayList) {
    streak = (prev && (new Date(d) - new Date(prev)) / 86400000 === 1) ? streak + 1 : 1;
    if (streak > bestStreak) bestStreak = streak;
    prev = d;
  }
  const months = [...monthMap].map(([month, count]) => ({ month, count })).sort((a, b) => a.month.localeCompare(b.month)).slice(-12);

  // 与紧邻的前一个等长时段对比：看兴趣往哪移，而不只是累计了多少
  let comparison = null;
  if (bounds) {
    const curT = topicRates(cards), prevT = topicRates(prevCards);
    const words = new Set([...curT.rates.keys(), ...prevT.rates.keys()]);
    const diffs = [...words].map(w => ({
      word: w,
      delta: Math.round(((curT.rates.get(w) || 0) - (prevT.rates.get(w) || 0)) * 1000) / 10,
      cur: curT.counts.get(w) || 0, prev: prevT.counts.get(w) || 0
    })).filter(x => x.cur + x.prev >= 2 && Math.abs(x.delta) >= 0.5)
      .sort((a, b) => b.delta - a.delta);
    const curBooks = new Set(cards.map(c => bookTitle(c.source)).filter(Boolean));
    const prevBooks = new Set(prevCards.map(c => bookTitle(c.source)).filter(Boolean));
    comparison = {
      days: bounds.days,
      current: { start: bounds.start, end: bounds.end, cards: cards.length, thoughts: cards.filter(isMyThought).length, books: curBooks.size },
      previous: { start: bounds.prevStart, end: bounds.prevEnd, cards: prevCards.length,
        thoughts: prevCards.filter(isMyThought).length, books: prevBooks.size },
      rising: dedupeDiffs(diffs.filter(x => x.delta > 0), 6),
      falling: dedupeDiffs(diffs.filter(x => x.delta < 0).reverse(), 6),
      newBooks: [...curBooks].filter(b => !prevBooks.has(b)).slice(0, 8),
      enough: prevCards.length >= 5 && cards.length >= 5
    };
  }

  // 未加工素材：摘录了、没写过自己的想法、也没挂到任何作品
  const unused = cards.filter(c => isImported(c) && !isMyThought(c) && !linked.has(c.id));
  const unusedByBook = new Map();
  for (const c of unused) {
    const b = bookTitle(c.source) || '未标注来源';
    unusedByBook.set(b, (unusedByBook.get(b) || 0) + 1);
  }
  const recentUnused = [...unused].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const unusedSamples = [], usedBooks = new Set();
  for (const c of recentUnused) {
    const b = bookTitle(c.source) || '未标注来源';
    if (usedBooks.has(b)) continue;
    usedBooks.add(b);
    unusedSamples.push({ id: c.id, excerpt: excerpt(c.content), source: c.source, created_at: c.created_at });
    if (unusedSamples.length >= 8) break;
  }
  for (const c of recentUnused) {
    if (unusedSamples.length >= 8) break;
    if (unusedSamples.some(s => s.id === c.id)) continue;
    unusedSamples.push({ id: c.id, excerpt: excerpt(c.content), source: c.source, created_at: c.created_at });
  }
  const unusedTop = [...unusedByBook].map(([title, count]) => ({ title, count }))
    .sort((a, b) => b.count - a.count).slice(0, 8);

  const peakHour = hours.indexOf(Math.max(...hours));
  const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const peakDay = weekdays.indexOf(Math.max(...weekdays));
  const topWords = topics.slice(0, 6).map(t => t.word).join('、') || '（暂无足够数据）';
  const topDomain = domainList[0], secondDomain = domainList[1];

  const signals = [];
  signals.push({
    icon: '◎', title: '注意力反复落在哪里',
    text: '笔记覆盖 ' + bookMap.size + ' 本书，前 3 本占了 ' + top3 + '% 的卡片 —— ' +
      (top3 >= 60 ? '偏深钻：在少数几本书里反复停留。' : top3 >= 30 ? '深浅兼顾：有主攻，也有广泛涉猎。' : '偏广览：注意力分散在很多书上。'),
    evidence: topBooks.slice(0, 3).map(b => '《' + b.title + '》' + b.cards + ' 张').join(' · ') || '尚无书名来源'
  });
  signals.push({
    icon: '✳', title: '不靠安排也会回来的主题',
    text: '按「出现在多少张卡片」统计，最常出现的是 ' + topWords + '。这些词不是你设定的分类，是从原文里自己浮出来的，通常更接近真实兴趣。',
    evidence: '统计口径：仅正文的中文 2~4 字片段按「覆盖多少张卡片」计数，已排除系统标签、章节编号、通用词与滑动窗口碎片'
  });
  signals.push({
    icon: '⇄', title: '输入与自己的话',
    text: cards.length + ' 张卡片里，' + imported + ' 张来自读书导入，' + selfWritten + ' 张是自己手记；' +
      myThoughts + ' 张带了你自己的想法（占读书卡片 ' + pct(myThoughts, imported) + '%）。' +
      (pct(myThoughts, imported) < 15
        ? '目前以摘录为主，批注痕迹还不多——想让素材变成能力，最值得加的是「读完顺手写一句自己的判断」。'
        : '你不只是摘，还在持续做判断，这是素材转向能力的信号。'),
    evidence: '私密想法 ' + privateIdeas + ' 张 · 手记 ' + selfWritten + ' 张'
  });
  if (topDomain) {
    signals.push({
      icon: '◈', title: '可能在积累的方向',
      text: '按关键词粗分，最厚的一层是「' + topDomain.label + '」（' + topDomain.cards + ' 张卡片，其中 ' +
        topDomain.myThoughts + ' 张有自己的想法、' + topDomain.linked + ' 张已挂到作品）' +
        (secondDomain ? '，其次是「' + secondDomain.label + '」（' + secondDomain.cards + ' 张）' : '') + '。',
      evidence: '方向由关键词字典粗分，一张卡可属多个方向，仅供参照'
    });
  }
  signals.push({
    icon: '◷', title: '记录的节律',
    text: '有记录的日子共 ' + days.size + ' 天，跨度 ' + spanDays + ' 天，最长连续 ' + bestStreak + ' 天；' +
      '最常出现在 ' + peakHour + ':00 前后、' + weekNames[peakDay] + ' 最多。' +
      (bestStreak >= 7 ? '这个连续度说明记录已经接近习惯。' : '连续度还不高，但偶发记录同样能沉淀素材。'),
    evidence: '月份分布与 24 小时分布见下方图表（按本机时区）'
  });
  signals.push({
    icon: '✎', title: '从碎片到成稿',
    text: works.length + ' 部作品、' + outline.length + ' 个大纲节点、' + characters.length +
      ' 张人物卡，最新草稿共 ' + draftWords + ' 字；' + pct(linked.size, cards.length) + '% 的卡片挂到了作品上。' +
      (linked.size / Math.max(cards.length, 1) < 0.05
        ? '挂载率很低，说明卡片池目前更像素材仓库而非写作流水线——这没问题，回顾页就是为它准备的。'
        : '已有素材进入作品，可以看看哪个方向的转化最顺。'),
    evidence: '草稿字数按每部作品的最新版本计算，不含历史版本'
  });
  if (unused.length) {
    signals.push({
      icon: '↗', title: '下一步可以动手的地方',
      text: unused.length + ' 张卡片是「摘录了、却没写过自己的想法，也没挂到任何作品」。它们不是垃圾，是最容易被忘掉的半成品 —— 下方按书各挑了一条，随手挑一张补一句自己的判断，就把输入变成了输出。',
      evidence: '分布在 ' + unusedByBook.size + ' 本书里，清单按不同书各取一条'
    });
  }
  signals.push({
    icon: '※', title: '怎么读这份分析',
    text: '数据只能显示你把时间和注意力反复投在哪里，不能替你判断天赋。若某个方向同时满足「反复出现 + 有自己的想法 + 已经长进草稿」，它更可能已经从兴趣变成了能力——下方方向表里「摘录 / 想法 / 已挂作品」三层就是给这个判断用的。',
    evidence: '所有数字来自本机 SQLite，不联网、不做外部比对'
  });

  const value = {
    generated_at: new Date().toISOString(),
    overview: {
      cards: cards.length, books: bookMap.size, works: works.length,
      imported, selfWritten, myThoughts, privateIdeas,
      draftWords, outline: outline.length, characters: characters.length,
      linked: linked.size, tags: tagCounts.size,
      firstDay, lastDay, activeDays: days.size, spanDays, bestStreak,
      top3Share: top3, ideaRate: pct(myThoughts, imported),
      linkRate: pct(linked.size, cards.length)
    },
    types, tags, topics, topBooks, domains: domainList,
    rhythm: { hours, weekdays, months },
    signals,
    range, bounds, comparison,
    unused: { count: unused.length, books: unusedByBook.size, byBook: unusedTop, samples: unusedSamples }
  };
  cache = { key, at: Date.now(), value };
  return value;
}

// 导出可留档的 Markdown 报告：每月存一份，半年后能比出注意力的迁移
function report(options = {}) {
  const d = compute(options), o = d.overview;
  const L = [];
  L.push('# 创作洞察 · ' + new Date().toISOString().slice(0, 10));
  L.push('');
  L.push('> 由本机创作台生成，按素材原始记录时间统计。只呈现注意力痕迹，不是能力测评。');
  L.push('> 时间范围：' + (d.bounds ? d.bounds.start + ' ~ ' + d.bounds.end + '（近 ' + d.bounds.days + ' 天）' : '全部'));
  L.push('');
  L.push('## 一、概览');
  L.push('');
  L.push('| 指标 | 数值 |');
  L.push('| --- | --- |');
  const rows = [
    ['区间卡片数', o.cards], ['涉及书籍', o.books], ['读书导入 / 自己手记', o.imported + ' / ' + o.selfWritten],
    ['带自己想法的卡片', o.myThoughts + '（占读书卡片 ' + o.ideaRate + '%）'],
    ['前 3 本书占比', o.top3Share + '%'], ['已挂到作品的卡片', o.linkRate + '%'],
    ['作品 / 大纲节点 / 人物卡（全库）', o.works + ' / ' + o.outline + ' / ' + o.characters],
    ['最新草稿字数（全库）', o.draftWords],
    ['有记录天数 / 跨度 / 最长连续', o.activeDays + ' / ' + o.spanDays + ' / ' + o.bestStreak],
    ['不同标签', o.tags]
  ];
  for (const [k, v] of rows) L.push('| ' + k + ' | ' + v + ' |');
  L.push('');
  L.push('## 二、观察与依据');
  L.push('');
  for (const s of d.signals) {
    L.push('### ' + s.icon + ' ' + s.title);
    L.push('');
    L.push(s.text);
    L.push('');
    L.push('> 依据：' + s.evidence);
    L.push('');
  }
  L.push('## 三、阅读版图');
  L.push('');
  L.push('| 书名 | 卡片 | 其中自己的想法 |');
  L.push('| --- | ---: | ---: |');
  for (const b of d.topBooks) L.push('| 《' + b.title.replace(/\|/g, '／') + '》 | ' + b.cards + ' | ' + b.thoughts + ' |');
  L.push('');
  L.push('## 四、方向沉淀（摘录 → 自己的想法 → 已挂作品）');
  L.push('');
  L.push('| 方向 | 摘录 | 自己的想法 | 已挂作品 |');
  L.push('| --- | ---: | ---: | ---: |');
  for (const x of d.domains) L.push('| ' + x.label + ' | ' + x.cards + ' | ' + x.myThoughts + ' | ' + x.linked + ' |');
  L.push('');
  L.push('> 方向由关键词字典粗分，一张卡可属多个方向，仅供参照。');
  L.push('');
  L.push('## 五、主题词');
  L.push('');
  L.push(d.topics.map(t => t.word + '(' + t.count + ')').join(' · ') || '（样本不足）');
  L.push('');
  if (d.comparison) {
    const c = d.comparison;
    L.push('## 六、与上一个 ' + c.days + ' 天对比');
    L.push('');
    L.push('| 指标 | 本期 | 上期 |');
    L.push('| --- | ---: | ---: |');
    L.push('| 卡片 | ' + c.current.cards + ' | ' + c.previous.cards + ' |');
    L.push('| 自己的想法 | ' + c.current.thoughts + ' | ' + c.previous.thoughts + ' |');
    L.push('| 涉及书籍 | ' + c.current.books + ' | ' + c.previous.books + ' |');
    L.push('');
    L.push('- 升温：' + (c.rising.map(x => x.word + ' +' + x.delta + '%').join('、') || '（无明显变化）'));
    L.push('- 降温：' + (c.falling.map(x => x.word + ' ' + x.delta + '%').join('、') || '（无明显变化）'));
    L.push('- 新出现的书：' + (c.newBooks.map(b => '《' + b + '》').join('、') || '（无）'));
    if (!c.enough) L.push('');
    if (!c.enough) L.push('> 两期样本都不足 5 张，对比仅供参考。');
    L.push('');
  }
  L.push('## ' + (d.comparison ? '七' : '六') + '、未加工素材');
  L.push('');
  L.push('共 ' + d.unused.count + ' 张摘录没有自己的想法、也没挂到作品，分布在 ' + d.unused.books + ' 本书里。');
  L.push('');
  for (const b of d.unused.byBook) L.push('- 《' + b.title + '》 ' + b.count + ' 张');
  L.push('');
  L.push('按书各取一条，作为下次动笔的入口：');
  L.push('');
  for (const s of d.unused.samples) L.push('- ' + (s.source ? s.source + '：' : '') + s.excerpt + '…');
  L.push('');
  L.push('## ' + (d.comparison ? '八' : '七') + '、时间节律');
  L.push('');
  const peak = d.rhythm.hours.indexOf(Math.max(...d.rhythm.hours));
  const wk = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const peakDay = d.rhythm.weekdays.indexOf(Math.max(...d.rhythm.weekdays));
  L.push('记录最多的时段是 ' + peak + ':00 前后，' + wk[peakDay] + '最多。');
  L.push('');
  L.push('| 月份 | 卡片 |');
  L.push('| --- | ---: |');
  for (const m of d.rhythm.months) L.push('| ' + m.month + ' | ' + m.count + ' |');
  L.push('');
  L.push('---');
  L.push('');
  L.push('生成于 ' + d.generated_at + '，数据全部来自本机 SQLite，不联网、不上传。');
  return L.join('\n');
}

module.exports = { compute, report, extractTopics, bookTitle };
