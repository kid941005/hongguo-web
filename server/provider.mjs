import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import zlib from "node:zlib";
import axios from "axios";
import { fail } from "./errors.mjs";

// Trusted, pinned GPL source. This is a compatibility wrapper, not a sandbox for user scripts.
const source = fs.readFileSync(
  new URL("./vendor/hongguo.cjs", import.meta.url),
  "utf8"
);
const context = vm.createContext({
  require: (name) => {
    if (name === "node:crypto") return crypto;
    if (name === "node:zlib") return zlib;
    throw new Error("Unsupported module");
  },
  Buffer,
  URL,
  URLSearchParams,
  log: () => {},
  setResult: (value) => value,
  axios: axios.create({
    timeout: 30000,
    maxContentLength: 16 * 1024 * 1024,
    maxBodyLength: 1024 * 1024,
  }),
});
vm.runInContext(
  source +
    "\nthis.api = {categoryPage, categoryData, itemToCard, appSearchPage, routerData, resolveStream, prepareHeader, remoteRange, decryptPartial, streamCache, videoInfoCache, pageCache, appSearchCache, rankPageRich, rule, CATEGORIES, CATEGORY_CONFIG, FILTERS};",
  context,
  { timeout: 5000 }
);
const api = context.api;
const SITE = "https://hongguoduanju.com";
const card = (row) => ({
  id: String(row.url),
  title: row.title,
  cover: row.img || "",
  description: row.content || "",
  badge: row.desc || "",
  tags: row.tname || "",
});
const cards = (rows) =>
  Array.from(rows)
    .filter((r) => /^\d+$/.test(String(r.url)) && r.title)
    .map(card);

