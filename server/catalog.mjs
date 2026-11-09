import { fail } from "./errors.mjs";

// 统一目录层：把「内置红果解密源」与「糖葫芦 / CatPawOpen 风格 JS 源」归一成同一套接口。
// 约定：所有对外方法都返回 { source, items|lines|episodes, ... }，字段缺失一律给空值而不是 undefined。

const TIMEOUT_HOME = 40000;
const TIMEOUT_SEARCH = 60000;
const RECOMMEND_PER_PAGE = 24;

function pick(...values) {
  for (const value of values) if (value !== undefined && value !== null && value !== "") return value;
  return "";
}

function normVod(vod) {
  if (!vod || typeof vod !== "object") return null;
  const id = String(pick(vod.vod_id, vod.id, vod.vid));
  if (!id) return null; // 没有 id 的条目点进去必然 400，直接丢弃
  const score = Number(pick(vod.score, 0)) || 0;
  return {
    id,
    title: String(pick(vod.vod_name, vod.title, vod.name)),
    cover: String(pick(vod.vod_pic, vod.cover, vod.img, vod.pic)),
    remarks: String(pick(vod.vod_remarks, vod.badge, vod.remarks, vod.note)),
    year: String(pick(vod.vod_year, vod.year)),
    area: String(pick(vod.vod_area, vod.area)),
    desc: String(pick(vod.vod_content, vod.description, vod.desc)),
    // 推荐页专用：真实评分/热度/榜名，其它源缺省为 0/空
    score,
    heat: String(pick(vod.heat)),
    bang: String(pick(vod.bang)),
    rank: Number(pick(vod.rank, 0)) || 0,
  };
}

function toItems(list) {
  return (Array.isArray(list) ? list : []).map(normVod).filter(Boolean);
}

// vod_play_url: 线路用 $$$ 分隔，集用 # 分隔，每集「集名$集ID」
function splitPlayUrl(vodPlayUrl, vodPlayFrom) {
  const urlStr = String(vodPlayUrl || "");
  if (!urlStr) return [];
  const froms = String(vodPlayFrom || "").split("$$$");

  return urlStr
    .split("$$$")
    .map((line, lineIndex) => {
      const episodes = line
        .split("#")
        .map((chunk, epIndex) => {
          const text = String(chunk || "").trim();
          if (!text) return null;
          const cut = text.indexOf("$");
          const name = cut === -1 ? "" : text.slice(0, cut).trim();
          const id = cut === -1 ? text : text.slice(cut + 1).trim();
          if (!id) return null;
          return { id, name: name || "第 " + (epIndex + 1) + " 集" };
        })
        .filter(Boolean);
      const flag = froms[lineIndex] || "flag";
      return { flag, name: froms[lineIndex] || "线路 " + (lineIndex + 1), episodes };
    })
    .filter((line) => line.episodes.length);
}

