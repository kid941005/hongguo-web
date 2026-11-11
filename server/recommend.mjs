// 猜你喜欢：基于观看历史的推荐。
// 三个信号源（按权重叠加）：
//   1) 协同过滤：所有用户的历史里，和你的片单共同出现过的其它剧（跨账号聚合，只读、不外泄他人数据）
//   2) 内容相似：标题二元组相似度（复用 catalog 的 titleScore 思路），候选来自你的源首页 + 红果推荐池
//   3) 热门兜底：红果推荐池按真实评分排序，冷启动或候选不足时填充
// 结果按 key 稳定排序并缓存 2 分钟，所以同一账号在不同设备上看到的是同一份列表。

const CACHE_MS = 2 * 60 * 1000;
const MAX_SEEDS = 12;
const MAX_ITEMS = 36;
const MAX_GUEST_SEEDS = 20;
const SIM_MIN = 0.5;
const POOL_TIMEOUT = 8000;

function str(value, max) {
  return String(value == null ? "" : value).slice(0, max);
}
function keyOf(item) {
  return (item && item.source ? String(item.source) : "") + "|" + (item && item.id ? String(item.id) : "");
}
function withTimeout(promise, ms, message) {
  let timer = 0;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      if (timer.unref) timer.unref();
    }),
  ]);
}

function titleKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\u3000·・:：!！?？,，.。、\-—_~～|/\\()（）\[\]【】{}<>《》"'“”‘’#*+]/g, "")
    .replace(/(短剧|全集|全\d+集|已完结|更新至\d+集?|第[一二三四五六七八九十百\d]+季)/g, "");
}
function titleScore(a, b) {
  const x = titleKey(a);
  const y = titleKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))) return 0.9;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = (text) => {
    const set = new Set();
    for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
    return set;
  };
  const gx = grams(x);
  const gy = grams(y);
  let hit = 0;
  for (const gram of gx) if (gy.has(gram)) hit += 1;
  return (2 * hit) / (gx.size + gy.size);
}

function normalizeSeeds(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const id = str(raw.id, 128);
    if (!id) continue;
    const item = { source: str(raw.source, 64), id, title: str(raw.title, 200), cover: str(raw.cover, 500) };
    const k = keyOf(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
    if (out.length >= MAX_GUEST_SEEDS) break;
  }
  return out;
}