// ---- 推荐页数据源：红果四条榜单（真实评分） ----
const RANK_ROUTES = ["hot-drama", "hot-real-drama", "hot-comic-drama", "hot-ai-drama"];
const RECOMMEND_POOL_PAGES = 5; // 每条榜抓 5 页（每页 20 条）
const RECOMMEND_TTL = 10 * 60 * 1000;
let recommendPool = null;
let recommendPoolAt = 0;
let recommendPoolPending = null;

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    if (timer && timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const rankCard = (row) => ({
  id: String(row.url || ""),
  title: String(row.title || ""),
  cover: row.img || "",
  remarks: row.desc || "",
  description: row.content || "",
  tags: row.tname || "",
  score: Number(row.score) || 0,
  heat: row.heat || "",
  bang: row.bang || "",
  rank: Number(row.rank) || 0,
});

// 并发抓四条榜的全部分页，按 seriesId 去重、按真实评分降序（同分比热度）。
// 单页失败只丢该页，不让整批推荐失败。
async function buildRecommendPool() {
  const jobs = [];
  for (const route of RANK_ROUTES)
    for (let page = 1; page <= RECOMMEND_POOL_PAGES; page += 1) jobs.push([route, page]);
  const rows = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < jobs.length) {
      const [route, page] = jobs[cursor++];
      try {
        const data = await withTimeout(api.rankPageRich(route, page), 20000, "榜单页超时");
        for (const item of data.list) rows.push(item);
      } catch {
        /* 单页失败/超时忽略 */
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  const seen = new Map();
  for (const row of rows) {
    const key = String(row.url || "");
    if (!key) continue;
    const prev = seen.get(key);
    if (!prev || row.score > prev.score || (row.score === prev.score && row.heatValue > prev.heatValue))
      seen.set(key, row);
  }
  const list = Array.from(seen.values())
    .sort((a, b) => b.score - a.score || b.heatValue - a.heatValue || a.rank - b.rank)
    .map(rankCard);
  if (!list.length) throw new Error("推荐榜单暂不可用");
  return list;
}

export const provider = {
  async home(page = 1) {
    const data = await api.categoryPage("tab=1&sort_type=1", page);
    const pageData =
      data?.loaderData?.category_page || data?.loaderData?.["category_$"];
    if (!Array.isArray(pageData?.recommendList))
      throw new Error("首页数据结构已变化");
    return {
      items: cards(pageData.recommendList.map(api.itemToCard)),
      page,
      classes: api.CATEGORIES.map((entry) => ({
        id: String(entry.type_id),
        name: String(entry.type_name || entry.type_id),
      })),
      filters: api.FILTERS,
    };
  },
  async category(typeId, page = 1, filters = {}) {
    const id = String(typeId || "short");
    const config = api.CATEGORY_CONFIG[id] || api.CATEGORY_CONFIG.short;
    if (!config) throw new Error("未知分类");
    if (config.kind === "category") {
      const query = new URLSearchParams(config.query || "");
      for (const [key, value] of Object.entries(filters || {})) {
        if (value === undefined || value === null || value === "") continue;
        query.set(key, String(value));
      }
      const data = await api.categoryPage(query.toString(), page);
      const pageData =
        data?.loaderData?.category_page || data?.loaderData?.["category_$"];
      const rows = pageData?.recommendList || pageData?.categoryData?.recommendList;
      if (!Array.isArray(rows)) throw new Error("分类数据结构已变化");
      const pagination = pageData?.pagination || {};
      const totalPages = Number(pagination.totalPages) || 0;
      return {
        items: cards(rows.map(api.itemToCard)),
        page,
        hasMore: totalPages ? page < totalPages : rows.length >= 24,
      };
    }
    const rows = await api.rule["一级"](id, page, {}, filters || {});
    const items = cards(Array.isArray(rows) ? rows : []);
    return { items, page, hasMore: items.length >= 20 };
  },
  async search(keyword, page = 1) {
    try {
      const result = await api.appSearchPage(keyword, 11, page, 20);
      if (result.list.length) return { items: cards(result.list), page };
    } catch {
      /* Website fallback; failure below remains an error, never an empty success. */
    }
    const data = await api.routerData(
      `${SITE}/search/${encodeURIComponent(keyword)}?page=${page}`
    );
    const pageData =
      data?.loaderData?.["search_(keyword)/page"] ||
      data?.loaderData?.search_page;
    if (!Array.isArray(pageData?.searchList)) throw new Error("搜索数据不可用");
    return { items: cards(pageData.searchList.map(api.itemToCard)), page };
  },
  async detail(id) {
    const data = await api.routerData(`${SITE}/detail?series_id=${id}`);
    const series = data?.loaderData?.detail_page?.seriesDetail;
    if (!series || !Array.isArray(series.vid_list) || !series.vid_list.length)
      throw new Error("剧集不存在或分集暂不可用");
    const episodes = Array.from(series.vid_list, (vid, index) => ({
      id: String(vid),
      title: `第 ${index + 1} 集`,
      number: index + 1,
    }));
    if (
      episodes.some((e) => !/^\d+$/.test(e.id)) ||
      new Set(episodes.map((e) => e.id)).size !== episodes.length
    )
      throw new Error("分集数据异常");
    return { ...card(api.itemToCard(series)), id, episodes };
  },
  async recommendPool() {
    if (recommendPool && Date.now() - recommendPoolAt < RECOMMEND_TTL) return recommendPool;
    if (!recommendPoolPending) {
      recommendPoolPending = buildRecommendPool()
        .then((list) => {
          recommendPool = list;
          recommendPoolAt = Date.now();
          recommendPoolPending = null;
          return list;
        })
        .catch((error) => {
          recommendPoolPending = null;
          throw error;
        });
    }
    return recommendPoolPending;
  },
  async stream(id, fresh = false, track = true) {
    if (fresh) {
      api.streamCache.delete(`${id}|auto`);
      api.videoInfoCache.delete(id);
    }
    const now = Date.now();
    if (STREAM_BREAKER.openUntil > now) {
      throw fail("UPSTREAM_EMPTY", "红果播放源暂不可用，正在自动恢复，请切换数据源或稍后重试");
    }
    if (track) METRICS.attempts += 1;
    try {
      const stream = await api.resolveStream(id, "auto");
      const prepared = await api.prepareHeader(stream);
      if (track) {
        STREAM_BREAKER.fails = 0;
        STREAM_BREAKER.openUntil = 0;
      }
      return {
        total: prepared.total,
        chunk: async (start, end) =>
          api.decryptPartial(
            (await api.remoteRange(stream, start, end)).data,
            start,
            stream.key,
            prepared
          ),
      };
    } catch (error) {
      const message = String((error && error.message) || error);
      if (track) {
        STREAM_BREAKER.fails += 1;
        STREAM_BREAKER.lastError = message;
        METRICS.failures += 1;
        METRICS.lastError = message;
        METRICS.lastErrorAt = Date.now();
      }
      if (/空响应|video_model|video_tab|device_register/.test(message)) {
        if (track) METRICS.empty += 1;
        if (track && STREAM_BREAKER.fails >= STREAM_BREAKER_THRESHOLD) {
          STREAM_BREAKER.openUntil = Date.now() + STREAM_BREAKER_COOLDOWN;
        }
        throw fail("UPSTREAM_EMPTY", "红果播放源暂不可用：" + message);
      }
      throw fail("UPSTREAM_ERROR", "红果播放源异常：" + message);
    }
  },
  metrics() {
    return {
      stream: {
        attempts: METRICS.attempts,
        failures: METRICS.failures,
        empty: METRICS.empty,
        lastError: METRICS.lastError,
        lastErrorAt: METRICS.lastErrorAt,
      },
      breaker: {
        fails: STREAM_BREAKER.fails,
        open: STREAM_BREAKER.openUntil > Date.now(),
        openUntil: STREAM_BREAKER.openUntil,
        lastError: STREAM_BREAKER.lastError,
      },
    };
  },
};

// Limit the pinned upstream's otherwise unbounded caches during long-lived home use.
const STREAM_BREAKER_THRESHOLD = 3;
const STREAM_BREAKER_COOLDOWN = 45000;
const STREAM_BREAKER = { fails: 0, openUntil: 0, lastError: "" };
const METRICS = { attempts: 0, failures: 0, empty: 0, lastError: "", lastErrorAt: 0 };

const CACHE_TTL = 300000;
const CACHE_MAX = 100;
setInterval(() => {
  for (const cache of [api.streamCache, api.videoInfoCache, api.pageCache, api.appSearchCache]) {
    for (const [key, value] of cache) {
      const time = value && typeof value.time === "number" ? value.time : 0;
      if (Date.now() - time > CACHE_TTL) cache.delete(key);
    }
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }
}, 60000).unref();
