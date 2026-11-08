// ============================================================================
// 糖葫芦Haw(THLRedLook) JS 数据源模板 —— 可直接导入，也可作为自己写源的起点。
//
// 沙箱里只有这些东西（糖葫芦 App 的口径，网页版是它的超集）：
//   fetch(url, {method, headers, body, timeoutMs}) -> Promise<{status, ok, headers, body, text(), json()}>
//   html.parse(html字符串) -> { find(选择器), text() }   节点: .text() .attr(name) .attrs .children
//   console / JSON / Promise / async-await / Map / Set
// 没有：require、import、setTimeout、local、req、pdfh、Buffer、document、btoa。
//
// App 调用你的方式（全部是 async，返回普通对象即可）：
//   spider.home(filter)                      -> {class:[{type_id,type_name}], filters:{}}
//   spider.category(tid, page, filter, ext)  -> {page, pagecount, list:[{vod_id,vod_name,vod_pic,vod_remarks}]}
//   spider.detail(id)                        -> {list:[{...}]}   ← 只认 list
//   spider.search(keyword, quick, page)      -> [ ... ]  或 {page, pagecount, list:[...]}
//   spider.play(flag, id, flags)             -> {url, header:{}, parse:0}
//
// 注意：App 传给 play 的 flag 恒为字符串 'flag'（不是线路名），别依赖它。
// ============================================================================

// meta 必须写在文件最前面：App 是用正则抓文件里「第一处 id 字符串」和「第一处 name 字符串」
// 来识别源的；注释、示例里更早出现这类字面量，就会把源 ID/名字识别错（本文件就是踩过这个坑）。
var meta = {
  id: 'template',
  name: '模板源(示例)',
  version: '1.0.0',
  description: 'THLRedLook 数据源骨架，演示 home/category/detail/search/play 五件套',
  author: 'you',
  type: 'video',
  features: ['search', 'categories']
};

var UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// 演示数据：换成真实站点时，把这里改成 await fetch(...) 拿到的数据。
var DEMO = [
  { vod_id: 'demo-1', vod_name: '示例短剧一', vod_pic: '', vod_remarks: '全 80 集' },
  { vod_id: 'demo-2', vod_name: '示例短剧二', vod_pic: '', vod_remarks: '更新至 12 集' },
  { vod_id: 'demo-3', vod_name: '示例短剧三', vod_pic: '', vod_remarks: '已完结' }
];

function init(cfg) {
  // 可选：源被加载时调用一次，可在这里做预热、读配置。
}

async function home(filter) {
  // 分类尽量固定写死，省一次请求；需要动态分类时再请求。
  return {
    class: [
      { type_id: 'hot', type_name: '热门' },
      { type_id: 'new', type_name: '最新' },
      { type_id: 'end', type_name: '完结' }
    ],
    filters: {
      // 二级筛选：key 是 type_id，value 是筛选组数组；不写就传 {}
      hot: [
        { key: 'sort', name: '排序', value: [ { n: '默认', v: '' }, { n: '播放多', v: 'hits' } ] }
      ]
    }
  };
}

async function category(tid, page, filter, extend) {
  page = Number(page) || 1;
  // extend 是对象，例如 {sort:'hits'}；换真实接口时拼进 query。
  var list = DEMO.map(function (item) {
    return { vod_id: tid + '-' + item.vod_id, vod_name: item.vod_name, vod_pic: item.vod_pic, vod_remarks: item.vod_remarks };
  });
  // 演示数据只有一页：真实源按接口返回的 total/pagecount 算
  return { page: page, pagecount: 1, hasMore: false, list: page === 1 ? list : [] };
}

async function detail(id) {
  // 真实实现：请求详情接口 -> 拼出 vod_play_from / vod_play_url。
  // vod_play_url 格式：线路之间用 $$$ 分隔，集之间用 # 分隔，集名与集 ID 用 $ 分隔。
  return {
    list: [{
      vod_id: id,
      vod_name: '示例短剧',
      vod_pic: '',
      vod_content: '剧情简介。',
      vod_remarks: '全 80 集',
      vod_play_from: '默认线路',
      vod_play_url: '第1集$https://example.com/1.m3u8#第2集$https://example.com/2.m3u8'
    }]
  };
}

async function search(keyword, quick, page) {
  // 真实实现：请求搜索接口。返回数组或 {page, pagecount, list} 都可以。
  var word = String(keyword || '').trim();
  var list = DEMO.filter(function (item) { return item.vod_name.indexOf(word) >= 0; });
  // 演示数据量很小，一次返回完；真实源按 page 切片并给出 pagecount/hasMore
  return { page: 1, pagecount: 1, hasMore: false, list: page === 1 ? list : [] };
}

async function play(flag, id, flags) {
  // id 就是 vod_play_url 里 $ 后面的部分。能直接播就返回 URL；
  // 需要 webview 解析的站，本 App 不支持（parse 字段目前没有解析器）。
  var url = String(id || '');
  if (/^https?:\/\//.test(url)) {
    return { parse: 0, url: url, header: { 'User-Agent': UA } };
  }
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

// 兜底：确保 spider 挂在全局（沙箱里顶层 var 本来就是全局，写上更保险）。
globalThis.spider = spider;