export function createRecommend({ catalog, users = null, sources = null, log = console } = {}) {
  const cache = new Map();

  function sourceName(id) {
    try {
      const entry = sources && sources.get ? sources.get(id) : null;
      if (entry && entry.name) return entry.name;
    } catch { /* 源不存在时回落到 id */ }
    return id === "hongguo" ? "红果短剧" : String(id || "");
  }

  function trimCache() {
    if (cache.size <= 300) return;
    const rows = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (let i = 0; i < rows.length - 200; i += 1) cache.delete(rows[i][0]);
  }

  async function build({ user, seeds }) {
    const seedKeys = new Set(seeds.map(keyOf));
    const scores = new Map();

    function bump(item, points, reason) {
      if (!item || !item.id || !points) return;
      const k = keyOf(item);
      if (seedKeys.has(k)) return; // 已经看过的剧不再推荐
      let row = scores.get(k);
      if (!row) {
        row = { item: { id: String(item.id), source: String(item.source || ""), title: str(item.title, 200), cover: str(item.cover, 500), remarks: str(item.remarks, 200), tags: Array.isArray(item.tags) ? item.tags.slice(0, 4) : [] }, points: 0, reasons: {}, top: "popular" };
        scores.set(k, row);
      }
      row.points += points;
      row.reasons[reason] = (row.reasons[reason] || 0) + points;
    }

    // ---- 1) 协同过滤：和我的片单共同出现在别人历史里的剧 ----
    let supporters = 0;
    if (user && users && typeof users.allHistory === "function" && seeds.length) {
      let lists = [];
      try { lists = users.allHistory(400); } catch (error) { log.error(JSON.stringify({ event: "recommend_all_history_failed", message: String((error && error.message) || error) })); }
      for (const entry of lists) {
        if (!entry || !Array.isArray(entry.items) || !entry.items.length) continue;
        if (entry.userId === user.id) continue; // 只参考其他人的片单，自己的记录已作为种子
        const list = entry.items;
        const shared = list.filter((it) => seedKeys.has(keyOf(it))).length;
        if (!shared) continue; // 只统计与本账号有交集的用户
        supporters += 1;
        const base = 1.5 * (shared / Math.max(1, seeds.length));
        list.forEach((it, index) => {
          bump(it, base * (1 / (1 + index * 0.06)), "collab");
        });
      }
    }

    // ---- 2) 热门池（红果推荐池，带真实评分） ----
    const pool = [];
    for (const page of [1, 2]) {
      try {
        const r = await withTimeout(catalog.recommend(page), POOL_TIMEOUT, "推荐池超时");
        (r.items || []).forEach((it) => pool.push({ ...it, source: it.source || "hongguo" }));
      } catch { /* 推荐池拉取失败只影响填充数量 */ }
    }
    pool.forEach((it, index) => {
      const decay = 1 - index / Math.max(1, pool.length);
      bump(it, 0.45 * decay, "popular");
    });

    // ---- 3) 内容相似：从种子所在源的首页找同题材 ----
    if (seeds.length) {
      const uniqSources = [...new Set(seeds.map((s) => s.source).filter(Boolean))].slice(0, 2);
      const settled = await Promise.allSettled(
        uniqSources.map((src) => withTimeout(catalog.home(src, 1), POOL_TIMEOUT, "相似候选超时").then((r) => ({ src, items: r.items || [] }))),
      );
      for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        for (const it of result.value.items) {
          const candidate = { ...it, source: it.source || result.value.src };
          let best = 0;
          for (const seed of seeds) best = Math.max(best, titleScore(candidate.title, seed.title));
          if (best >= SIM_MIN) bump(candidate, 2 * best, "similar");
        }
      }
    }

    // ---- 排序 + 组装 ----
    const REASON_TEXT = { collab: "同好也在看", similar: "相似内容", popular: "热门" };
    const rows = [...scores.values()].sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      const ax = titleKey(a.item.title) + "|" + keyOf(a.item);
      const bx = titleKey(b.item.title) + "|" + keyOf(b.item);
      return ax < bx ? -1 : ax > bx ? 1 : 0;
    });
    const counts = { collab: 0, similar: 0, popular: 0 };
    const items = rows.slice(0, MAX_ITEMS).map((row) => {
      let top = "popular", topPts = 0;
      for (const name of Object.keys(row.reasons)) {
        if (row.reasons[name] > topPts) { top = name; topPts = row.reasons[name]; }
      }
      row.top = top;
      counts[top] = (counts[top] || 0) + 1;
      return {
        ...row.item,
        sourceName: sourceName(row.item.source),
        reason: REASON_TEXT[top] || "热门",
        score: Math.round(row.points * 100) / 100,
      };
    });
    const mode = counts.collab > 0 ? "collab" : counts.similar > 0 ? "similar" : "popular";
    return {
      items,
      basis: { mode, seeds: seeds.length, coUsers: supporters, total: items.length, counts },
      generatedAt: Date.now(),
    };
  }

  async function forYou({ user = null, seeds = [] } = {}) {
    const account = user && user.id ? user : null;
    let seedList = [];
    if (account && users) {
      try { seedList = normalizeSeeds(users.listHistory(account.id, MAX_SEEDS)); } catch { seedList = []; }
    } else {
      seedList = normalizeSeeds(seeds).slice(0, MAX_SEEDS);
    }
    const key = account ? "u" + account.id : "g" + seedList.map(keyOf).sort().join(",");
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.value, cached: true };
    const value = await build({ user: account, seeds: seedList });
    cache.set(key, { at: Date.now(), value });
    trimCache();
    return { ...value, cached: false };
  }

  return { forYou };
}
