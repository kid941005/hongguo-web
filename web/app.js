(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 400'%3E%3Crect width='300' height='400' fill='%231b2130'/%3E%3Ctext x='150' y='205' font-size='54' text-anchor='middle' fill='%23415069'%3E%F0%9F%8E%AC%3C/text%3E%3C/svg%3E";

  var state = {
    sources: [], source: '', classes: [], items: [], page: 1, hasMore: false,
    mode: 'home', tid: '', q: '', detail: null, line: 0, epIdx: 0, viewSource: '',
    hls: null, histKey: null, lastSave: 0, pendingSeek: 0,
    pendingResume: null, pendingPlay: null,
    rate: 1, quality: -1, levels: []
  };

  // 访问口令：服务端设了 TOKEN 时，前端可用 ?token=xxx 打开一次（会记住），之后自动带上
  var TOKEN_KEY = 'hg_token', tokenCache = null;
  function readToken() {
    if (tokenCache !== null) return tokenCache;
    var fromQuery = new URLSearchParams(location.search).get('token');
    if (fromQuery) {
      tokenCache = fromQuery;
      try { localStorage.setItem(TOKEN_KEY, fromQuery); } catch (e) {}
      return tokenCache;
    }
    try { tokenCache = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { tokenCache = ''; }
    return tokenCache;
  }
  function headers(extra) {
    var out = { 'Accept': 'application/json' };
    var token = readToken();
    if (token) out.Authorization = 'Bearer ' + token;
    for (var k in (extra || {})) out[k] = extra[k];
    return out;
  }
  function request(path, params, options) {
    var qs = new URLSearchParams(params || {}).toString();
    var url = path + (qs ? ('?' + qs) : '');
    var opts = options || {};
    opts.headers = headers(opts.headers);
    return fetch(url, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) { var e = new Error(body && body.error || ('HTTP ' + r.status)); e.code = body && body.code; throw e; }
        return body;
      });
    });
  }
  function api(path, params) { return request(path, params); }
  function postJson(path, body) {
    return request(path, null, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }
  function deleteJson(path) { return request(path, null, { method: 'DELETE' }); }

  function cur() { return state.source || ''; }

  // ---- 观看历史（localStorage） ----
  var HIST_KEY = 'hg_watch_v1', HIST_MAX = 100;

  function histLoad() {
    try { var a = JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function histStore(arr) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(arr.slice(0, HIST_MAX))); } catch (e) {}
  }
  function histKey(source, id) { return (source || '') + '|' + id; }
  function histGet(source, id) {
    var k = histKey(source, id), arr = histLoad();
    for (var i = 0; i < arr.length; i++) if (histKey(arr[i].source, arr[i].id) === k) return arr[i];
    return null;
  }
  function histTouch(patch) {
    var arr = histLoad(), k = histKey(patch.source, patch.id), prev = null;
    for (var i = 0; i < arr.length; i++) {
      if (histKey(arr[i].source, arr[i].id) === k) { prev = arr.splice(i, 1)[0]; break; }
    }
    var e = prev || {};
    for (var key in patch) { if (Object.prototype.hasOwnProperty.call(patch, key)) e[key] = patch[key]; }
    e.at = Date.now();
    arr.unshift(e); histStore(arr);
    state.histKey = k;
    return e;
  }
  function histUpdate(pos, dur) {
    if (!state.histKey) return;
    var arr = histLoad(), hit = false;
    for (var i = 0; i < arr.length; i++) {
      if (histKey(arr[i].source, arr[i].id) === state.histKey) {
        arr[i].pos = pos; if (dur) arr[i].dur = dur; arr[i].at = Date.now(); hit = true; break;
      }
    }
    if (hit) histStore(arr);
  }
  function histRemove(source, id) {
    var k = histKey(source, id), arr = histLoad(), out = [];
    for (var i = 0; i < arr.length; i++) if (histKey(arr[i].source, arr[i].id) !== k) out.push(arr[i]);
    histStore(out);
  }
  function histClear() { try { localStorage.removeItem(HIST_KEY); } catch (e) {} state.histKey = null; }

  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var mm = (h ? (m < 10 ? '0' + m : m) : m);
    return (h ? h + ':' : '') + mm + ':' + (s < 10 ? '0' + s : s);
  }
  function ago(ts) {
    var d = Math.max(0, Date.now() - (ts || 0)) / 1000;
    if (d < 60) return '刚刚';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
    if (d < 86400 * 30) return Math.floor(d / 86400) + ' 天前';
    return new Date(ts).toLocaleDateString();
  }


  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.add('hidden'); }, 3200);
  }

  function showNotice(text) {
    var n = $('notice');
    if (!text) { n.classList.add('hidden'); n.textContent = ''; return; }
    n.textContent = text; n.classList.remove('hidden');
  }

  function posterUrl(src) { return src || PLACEHOLDER; }

  function makeCard(item) {
    var card = document.createElement('div'); card.className = 'card';
    var img = document.createElement('img'); img.className = 'poster'; img.loading = 'lazy';
    img.alt = item.title || '';
    var original = item.cover || '';
    img.src = posterUrl(original);
    img.onerror = function () {
      if (original && img.src.indexOf('/api/media') === -1) img.src = '/api/media?u=' + encodeURIComponent(original);
      else if (img.src !== PLACEHOLDER) img.src = PLACEHOLDER;
    };
    var body = document.createElement('div'); body.className = 'cbody';
    if (item.sourceName) {
      var badge = document.createElement('div'); badge.className = 'cbadge'; badge.textContent = item.sourceName;
      card.appendChild(badge);
    }
    var t = document.createElement('div'); t.className = 'ctitle'; t.textContent = item.title || '未命名';
    var r = document.createElement('div'); r.className = 'crem'; r.textContent = item.remarks || '';
    body.appendChild(t); body.appendChild(r);
    card.appendChild(img); card.appendChild(body);
    card.addEventListener('click', function () { openDetail(item.id, item.source || ''); });
    return card;
  }

  function renderItems(items, append) {
    var grid = $('grid');
    if (!append) grid.textContent = '';
    items.forEach(function (it) { grid.appendChild(makeCard(it)); });
    $('empty').classList.toggle('hidden', grid.children.length > 0);
    if (!grid.children.length) $('empty').textContent = '没有内容';
    $('btnMore').classList.toggle('hidden', !state.hasMore);
  }

  function renderChips() {
    var box = $('chips'); box.textContent = '';
    if (!state.classes.length) return;
    state.classes.forEach(function (c) {
      var b = document.createElement('button'); b.className = 'chip' + (state.tid === c.id ? ' active' : '');
      b.textContent = c.name;
      b.addEventListener('click', function () { loadCategory(c.id); });
      box.appendChild(b);
    });
  }

  function setView(view) {
    state.mode = view;
    $('main').classList.toggle('hidden', view === 'detail');
    $('detail').classList.toggle('hidden', view !== 'detail');
  }

  function loadSources() {
    return api('/api/sources').then(function (r) {
      state.sources = r.sources || [];
      state.source = r.active || (state.sources[0] && state.sources[0].id) || '';
      var sel = $('sourceSelect'); sel.textContent = '';
      state.sources.forEach(function (s) {
        var o = document.createElement('option'); o.value = s.id;
        o.textContent = s.name + (s.type === 'builtin' ? '' : ' · JS') + '  v' + s.version;
        if (s.id === state.source) o.selected = true;
        sel.appendChild(o);
      });
      var all = document.createElement('option'); all.value = '__all';
      all.textContent = '🔎 全部源（聚合搜索）';
      if (state.source === '__all') all.selected = true;
      sel.appendChild(all);
    });
  }

  function loadHome() {
    setView('home'); showNotice('');
    if (state.source === '__all') {
      $('grid').textContent = ''; $('chips').textContent = ''; $('btnMore').classList.add('hidden');
      state.classes = []; state.items = []; state.hasMore = false; state.mode = 'home';
      $('empty').textContent = '「全部源」模式只用于聚合搜索：输入关键词回车，会同时检索所有已启用的源。';
      $('empty').classList.remove('hidden');
      return;
    }
    $('empty').textContent = '加载中…'; $('empty').classList.remove('hidden');
    $('grid').textContent = ''; $('btnMore').classList.add('hidden');
    state.mode = 'home'; state.tid = ''; state.q = ''; state.page = 1;
    return api('/api/home', { source: cur(), page: 1 }).then(function (r) {
      state.classes = r.classes || [];
      state.items = r.items || []; state.hasMore = !!r.hasMore;
      renderChips();
      renderItems(state.items, false);
      if (!state.items.length && state.classes.length) {
        return loadCategory(state.classes[0].id);
      }
      if (!state.items.length && !state.classes.length) {
        $('empty').textContent = '这个源没有返回任何内容'; $('empty').classList.remove('hidden');
      }
    }).catch(function (e) { showError(e); });
  }

  function loadCategory(tid) {
    setView('home'); state.mode = 'category'; state.tid = tid; state.page = 1; state.q = '';
    renderChips();
    $('empty').textContent = '加载中…'; $('empty').classList.remove('hidden'); $('grid').textContent = '';
    return api('/api/category', { source: cur(), tid: tid, page: 1 }).then(function (r) {
      state.items = r.items || []; state.hasMore = !!r.hasMore;
      renderItems(state.items, false);
      if (!state.items.length) { $('empty').textContent = '该分类暂无内容'; $('empty').classList.remove('hidden'); }
    }).catch(function (e) { showError(e); });
  }

  function loadMore() {
    state.page += 1;
    var p = state.page;
    var req;
    if (state.mode === 'search') req = api('/api/search', { source: cur(), q: state.q, page: p });
    else if (state.mode === 'category') req = api('/api/category', { source: cur(), tid: state.tid, page: p });
    else req = api('/api/home', { source: cur(), page: p });
    $('btnMore').classList.add('hidden');
    req.then(function (r) {
      state.hasMore = !!r.hasMore;
      renderItems(r.items || [], true);
      if (state.mode === 'search') { if (r.aggregate) showNotice(aggNote(r)); else if (r.fallback) showNotice(searchNote(r)); }
    }).catch(function (e) { state.page -= 1; showError(e); });
  }

  function searchNote(r) {
    if (!r || !r.fallback) return '';
    return '提示：内置红果的官方搜索接口已被风控，这里是在首页推荐池（' + (r.poolSize || 0) + ' 部）中检索的结果，可能不全。切换到 JS 源可获得完整搜索。';
  }

  function aggNote(r) {
    var gs = r.groups || [];
    var ok = gs.filter(function (g) { return g.count > 0; });
    var bad = gs.filter(function (g) { return g.error; });
    var parts = ok.map(function (g) { return g.name + ' ' + g.count + ' 条'; });
    var txt = '聚合搜索：共 ' + (r.items || []).length + ' 条' + (parts.length ? '（' + parts.join('，') + '）' : '（没有源命中）');
    if (bad.length) txt += '；失败：' + bad.map(function (g) { return g.name + '（' + g.error + '）'; }).join('，');
    return txt;
  }

  function doSearch() {
    var q = $('q').value.trim();
    if (!q) { loadHome(); return; }
    setView('home'); state.mode = 'search'; state.q = q; state.page = 1; state.tid = '';
    $('chips').textContent = ''; $('grid').textContent = ''; $('btnMore').classList.add('hidden');
    $('empty').textContent = '搜索中…'; $('empty').classList.remove('hidden'); showNotice('');
    api('/api/search', { source: cur(), q: q, page: 1 }).then(function (r) {
      state.hasMore = !!r.hasMore;
      renderItems(r.items || [], false);
      showNotice(r.aggregate ? aggNote(r) : searchNote(r));
      if (!(r.items || []).length) { $('empty').textContent = '没有找到「' + q + '」'; $('empty').classList.remove('hidden'); }
    }).catch(function (e) { showError(e); });
  }

  function openDetail(id, src) {
    state.viewSource = src || (state.source === '__all' ? '' : cur());
    setView('detail');
    $('dTitle').textContent = '加载中…'; $('dMeta').textContent = ''; $('dDesc').textContent = '';
    $('dCover').src = PLACEHOLDER; $('dEps').textContent = ''; $('dLines').textContent = '';
    api('/api/detail', { source: state.viewSource, id: id }).then(function (d) {
      state.detail = d; state.line = 0;
      $('dTitle').textContent = d.title || '未命名';
      $('dMeta').textContent = d.remarks || '';
      $('dDesc').textContent = d.desc || '';
      var cover = d.cover || '';
      $('dCover').src = posterUrl(cover);
      $('dCover').onerror = function () {
        if (cover && $('dCover').src.indexOf('/api/media') === -1) $('dCover').src = '/api/media?u=' + encodeURIComponent(cover);
        else $('dCover').src = PLACEHOLDER;
      };
      renderLines(d); renderEps(d, 0);
      updateResumeBar(d);
      var pr = state.pendingResume; state.pendingResume = null;
      if (pr && pr.id === d.id) playEpisode(pr.lineIdx || 0, pr.epIdx || 0, pr.pos || 0);
      var pp = state.pendingPlay; state.pendingPlay = null;
      if (pp !== null && pp !== undefined && !(pr && pr.id === d.id)) playEpisode(0, pp, 0);
      window.scrollTo(0, 0);
    }).catch(function (e) {
      state.pendingResume = null; state.pendingPlay = null;
      $('dTitle').textContent = '打开失败';
      showError(e);
    });
  }

  function renderLines(d) {
    var box = $('dLines'); box.textContent = '';
    if (!d.lines || d.lines.length <= 1) return;
    d.lines.forEach(function (l, i) {
      var b = document.createElement('button');
      b.className = 'chip' + (i === state.line ? ' active' : '');
      b.textContent = l.name + '（' + l.episodes.length + '）';
      b.addEventListener('click', function () { state.line = i; renderLines(d); renderEps(d, i); });
      box.appendChild(b);
    });
  }

  function renderEps(d, lineIdx) {
    var box = $('dEps'); box.textContent = '';
    var line = d.lines && d.lines[lineIdx];
    if (!line) return;
    var h = histGet(state.viewSource, d.id);
    line.episodes.forEach(function (ep, i) {
      var cls = 'ep';
      if (h && h.lineIdx === lineIdx) {
        if (i === h.epIdx) cls += ' current';
        else if (i < h.epIdx) cls += ' seen';
      }
      var b = document.createElement('button'); b.className = cls; b.textContent = ep.name || ('第 ' + (i + 1) + ' 集');
      b.title = ep.name || '';
      b.addEventListener('click', function () { playEpisode(lineIdx, i); });
      box.appendChild(b);
    });
  }

  function markActiveEp(lineIdx, epIdx) {
    var kids = $('dEps').children;
    for (var i = 0; i < kids.length; i++) kids[i].classList.toggle('active', i === epIdx && state.line === lineIdx);
  }

  function playEpisode(lineIdx, epIdx, startAt) {
    var d = state.detail; if (!d) return;
    var line = d.lines[lineIdx]; if (!line) return;
    var ep = line.episodes[epIdx]; if (!ep) return;
    state.line = lineIdx; state.epIdx = epIdx;
    markActiveEp(lineIdx, epIdx);
    $('pTitle').textContent = (d.title || '') + ' · ' + (ep.name || '');
    histTouch({
      source: state.viewSource, id: d.id, title: d.title, cover: d.cover,
      lineIdx: lineIdx, lineName: line.name, epIdx: epIdx, epName: ep.name,
      pos: Math.max(0, Math.floor(startAt || 0)), dur: 0
    });
    updateResumeBar(d);
    toast('正在解析播放地址…');
    api('/api/play', { source: state.viewSource, flag: line.flag, id: ep.id }).then(function (r) {
      openPlayer(r.url, r.type, startAt);
    }).catch(function (e) { showError(e); });
  }

  // ---- 倍速 ----
  var RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
  var RATE_KEY = 'hg_rate_v1';

  function loadRate() {
    var r = parseFloat(localStorage.getItem(RATE_KEY) || '1');
    if (!isFinite(r) || RATES.indexOf(r) === -1) r = 1;
    state.rate = r;
    return r;
  }
  function rateLabel(r) { return (r === 1 ? '1.0' : String(r)) + '×'; }
  function applyRate() {
    var v = $('video');
    try { v.playbackRate = state.rate; } catch (e) {}
    $('btnRate').textContent = rateLabel(state.rate);
    $('btnRate').classList.toggle('on', state.rate !== 1);
  }
  function setRate(r) {
    state.rate = r;
    try { localStorage.setItem(RATE_KEY, String(r)); } catch (e) {}
    applyRate();
    toast('倍速 ' + rateLabel(r));
  }
  function cycleRate(dir) {
    var i = RATES.indexOf(state.rate); if (i < 0) i = 2;
    i = Math.min(RATES.length - 1, Math.max(0, i + (dir || 1)));
    setRate(RATES[i]);
  }

  // ---- 清晰度（HLS 多码率） ----
  function levelLabel(lv) {
    if (!lv) return '自动';
    if (lv.name) { var n = String(lv.name).trim(); return /p$/i.test(n) ? n.toUpperCase() : n + 'P'; }
    if (lv.height) return lv.height + 'P';
    if (lv.bitrate) return Math.round(lv.bitrate / 1000) + 'K';
    return '码率';
  }
  function updateQualityBtn() {
    var btn = $('btnQuality');
    if (!btn) return;
    var n = (state.levels || []).length;
    btn.classList.toggle('hidden', n <= 1);
    var lv = state.quality >= 0 ? state.levels[state.quality] : null;
    btn.textContent = '清晰度 ' + (state.quality < 0 ? '自动' : levelLabel(lv));
    btn.classList.toggle('on', state.quality >= 0);
  }
  function cycleQuality() {
    var n = (state.levels || []).length;
    if (n <= 1) { toast('该视频只有单一清晰度'); return; }
    state.quality = state.quality + 1 >= n ? -1 : state.quality + 1;
    if (state.hls) { try { state.hls.currentLevel = state.quality; } catch (e) {} }
    updateQualityBtn();
    toast('清晰度：' + (state.quality < 0 ? '自动' : levelLabel(state.levels[state.quality])));
  }

  // ---- 全屏 ----
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }
  function toggleFullscreen() {
    var box = document.querySelector('.player-inner') || $('player');
    var v = $('video');
    if (isFullscreen()) {
      (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
      return;
    }
    if (box.requestFullscreen) {
      box.requestFullscreen().catch(function () { toast('全屏被浏览器拒绝'); });
    } else if (box.webkitRequestFullscreen) {
      box.webkitRequestFullscreen();
    } else if (v.webkitEnterFullscreen) {
      v.webkitEnterFullscreen();
    } else {
      toast('当前浏览器不支持全屏');
    }
  }
  function syncFullBtn() {
    var b = $('btnFull'); if (!b) return;
    b.textContent = isFullscreen() ? '退出全屏' : '全屏';
    b.classList.toggle('on', isFullscreen());
  }

  function destroyHls() {
    if (state.hls) { try { state.hls.destroy(); } catch (e) {} state.hls = null; }
  }

  function openPlayer(url, type, startAt) {
    var v = $('video');
    state.pendingSeek = Math.max(0, Math.floor(startAt || 0));
    state.lastSave = 0;
    state.quality = -1;
    state.levels = [];
    updateQualityBtn();
    destroyHls();
    $('player').classList.remove('hidden');
    if (type === 'hls') {
      if (window.Hls && window.Hls.isSupported()) {
        var hls = new window.Hls({ maxBufferLength: 30 });
        state.hls = hls;
        hls.loadSource(url); hls.attachMedia(v);
        hls.on(window.Hls.Events.MANIFEST_PARSED, function () {
          state.levels = (hls.levels || []).map(function (lv) {
            return { height: lv.height, bitrate: lv.bitrate, name: lv.name || '' };
          });
          updateQualityBtn();
        });
        hls.on(window.Hls.Events.ERROR, function (_e, data) {
          if (data && data.fatal) { toast('播放失败：' + (data.details || '流错误')); }
        });
      } else {
        v.src = url;
      }
    } else {
      v.src = url;
    }
    applyRate();
    var p = v.play(); if (p && p.catch) p.catch(function () {});
  }

  function saveProgress(v) {
    v = v || $('video');
    if (!state.histKey) return;
    var pos = Math.floor(v.currentTime || 0), dur = 0;
    if (v.duration && isFinite(v.duration)) dur = Math.floor(v.duration);
    if (pos > 0) histUpdate(pos, dur);
  }

  function bindPlayerEvents() {
    var v = $('video');
    v.addEventListener('loadedmetadata', function () {
      if (state.pendingSeek > 3 && isFinite(v.duration) && state.pendingSeek < v.duration - 3) {
        try { v.currentTime = state.pendingSeek; } catch (e) {}
        toast('已续播至 ' + fmtDur(state.pendingSeek));
      }
      state.pendingSeek = 0;
    });
    v.addEventListener('timeupdate', function () {
      if (!state.histKey) return;
      var now = Date.now();
      if (now - state.lastSave < 5000) return;
      state.lastSave = now;
      saveProgress(v);
    });
    v.addEventListener('pause', function () { saveProgress(v); });
    v.addEventListener('ended', function () {
      if (state.histKey) histUpdate(Math.floor(v.duration || 0), Math.floor(v.duration || 0));
    });
    v.addEventListener('dblclick', function (e) { e.preventDefault(); toggleFullscreen(); });
    document.addEventListener('keydown', onPlayerKey);
    document.addEventListener('fullscreenchange', syncFullBtn);
    document.addEventListener('webkitfullscreenchange', syncFullBtn);
  }

  function onPlayerKey(e) {
    if ($('player').classList.contains('hidden')) return;
    var t = e.target || {};
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '') || t.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var v = $('video'), k = e.key;
    if (k === ' ' || k === 'Spacebar' || k === 'k' || k === 'K') {
      e.preventDefault();
      if (v.paused) { var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}); }
      else v.pause();
    } else if (k === 'ArrowLeft') {
      e.preventDefault(); v.currentTime = Math.max(0, (v.currentTime || 0) - 5); toast('后退 5 秒');
    } else if (k === 'ArrowRight') {
      e.preventDefault(); v.currentTime = (v.currentTime || 0) + 5; toast('前进 5 秒');
    } else if (k === 'ArrowUp') {
      e.preventDefault(); v.volume = Math.min(1, Math.round((v.volume + 0.1) * 10) / 10);
      toast('音量 ' + Math.round(v.volume * 100) + '%');
    } else if (k === 'ArrowDown') {
      e.preventDefault(); v.volume = Math.max(0, Math.round((v.volume - 0.1) * 10) / 10);
      toast('音量 ' + Math.round(v.volume * 100) + '%');
    } else if (k === 'm' || k === 'M') {
      v.muted = !v.muted; toast(v.muted ? '已静音' : '取消静音');
    } else if (k === 'f' || k === 'F') {
      e.preventDefault(); toggleFullscreen();
    } else if (k === ',' || k === '<') {
      e.preventDefault(); cycleRate(-1);
    } else if (k === '.' || k === '>') {
      e.preventDefault(); cycleRate(1);
    } else if (k === 'n' || k === 'N') {
      e.preventDefault(); nextEpisode();
    }
  }

  function closePlayer() {
    var v = $('video');
    saveProgress(v);
    try { v.pause(); } catch (e) {}
    v.removeAttribute('src'); try { v.load(); } catch (e) {}
    destroyHls();
    $('player').classList.add('hidden');
  }

  function nextEpisode() {
    var d = state.detail; if (!d) return;
    var line = d.lines[state.line]; if (!line) return;
    var next = (state.epIdx || 0) + 1;
    if (next >= line.episodes.length) { toast('已经是最后一集'); return; }
    playEpisode(state.line, next);
  }

  function showError(e) {
    var msg = (e && e.message) || '出错了';
    toast(msg);
    $('empty').textContent = msg; $('empty').classList.remove('hidden');
  }

  // ---- 导入源 ----
  function openImport() { $('importModal').classList.remove('hidden'); $('impMsg').textContent = ''; }
  function closeImport() { $('importModal').classList.add('hidden'); }
  function submitImport() {
    var url = $('impUrl').value.trim();
    var code = $('impCode').value;
    if (!url && !code.trim()) { $('impMsg').textContent = '请填写 URL 或粘贴源码'; return; }
    $('impMsg').className = 'impmsg'; $('impMsg').textContent = '导入中…';
    postJson('/api/sources/import', { url: url || undefined, code: url ? undefined : code }).then(function (res) {
      $('impMsg').textContent = '导入成功：' + res.source.name + '（v' + res.source.version + '）';
      toast('已导入源：' + res.source.name);
      loadSources().then(function () { state.source = res.source.id; $('sourceSelect').value = state.source; loadHome(); });
      setTimeout(closeImport, 700);
    }).catch(function (e) {
      $('impMsg').className = 'impmsg err';
      $('impMsg').textContent = e.message;
    });
  }


  // ---- 续播条 / 历史弹窗 ----
  function updateResumeBar(d) {
    var bar = $('dResume'); if (!bar) return;
    bar.textContent = '';
    var e = d ? histGet(state.viewSource, d.id) : null;
    if (!e || !e.pos) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    var txt = document.createElement('div'); txt.className = 'resume-txt';
    var pct = e.dur ? Math.min(100, Math.round(e.pos / e.dur * 100)) : 0;
    txt.textContent = '上次看到 ' + (e.epName || ('第 ' + ((e.epIdx || 0) + 1) + ' 集')) +
      ' · ' + fmtDur(e.pos) + (e.dur ? ' / ' + fmtDur(e.dur) : '') +
      (e.dur ? '（' + pct + '%）' : '') + ' · ' + ago(e.at);
    var go = document.createElement('button'); go.className = 'btn'; go.textContent = '继续播放';
    go.addEventListener('click', function () { playEpisode(e.lineIdx || 0, e.epIdx || 0, e.pos || 0); });
    var del = document.createElement('button'); del.className = 'btn ghost mini'; del.textContent = '清除';
    del.addEventListener('click', function () {
      histRemove(state.viewSource, d.id);
      updateResumeBar(d);
      if (state.detail) renderEps(state.detail, state.line);
    });
    bar.appendChild(txt); bar.appendChild(go); bar.appendChild(del);
  }

  function openHistory() { $('histModal').classList.remove('hidden'); renderHistory(); }
  function closeHistory() { $('histModal').classList.add('hidden'); }

  function renderHistory() {
    var box = $('histList'); box.textContent = '';
    var arr = histLoad();
    if (!arr.length) {
      var em = document.createElement('div'); em.className = 'srcloading';
      em.textContent = '还没有观看记录。播放任意一集后，这里会记住看到哪里。';
      box.appendChild(em); return;
    }
    arr.forEach(function (e) {
      var row = document.createElement('div'); row.className = 'histrow';
      var img = document.createElement('img'); img.className = 'histcover';
      img.src = posterUrl(e.cover); img.loading = 'lazy';
      img.onerror = function () { img.src = PLACEHOLDER; };
      row.appendChild(img);

      var info = document.createElement('div'); info.className = 'histinfo';
      var title = document.createElement('div'); title.className = 'histtitle'; title.textContent = e.title || e.id;
      var sub = document.createElement('div'); sub.className = 'histsub';
      var pct = e.dur ? Math.min(100, Math.round((e.pos || 0) / e.dur * 100)) : 0;
      sub.textContent = (e.epName || ('第 ' + ((e.epIdx || 0) + 1) + ' 集')) +
        ' · ' + fmtDur(e.pos) + (e.dur ? ' / ' + fmtDur(e.dur) : '') + ' · ' + ago(e.at);
      var track = document.createElement('div'); track.className = 'histtrack';
      var fill = document.createElement('div'); fill.className = 'histfill';
      fill.style.width = (pct || (e.pos ? 2 : 0)) + '%';
      track.appendChild(fill);
      info.appendChild(title); info.appendChild(sub); info.appendChild(track);
      row.appendChild(info);

      var acts = document.createElement('div'); acts.className = 'histacts';
      var go = document.createElement('button'); go.className = 'btn mini'; go.textContent = '续播';
      go.addEventListener('click', function (ev) {
        ev.stopPropagation();
        closeHistory();
        state.pendingResume = e;
        openDetail(e.id, e.source || '');
      });
      var del = document.createElement('button'); del.className = 'btn ghost mini danger'; del.textContent = '删除';
      del.addEventListener('click', function (ev) {
        ev.stopPropagation();
        histRemove(e.source, e.id); renderHistory();
      });
      acts.appendChild(go); acts.appendChild(del);
      row.appendChild(acts);

      row.addEventListener('click', function () {
        closeHistory();
        state.pendingResume = e;
        openDetail(e.id, e.source || '');
      });
      box.appendChild(row);
    });
  }

  // ---- 源管理面板 ----
  function openManage() { $('manageModal').classList.remove('hidden'); refreshManage(); }
  function closeManage() { $('manageModal').classList.add('hidden'); }

  function tag(text, cls) {
    var t = document.createElement('span'); t.className = 'tag ' + cls; t.textContent = text; return t;
  }

  function refreshManage() {
    var box = $('srcList'); box.textContent = '';
    var loading = document.createElement('div'); loading.className = 'srcloading'; loading.textContent = '加载中…';
    box.appendChild(loading);
    api('/api/sources').then(function (r) {
      box.textContent = '';
      state.sources = r.sources || [];
      (r.sources || []).forEach(function (s) { box.appendChild(sourceRow(s, r.active)); });
    }).catch(function (e) { box.textContent = ''; showError(e); });
  }

  function sourceRow(s, activeId) {
    var row = document.createElement('div'); row.className = 'srcrow';
    var head = document.createElement('div'); head.className = 'srchead';

    var info = document.createElement('div'); info.className = 'srcinfo';
    var name = document.createElement('div'); name.className = 'srcname'; name.textContent = s.name || s.id;
    var idEl = document.createElement('div'); idEl.className = 'srcid'; idEl.textContent = s.id;
    var tags = document.createElement('div'); tags.className = 'srctags';
    tags.appendChild(tag(s.builtin ? '内置' : '导入', s.builtin ? 'builtin' : 'user'));
    tags.appendChild(tag('v' + s.version, 'ver'));
    tags.appendChild(tag(s.type === 'builtin' ? '红果解密' : 'JS 源', 'kind'));
    if (s.id === activeId) tags.appendChild(tag('使用中', 'on'));
    info.appendChild(name); info.appendChild(idEl); info.appendChild(tags);
    head.appendChild(info);

    var acts = document.createElement('div'); acts.className = 'srcacts';
    if (s.id !== activeId) {
      var use = document.createElement('button'); use.className = 'btn mini'; use.textContent = '启用';
      use.addEventListener('click', function () {
        setActiveSource(s.id).then(function () { refreshManage(); toast('已切换到 ' + s.id); })
          .catch(function (e) { toast(e.message); });
      });
      acts.appendChild(use);
    }
    var logBtn = document.createElement('button'); logBtn.className = 'btn ghost mini'; logBtn.textContent = '日志';
    logBtn.addEventListener('click', function () { toggleLog(row, s.id, logBtn); });
    acts.appendChild(logBtn);
    if (!s.builtin) {
      var del = document.createElement('button'); del.className = 'btn ghost mini danger'; del.textContent = '删除';
      del.addEventListener('click', function () { removeSource(s); });
      acts.appendChild(del);
    }
    head.appendChild(acts);
    row.appendChild(head);
    return row;
  }

  function toggleLog(row, id, btn) {
    var pre = row.querySelector('.srclog');
    if (pre) { pre.remove(); btn.textContent = '日志'; return; }
    btn.textContent = '收起';
    pre = document.createElement('pre'); pre.className = 'srclog'; pre.textContent = '加载日志…';
    row.appendChild(pre);
    api('/api/sources/' + encodeURIComponent(id) + '/log').then(function (r) {
      var lines = (r.log || []);
      pre.textContent = lines.length ? lines.join('\n') : '（暂无日志：源还没有被调用过，或运行正常无输出）';
    }).catch(function (e) { pre.textContent = '日志获取失败：' + e.message; });
  }

  // 切换启用源：下拉框与源管理面板共用同一条路径
  function setActiveSource(id) {
    if (id === '__all') {
      state.source = '__all';
      $('sourceSelect').value = '__all';
      loadHome();
      return Promise.resolve();
    }
    return postJson('/api/sources/active', { id: id }).then(function () {
      state.source = id;
      $('sourceSelect').value = id;
      return loadSources().then(loadHome);
    });
  }

  function removeSource(s) {
    if (!window.confirm('确定删除源「' + (s.name || s.id) + '」？文件会从数据卷里移除。')) return;
    deleteJson('/api/sources/' + encodeURIComponent(s.id)).then(function () {
      toast('已删除 ' + s.id);
      return loadSources().then(function () { refreshManage(); loadHome(); });
    }).catch(function (e) { toast(e.message); });
  }

  // ---- 事件绑定 ----
  $('btnSearch').addEventListener('click', doSearch);
  $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });
  $('btnMore').addEventListener('click', loadMore);
  $('btnBack').addEventListener('click', function () { setView('home'); });
  $('btnClosePlayer').addEventListener('click', closePlayer);
  $('btnNext').addEventListener('click', nextEpisode);
  $('btnImport').addEventListener('click', openImport);
  $('btnManage').addEventListener('click', openManage);
  $('btnManageClose').addEventListener('click', closeManage);
  $('btnRate').addEventListener('click', function () { cycleRate(1); });
  $('btnQuality').addEventListener('click', cycleQuality);
  $('btnFull').addEventListener('click', toggleFullscreen);
  $('btnHistory').addEventListener('click', openHistory);
  $('btnHistClose').addEventListener('click', closeHistory);
  $('btnHistClear').addEventListener('click', function () {
    if (!window.confirm('清空全部观看记录？此操作不可撤销。')) return;
    histClear(); renderHistory();
    if (state.detail) updateResumeBar(state.detail);
    toast('已清空观看历史');
  });
  $('btnImpCancel').addEventListener('click', closeImport);
  $('btnImpOk').addEventListener('click', submitImport);
  $('brand').addEventListener('click', function () { setView('home'); loadHome(); });
  $('sourceSelect').addEventListener('change', function (e) {
    var id = e.target.value;
    setActiveSource(id).catch(function (er) {
      toast(er.message);
      $('sourceSelect').value = state.source; // 切换失败时把下拉框退回原值
    });
  });

  // 只读调试钩子：无头浏览器验证/排障用，正常使用不依赖它
  window.__hg = {
    state: state, openPlayer: openPlayer, cycleQuality: cycleQuality,
    cycleRate: cycleRate, toggleFullscreen: toggleFullscreen, histLoad: histLoad
  };

  // ---- 启动 ----
  function bootFromQuery() {
    var sp = new URLSearchParams(location.search);
    var src = sp.get('source') || '';
    if (src) {
      var sel = $('sourceSelect');
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === src) { sel.value = src; state.source = src; break; }
      }
    }
    var q = sp.get('q') || '';
    if (q) { $('q').value = q; doSearch(); return true; }
    var id = sp.get('id') || '';
    if (id) {
      var ep = sp.get('ep');
      if (ep !== null && ep !== '') state.pendingPlay = Math.max(0, parseInt(ep, 10) || 0);
      openDetail(id, sp.get('source') || '');
      return true;
    }
    return false;
  }

  bindPlayerEvents();
  loadRate(); applyRate(); syncFullBtn();
  loadSources().then(function () {
    var sp = new URLSearchParams(location.search);
    if (!bootFromQuery()) loadHome();
    if (sp.get('manage') === '1') openManage();
    if (sp.get('hist') === '1') openHistory();
  }).catch(function (e) { showError(e); });
})();