function classifyUrl(url) {
  const value = String(url || "");
  if (/\.m3u8(\?|#|$)/i.test(value) || /\/m3u8/i.test(value) || /format=m3u8/i.test(value)) return "hls";
  if (/\.(mp4|m4v|mov)(\?|#|$)/i.test(value)) return "mp4";
  if (/\.(flv)(\?|#|$)/i.test(value)) return "flv";
  return "mp4";
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(fail("TIMEOUT", message)), ms);
    if (timer && timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 内置红果的官方搜索接口已被风控（返回空 body），退化为「首页推荐池本地检索」。
function createBuiltinSearch(provider) {
  const POOL_PAGES = 8;
  const BATCH = 3;
  const CACHE_MS = 10 * 60 * 1000;
  const PER_PAGE = 24;
  let cache = { time: 0, items: [] };

  async function refresh() {
    const items = [];
    const seen = new Set();
    for (let start = 1; start <= POOL_PAGES; start += BATCH) {
      const pages = [];
      for (let page = start; page < start + BATCH && page <= POOL_PAGES; page++) pages.push(page);
      const batches = await Promise.all(
        pages.map((page) => provider.home(page).then((r) => toItems(r.items)).catch(() => [])),
      );
      for (const batch of batches) {
        for (const item of batch) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            items.push(item);
          }
        }
      }
    }
    if (items.length) cache = { time: Date.now(), items };
    return cache;
  }

  return async function builtinSearch(keyword, page) {
    if (!cache.items.length || Date.now() - cache.time > CACHE_MS) await refresh();
    const kw = String(keyword).toLowerCase();
    const hits = cache.items.filter((item) =>
      String(item.title).toLowerCase().includes(kw) ||
      String(item.desc).toLowerCase().includes(kw) ||
      String(item.remarks).toLowerCase().includes(kw),
    );
    const start = (page - 1) * PER_PAGE;
    return {
      source: "hongguo",
      items: hits.slice(start, start + PER_PAGE),
      page,
      hasMore: start + PER_PAGE < hits.length,
      poolSize: cache.items.length,
      fallback: true,
    };
  };
}

export function createCatalog({ provider, sources }) {
  const builtinSearch = createBuiltinSearch(provider);

  function entryOf(sourceId) {
    const entry = sources.get(sourceId);
    if (!entry) throw fail("NOT_FOUND", "源不存在");
    return entry;
  }

  async function home(sourceId, page = 1) {
    const entry = entryOf(sourceId);
    const pageNo = Number(page) || 1;
    if (entry.type === "builtin") {
      const items = toItems((await provider.home(pageNo)).items);
      return { source: entry.id, kind: "builtin", classes: [], items, page: pageNo, hasMore: items.length >= 20 };
    }
    const runtime = sources.runtime(entry.id);
    const result = await runtime.call("home", [{}, false], TIMEOUT_HOME);
    const classes = Array.isArray(result && result.class)
      ? result.class
        .filter((c) => c && (c.type_id !== undefined || c.id !== undefined))
        .map((c) => ({ id: String(pick(c.type_id, c.id)), name: String(pick(c.type_name, c.name)) }))
      : [];
    let items = toItems(result && result.list);
    // 多数 JS 源的 home 只给分类、把列表放在 category 里（官方 hongguo.js 也是如此）。
    // 这里兜底取第一个分类的第一页，避免切到这类源时首页一片空白。
    if (!items.length && classes.length) {
      try {
        const first = await runtime.call("category", [classes[0].id, 1, {}, {}], TIMEOUT_HOME);
        items = toItems(first && first.list);
      } catch {
        items = []; // 兜底失败只影响首页推荐位，分类照常可用
      }
    }
    return {
      source: entry.id,
      kind: "js",
      classes,
      items,
      page: 1,
      hasMore: false,
      filters: (result && result.filters) || {},
    };
  }

  async function category(sourceId, tid, page, extend) {
    const entry = entryOf(sourceId);
    const pageNo = Number(page) || 1;
    if (entry.type === "builtin") {
      const items = toItems((await provider.home(pageNo)).items);
      return { source: entry.id, tid, items, page: pageNo, hasMore: items.length >= 20, classes: [] };
    }
    const result = await sources.runtime(entry.id).call("category", [String(tid), pageNo, {}, extend || {}], TIMEOUT_HOME);
    const items = toItems(result && result.list);
    const current = Number(result && result.page) || pageNo;
    const pageCount = Number(result && result.pagecount) || 0;
    return {
      source: entry.id,
      tid,
      items,
      page: current,
      hasMore: pageCount ? current < pageCount : items.length > 0,
    };
  }

  async function search(sourceId, keyword, page) {
    const entry = entryOf(sourceId);
    const pageNo = Number(page) || 1;
    if (entry.type === "builtin") return builtinSearch(keyword, pageNo);

    const result = await sources.runtime(entry.id).call("search", [keyword, false, pageNo], TIMEOUT_SEARCH);
    const items = toItems(result && result.list);
    const current = Number(result && result.page) || pageNo;
    const pageCount = Number(result && result.pagecount) || 0;
    return {
      source: entry.id,
      items,
      page: current,
      hasMore: pageCount ? current < pageCount : items.length > 0,
    };
  }

  async function detail(sourceId, id) {
    const entry = entryOf(sourceId);
    if (entry.type === "builtin") {
      const data = await provider.detail(String(id));
      const episodes = (data.episodes || []).map((ep) => ({ id: String(ep.id), name: ep.title }));
      return {
        source: entry.id,
        id: String(id),
        title: data.title,
        cover: data.cover,
        desc: data.description || "",
        remarks: data.badge || "",
        lines: episodes.length ? [{ flag: "hg", name: "红果（服务端解密）", episodes }] : [],
        episodes,
      };
    }

    const result = await sources.runtime(entry.id).call("detail", [String(id)], TIMEOUT_HOME);
    const vod = Array.isArray(result && result.list) ? result.list[0] : null;
    const norm = normVod(vod);
    if (!norm) throw fail("EMPTY", "详情为空");
    const lines = splitPlayUrl(vod.vod_play_url, vod.vod_play_from);
    return {
      source: entry.id,
      id: String(id),
      title: norm.title,
      cover: norm.cover,
      desc: norm.desc,
      remarks: norm.remarks,
      lines,
      episodes: lines.length ? lines[0].episodes : [],
    };
  }

  async function play(sourceId, { flag, id }) {
    const entry = entryOf(sourceId);
    if (!id) throw fail("BAD_INPUT", "缺少剧集 id");
    if (entry.type === "builtin") {
      if (!/^\d{1,30}$/.test(String(id))) throw fail("BAD_INPUT", "剧集 id 无效");
      return { type: "native", url: "/api/stream/" + id, contentType: "video/mp4" };
    }

    const out = await sources.runtime(entry.id).call("play", [String(flag || "flag"), String(id), []], TIMEOUT_SEARCH);
    let url = "";
    let headers = {};
    if (typeof out === "string") {
      url = out;
    } else if (out && typeof out === "object") {
      if (out.parse && Number(out.parse) !== 0)
        throw fail("NEED_PARSE", "该源需要 webview 嗅探解析（parse=1），网页版无法直接播放");
      url = String(pick(out.url, out.playUrl, out.play_url));
      headers = out.header || out.headers || {};
    }
    if (!url) throw fail("NO_URL", "该集没有可用播放地址");
    if (/^[0-9a-f]{32}$/i.test(url)) throw fail("ENCRYPTED", "该源返回加密标识而非播放地址，网页版暂不支持");

    const type = classifyUrl(url);
    const referer = headers.Referer || headers.referer || "";
    const encoded = encodeURIComponent(url);
    const proxyBase = type === "hls" ? "/api/hls?u=" : "/api/media?u=";
    return {
      type,
      url: proxyBase + encoded + (referer ? "&r=" + encodeURIComponent(referer) : ""),
      sourceUrl: url,
      headers,
    };
  }

  // 聚合搜索：并发问所有源（各取同一页），轮转交错合并，单源失败不影响整体。
  async function searchAll(keyword, page = 1) {
    const pageNo = Number(page) || 1;
    const groups = await Promise.all(
      sources.list().sources.map(async (source) => {
        const started = Date.now();
        try {
          const result = source.type === "builtin"
            ? await withTimeout(builtinSearch(keyword, pageNo), 30000, "内置源检索超时")
            : await search(source.id, keyword, pageNo);
          return {
            source: source.id,
            name: source.name,
            ms: Date.now() - started,
            items: (result.items || []).map((item) => ({ ...item, source: source.id, sourceName: source.name })),
            hasMore: Boolean(result.hasMore),
            fallback: Boolean(result.fallback),
            poolSize: result.poolSize || 0,
          };
        } catch (error) {
          return {
            source: source.id,
            name: source.name,
            ms: Date.now() - started,
            items: [],
            hasMore: false,
            error: String((error && error.message) || error).replace(/https?:\/\/\S+/g, "上游地址"),
          };
        }
      }),
    );

    const items = [];
    const longest = groups.reduce((max, group) => Math.max(max, group.items.length), 0);
    for (let i = 0; i < longest; i++) for (const group of groups) if (group.items[i]) items.push(group.items[i]);

    return {
      aggregate: true,
      q: keyword,
      page: pageNo,
      items,
      hasMore: groups.some((group) => group.hasMore),
      groups: groups.map((group) => ({
        source: group.source,
        name: group.name,
        count: group.items.length,
        ms: group.ms,
        hasMore: group.hasMore,
        fallback: group.fallback,
        poolSize: group.poolSize,
        error: group.error,
      })),
    };
  }

  // 推荐页：红果各榜单按真实评分合并后的稳定列表，按页切分给前端。
  async function recommend(page = 1) {
    const pageNo = Number(page) || 1;
    const pool = await provider.recommendPool();
    const start = (pageNo - 1) * RECOMMEND_PER_PAGE;
    const slice = pool.slice(start, start + RECOMMEND_PER_PAGE);
    return {
      source: "hongguo",
      sourceName: "红果推荐",
      recommend: true,
      page: pageNo,
      items: slice.map((row) => ({
        ...normVod(row),
        source: "hongguo",
        sourceName: row.bang || "红果热播榜",
        score: row.score,
        heat: row.heat,
        bang: row.bang,
        rank: row.rank,
      })),
      hasMore: start + slice.length < pool.length,
      total: pool.length,
    };
  }

  return { home, category, search, searchAll, recommend, detail, play };
}
