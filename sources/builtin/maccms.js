// ============================================================================
// 通用「苹果CMS(MacCMS V10)」源 —— 一个文件适配任意 MacCMS 接口。
//
// 用法：把下面 API 改成你自己的接口地址（形如 https://站点/api.php/provide/vod/），
//       保存后从「网页版 → ⚙ 源 → 导入源」粘进去（导入时会自动跑一次 home 自检）。
//
// 支持的接口能力：ac=list(分类) / ac=detail(列表与详情) / wd(搜索) / ids(详情)
// 只依赖 fetch，不依赖任何 Node 模块。
// ============================================================================

var meta = {
  id: 'maccms',
  name: '苹果CMS通用源',
  version: '1.0.0',
  description: '改一行 API 就能把任意 MacCMS V10 接口变成 App 数据源',
  author: '',
  type: 'video',
  features: ['search', 'categories']
};

// ↓↓↓ 只改这一行 ↓↓↓
var API = 'https://example.com/api.php/provide/vod/';
// ↑↑↑ 只改这一行 ↑↑↑

var UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

var failure = function (message, code) { return Object.assign(new Error(message), { code: code }); };

function buildUrl(params) {
  var base = API.replace(/[?&]+$/, ''); // 去掉多余的 ?/&，避免拼出 "?&" 或 "&&"
  if (base.indexOf('?') < 0) base += '?';
  var parts = [];
  for (var key in params) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
    var value = params[key];
    if (value === undefined || value === null || value === '') continue;
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)));
  }
  if (parts.length === 0) return base;
  return base + (base.charAt(base.length - 1) === '?' ? '' : '&') + parts.join('&');
}

// 网络抖动重试一次；非 JSON 不重试（重试也是同样的结果）
async function getJson(params) {
  var url = buildUrl(params);
  var lastError = null;
  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      var res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, timeoutMs: 15000 });
      var text = await res.text();
      if (!res.ok) throw failure('接口返回 HTTP ' + res.status, 'HTTP_' + res.status);
      var data;
      try { data = JSON.parse(text); } catch (e) { throw failure('接口返回的不是 JSON（前 120 字）：' + text.slice(0, 120), 'INVALID_RESPONSE'); }
      if (data && data.code !== undefined && Number(data.code) !== 1) {
        throw failure('接口返回 code=' + data.code + ' msg=' + (data.msg || ''), 'REJECTED');
      }
      return data || {};
    } catch (err) {
      lastError = err;
      if (err && err.code === 'INVALID_RESPONSE') break;
    }
  }
  throw lastError || failure('接口请求失败', 'REQUEST_FAILED');
}

// MacCMS 的 total/limit/pagecount 三个字段不一定都有，按能拿到的推算还有没有下一页
function packPage(data, page, list) {
  var pageCount = Number(data.pagecount) || Number(data.pageCount) || 0;
  if (!pageCount && Number(data.total) > 0 && Number(data.limit) > 0) {
    pageCount = Math.ceil(Number(data.total) / Number(data.limit));
  }
  var hasMore = pageCount ? page < pageCount : list.length > 0;
  return { page: page, pagecount: pageCount || page, hasMore: hasMore, list: list };
}

function toList(vod) {
  return {
    vod_id: String(vod.vod_id || ''),
    vod_name: String(vod.vod_name || ''),
    vod_pic: String(vod.vod_pic || ''),
    vod_remarks: String(vod.vod_remarks || '')
  };
}

function init(cfg) {}

async function home(filter) {
  var data = await getJson({ ac: 'list' });
  var classes = [];
  var list = data.class || [];
  for (var i = 0; i < list.length; i++) {
    var c = list[i];
    if (!c || c.type_id === undefined) continue;
    classes.push({ type_id: String(c.type_id), type_name: String(c.type_name || '') });
  }
  if (classes.length === 0) classes.push({ type_id: '1', type_name: '全部' });
  return { class: classes, filters: {} };
}

async function category(tid, page, filter, extend) {
  page = Number(page) || 1;
  var data = await getJson({ ac: 'detail', t: tid, pg: page });
  var rows = data.list || [];
  var out = [];
  for (var i = 0; i < rows.length; i++) out.push(toList(rows[i]));
  return packPage(data, page, out);
}

async function detail(id) {
  var vodId = String(id || '');
  var data = await getJson({ ac: 'detail', ids: vodId });
  var rows = data.list || [];
  var vod = rows[0] || {};
  if (!vod.vod_id) throw failure('详情为空（接口没返回这部剧）', 'EMPTY');
  // MacCMS 原生就返回 $$$(线路) / #(集) / $(集名与集ID) 结构，直接用。
  // 网页版会把所有线路都列出来；糖葫芦 App 只显示第一条线路。
  return {
    list: [{
      vod_id: String(vod.vod_id || vodId),
      vod_name: String(vod.vod_name || ''),
      vod_pic: String(vod.vod_pic || ''),
      vod_content: String(vod.vod_blurb || vod.vod_content || ''),
      vod_remarks: String(vod.vod_remarks || ''),
      vod_year: String(vod.vod_year || ''),
      vod_area: String(vod.vod_area || ''),
      vod_actor: String(vod.vod_actor || ''),
      vod_director: String(vod.vod_director || ''),
      vod_play_from: String(vod.vod_play_from || '默认线路'),
      vod_play_url: String(vod.vod_play_url || '')
    }]
  };
}

async function search(keyword, quick, page) {
  var word = String(keyword || '').trim();
  if (!word) return { page: 1, pagecount: 1, hasMore: false, list: [] };
  page = Number(page) || 1;
  var data = await getJson({ ac: 'detail', wd: word, pg: page });
  var rows = data.list || [];
  var out = [];
  for (var i = 0; i < rows.length; i++) out.push(toList(rows[i]));
  return packPage(data, page, out);
}

async function play(flag, id, flags) {
  var url = String(id || '');
  if (/^https?:\/\//.test(url)) {
    return { parse: 0, url: url, header: { 'User-Agent': UA } };
  }
  // 少数接口这里给的是播放页地址，App 没有 webview 嗅探，只能报错。
  return { parse: 0, url: '', error: 'MISSING_STREAM' };
}

var spider = {
  meta: meta,
  init: init,
  home: home,
  category: category,
  detail: detail,
  search: search,
  play: play
};

globalThis.spider = spider;
