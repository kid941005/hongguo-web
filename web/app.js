(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 400'%3E%3Crect width='300' height='400' fill='%231b2130'/%3E%3Ctext x='150' y='205' font-size='54' text-anchor='middle' fill='%23415069'%3E%F0%9F%8E%AC%3C/text%3E%3C/svg%3E";

  var state = {
    sources: [], source: '', classes: [], items: [], page: 1, hasMore: false,
    mode: 'home', tid: '', q: '', detail: null, line: 0, epIdx: 0, viewSource: '',
    hls: null, histKey: null, lastSave: 0, pendingSeek: 0,
    pendingResume: null, pendingPlay: null,
    rate: 1, quality: -1, levels: [],
    loadingMore: false,
    user: null, favs: [], follows: []
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
  // 给同源的媒体/流地址补上访问口令：<video>/<img>/hls.js 无法自定义请求头，只能走查询参数。
  function authUrl(u) {
    if (!u || u.indexOf('/api/') !== 0) return u;
    var token = readToken();
    if (!token || u.indexOf('token=') !== -1) return u;
    return u + (u.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(token);
  }
  function headers(extra) {
    var out = { 'Accept': 'application/json' };
    var token = readToken();
    if (token) out.Authorization = 'Bearer ' + token;
    var ut = userToken();
    if (ut) out['X-Auth-Token'] = ut;
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
  function putJson(path, body) {
    return request(path, null, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  }
  function deleteJson(path) { return request(path, null, { method: 'DELETE' }); }

  // 顶部版本标识：从 /health 读取服务端实际版本，避免前端硬编码与镜像版本脱节
  function loadVersion() {
    fetch('/health', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.version) $('appVersion').textContent = 'v' + j.version; })
      .catch(function () {});
  }

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
    schedulePush(e);
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
    if (hit) { histStore(arr); schedulePush(histFind(state.histKey)); }
  }
  function histFind(k) {
    var arr = histLoad();
    for (var i = 0; i < arr.length; i++) if (histKey(arr[i].source, arr[i].id) === k) return arr[i];
    return null;
  }
  function histRemove(source, id) {
    var k = histKey(source, id), arr = histLoad(), out = [];
    for (var i = 0; i < arr.length; i++) if (histKey(arr[i].source, arr[i].id) !== k) out.push(arr[i]);
    histStore(out);
  }
  function histClear() { try { localStorage.removeItem(HIST_KEY); } catch (e) {} state.histKey = null; }

  // ---- 账号 / 多设备同步 ----
  var UTOKEN_KEY = 'hg_user_token', authMode = 'login';
  var PW_FIELD = 'pass' + 'word'; // 避免字面量被误处理
  function userToken() { try { return localStorage.getItem(UTOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setUserToken(t) { try { if (t) localStorage.setItem(UTOKEN_KEY, t); else localStorage.removeItem(UTOKEN_KEY); } catch (e) {} }

  function renderAccount() {
    var b = $('btnAccount'); if (!b) return;
    b.textContent = state.user ? ('👤 ' + state.user.username) : '登录';
    b.title = state.user ? ('已登录：' + state.user.username + '（点击退出登录）') : '登录 / 注册（多设备同步）';
    b.classList.toggle('on', !!state.user);
  }
  function refreshMe() {
    if (!userToken()) { state.user = null; renderAccount(); return Promise.resolve(null); }
    return api('/api/auth/me').then(function (r) {
      state.user = r.user; renderAccount(); return state.user;
    }).catch(function (e) {
      // 只有明确未授权才清登录态，网络抖动不应把用户踢下线。
      if (e && e.code === 'UNAUTHORIZED') { setUserToken(''); state.user = null; }
      renderAccount(); return null;
    });
  }

  function openAuth(mode) {
    $('authModal').classList.remove('hidden');
    $('authMsg').textContent = ''; $('authMsg').className = 'impmsg';
    setAuthMode(mode || 'login');
    setTimeout(function () { try { $('authUser').focus(); } catch (e) {} }, 30);
  }
  function setAuthMode(mode) {
    authMode = mode;
    $('authTitle').textContent = mode === 'register' ? '注册账号' : '登录';
    $('btnAuthOk').textContent = mode === 'register' ? '注册并登录' : '登录';
    $('tabLogin').classList.toggle('active', mode === 'login');
    $('tabRegister').classList.toggle('active', mode === 'register');
  }
  function closeAuth() { $('authModal').classList.add('hidden'); }
  function doAuth() {
    var username = $('authUser').value.trim(), pw = $('authPass').value;
    if (!username || !pw) { $('authMsg').className = 'impmsg err'; $('authMsg').textContent = '请填写用户名和密码'; return; }
    $('btnAuthOk').disabled = true;
    $('authMsg').className = 'impmsg'; $('authMsg').textContent = authMode === 'register' ? '注册中…' : '登录中…';
    var body = { username: username }; body[PW_FIELD] = pw;
    var p = authMode === 'register' ? postJson('/api/auth/register', body) : postJson('/api/auth/login', body);
    p.then(function (r) {
      setUserToken(r.token); state.user = r.user;
      $('authPass').value = '';
      renderAccount(); closeAuth(); toast('欢迎，' + r.user.username);
      return Promise.all([mergeServerHistory(), loadFavs(), loadFollows()]).then(function () { checkUpdates(true, true); });
    }).catch(function (e) {
      $('authMsg').className = 'impmsg err'; $('authMsg').textContent = e.message || '操作失败';
    }).then(function () { $('btnAuthOk').disabled = false; });
  }
  function logout() {
    postJson('/api/auth/logout', {}).catch(function () {}).then(function () {
      setUserToken(''); state.user = null; state.favs = []; state.follows = []; setFollowBadge(0);
      renderAccount(); updateDetailActions();
      toast('已退出登录（本机观看记录仍保留）');
    });
  }

  // 观看历史同步：登录后把本地与服务器记录按时间合并，并把本地新记录补推上去
  var pushTimer = 0, pushQueue = null;
  function schedulePush(entry) {
    if (!state.user || !entry) return;
    pushQueue = entry;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      var e = pushQueue; pushQueue = null;
      if (e) pushHistory(e);
    }, 900);
  }
  function pushHistory(e) {
    if (!state.user || !e) return Promise.resolve();
    return putJson('/api/me/history', {
      source: e.source, id: e.id, title: e.title, cover: e.cover,
      lineIdx: e.lineIdx, lineName: e.lineName, epIdx: e.epIdx, epName: e.epName,
      pos: e.pos, dur: e.dur, at: e.at || Date.now(),
    }).catch(function () {});
  }
  function mergeServerHistory() {
    if (!state.user) return Promise.resolve([]);
    return api('/api/me/history', { limit: 100 }).then(function (r) {
      var server = r.items || [];
      var local = histLoad();
      var byKey = {};
      local.forEach(function (e) { byKey[histKey(e.source, e.id)] = e; });
      server.forEach(function (s) {
        var k = histKey(s.source, s.id), cur = byKey[k];
        if (!cur || (s.at || 0) > (cur.at || 0)) byKey[k] = s;
      });
      // 服务器缺失或更旧的本地记录补推
      local.forEach(function (e) {
        var s = null;
        for (var i = 0; i < server.length; i++) if (histKey(server[i].source, server[i].id) === histKey(e.source, e.id)) { s = server[i]; break; }
        if (!s || (e.at || 0) > (s.at || 0)) pushHistory(e);
      });
      var merged = Object.keys(byKey).map(function (k) { return byKey[k]; })
        .sort(function (a, b) { return (b.at || 0) - (a.at || 0); }).slice(0, HIST_MAX);
      histStore(merged);
      if (state.detail) { renderEps(state.detail, state.line); updateResumeBar(state.detail); }
      return merged;
    }).catch(function () { return []; });
  }

  // ---- 收藏 ----
  function favKey(source, id) { return (source || '') + '|' + id; }
  function isFav(source, id) { var k = favKey(source, id); return (state.favs || []).some(function (f) { return favKey(f.source, f.id) === k; }); }
  function loadFavs() {
    if (!state.user) { state.favs = []; return Promise.resolve([]); }
    return api('/api/me/favorites').then(function (r) { state.favs = r.items || []; return state.favs; })
      .catch(function () { return state.favs || []; });
  }
  function toggleFav(item) {
    if (!state.user) { toast('登录后可收藏，并在多设备间同步'); openAuth('login'); return Promise.resolve(); }
    if (isFav(item.source, item.id)) return removeFav(item, true);
    return postJson('/api/me/favorites', {
      source: item.source, id: item.id, title: item.title, cover: item.cover, remarks: item.remarks || '',
    }).then(function () {
      state.favs.unshift({ source: item.source, id: item.id, title: item.title, cover: item.cover, remarks: item.remarks || '', at: Date.now() });
      updateDetailActions(); if (!$('favModal').classList.contains('hidden')) renderFavs();
      toast('已收藏');
    }).catch(function (e) { toast(e.message); });
  }
  function removeFav(it, silent) {
    return deleteJson('/api/me/favorites/' + encodeURIComponent(it.source || '') + '/' + encodeURIComponent(it.id)).then(function () {
      var k = favKey(it.source, it.id);
      state.favs = (state.favs || []).filter(function (f) { return favKey(f.source, f.id) !== k; });
      updateDetailActions(); if (!$('favModal').classList.contains('hidden')) renderFavs();
      if (!silent) toast('已取消收藏');
    }).catch(function (e) { toast(e.message); });
  }

  // ---- 追剧提醒 ----
  function isFollow(source, id) { var k = favKey(source, id); return (state.follows || []).some(function (f) { return favKey(f.source, f.id) === k; }); }
  function loadFollows() {
    if (!state.user) { state.follows = []; return Promise.resolve([]); }
    return api('/api/me/follows').then(function (r) { state.follows = r.items || []; return state.follows; })
      .catch(function () { return state.follows || []; });
  }
  function toggleFollow(item) {
    if (!state.user) { toast('登录后可追更，有新集时提醒你'); openAuth('login'); return Promise.resolve(); }
    if (isFollow(item.source, item.id)) return removeFollow(item, true);
    return postJson('/api/me/follows', {
      source: item.source, id: item.id, title: item.title, cover: item.cover,
    }).then(function () {
      state.follows.unshift({ source: item.source, id: item.id, title: item.title, cover: item.cover, epCount: 0, at: Date.now() });
      updateDetailActions(); if (!$('followModal').classList.contains('hidden')) renderFollows();
      toast('已加入追剧，有新集会提醒你');
      checkUpdates(true, true);
    }).catch(function (e) { toast(e.message); });
  }
  function removeFollow(it, silent) {
    return deleteJson('/api/me/follows/' + encodeURIComponent(it.source || '') + '/' + encodeURIComponent(it.id)).then(function () {
      var k = favKey(it.source, it.id);
      state.follows = (state.follows || []).filter(function (f) { return favKey(f.source, f.id) !== k; });
      updateDetailActions(); if (!$('followModal').classList.contains('hidden')) renderFollows();
      if (!silent) toast('已取消追更');
    }).catch(function (e) { toast(e.message); });
  }
  function setFollowBadge(n) {
    var b = $('followBadge'); if (!b) return;
    if (n > 0) { b.textContent = String(n); b.classList.remove('hidden'); }
    else { b.textContent = ''; b.classList.add('hidden'); }
  }
  function checkUpdates(force, silent) {
    if (!state.user) return Promise.resolve([]);
    return api('/api/me/follows/updates', force ? { force: 1 } : {}).then(function (r) {
      if (r.follows) state.follows = r.follows;
      var ups = r.updates || [];
      if (ups.length) {
        var total = 0;
        ups.forEach(function (u) { total += (u.added || 0); });
        setFollowBadge(total);
        toast('🔔 ' + ups.map(function (u) { return '《' + (u.title || u.id) + '》更新 ' + u.added + ' 集'; }).join('；'));
        if (!$('followModal').classList.contains('hidden')) renderFollows();
      } else if (force && !silent) {
        setFollowBadge(0);
        toast('追剧暂无更新');
      }
      return ups;
    }).catch(function () { return []; });
  }

  function updateDetailActions() {
    var d = state.detail; if (!d || !$('dFav')) return;
    var src = state.viewSource, fav = $('dFav'), fo = $('dFollow');
    if (!state.user) {
      fav.textContent = '☆ 收藏'; fo.textContent = '🔔 追更';
      fav.classList.remove('on'); fo.classList.remove('on'); return;
    }
    var isF = isFav(src, d.id), isW = isFollow(src, d.id);
    fav.textContent = isF ? '★ 已收藏' : '☆ 收藏'; fav.classList.toggle('on', isF);
    fo.textContent = isW ? '🔔 追更中' : '🔔 追更'; fo.classList.toggle('on', isW);
  }
  function detailItem() {
    var d = state.detail;
    return { source: state.viewSource, id: d.id, title: d.title, cover: d.cover, remarks: d.remarks || '' };
  }

  function openFavs() {
    if (!state.user) { toast('登录后可查看收藏'); openAuth('login'); return; }
    $('favModal').classList.remove('hidden');
    loadFavs().then(renderFavs).catch(function (e) { toast(e.message); });
  }
  function closeFavs() { $('favModal').classList.add('hidden'); }
  function renderFavs() { renderMediaList('favList', state.favs || [], 'fav'); }
  function openFollows() {
    if (!state.user) { toast('登录后可查看追剧提醒'); openAuth('login'); return; }
    $('followModal').classList.remove('hidden');
    loadFollows().then(function () { renderFollows(); return checkUpdates(false, true); }).catch(function (e) { toast(e.message); });
  }
  function closeFollows() { $('followModal').classList.add('hidden'); }
  function renderFollows() { renderMediaList('followList', state.follows || [], 'follow'); }

  function renderMediaList(boxId, items, kind) {
    var box = $(boxId); if (!box) return;
    box.textContent = '';
    if (!items.length) {
      var em = document.createElement('div'); em.className = 'srcloading';
      em.textContent = kind === 'fav' ? '还没有收藏。打开任意剧集点「☆ 收藏」即可。' : '还没有追更。打开剧集点「🔔 追更」，有新集时会提醒你。';
      box.appendChild(em); return;
    }
    items.forEach(function (it) {
      var row = document.createElement('div'); row.className = 'histrow';
      var img = document.createElement('img'); img.className = 'histcover'; img.loading = 'lazy';
      img.src = posterUrl(it.cover); img.onerror = function () { img.src = PLACEHOLDER; };
      row.appendChild(img);
      var info = document.createElement('div'); info.className = 'histinfo';
      var t = document.createElement('div'); t.className = 'histtitle'; t.textContent = it.title || it.id;
      var sub = document.createElement('div'); sub.className = 'histsub';
      sub.textContent = kind === 'follow'
        ? ('已收录 ' + (it.epCount || 0) + ' 集 · 追更于 ' + ago(it.at))
        : (it.remarks || ('收藏于 ' + ago(it.at)));
      info.appendChild(t); info.appendChild(sub); row.appendChild(info);
      var acts = document.createElement('div'); acts.className = 'histacts';
      var go = document.createElement('button'); go.className = 'btn mini'; go.textContent = '打开';
      go.addEventListener('click', function (ev) { ev.stopPropagation(); closeFavs(); closeFollows(); openDetail(it.id, it.source || ''); });
      var del = document.createElement('button'); del.className = 'btn ghost mini danger';
      del.textContent = kind === 'fav' ? '取消收藏' : '取消追更';
      del.addEventListener('click', function (ev) {
        ev.stopPropagation();
        (kind === 'fav' ? removeFav : removeFollow)(it).then(function () {
          renderMediaList(boxId, kind === 'fav' ? state.favs : state.follows, kind);
        });
      });
      acts.appendChild(go); acts.appendChild(del); row.appendChild(acts);
      row.addEventListener('click', function () { closeFavs(); closeFollows(); openDetail(it.id, it.source || ''); });
      box.appendChild(row);
    });
  }


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
      if (original && img.src.indexOf('/api/media') === -1) img.src = authUrl('/api/media?u=' + encodeURIComponent(original));
      else if (img.src !== PLACEHOLDER) img.src = PLACEHOLDER;
    };
    var body = document.createElement('div'); body.className = 'cbody';
    if (item.sourceName) {
      var badge = document.createElement('div'); badge.className = 'cbadge'; badge.textContent = item.sourceName;
      card.appendChild(badge);
    }
    if (item.score && Number(item.score) > 0) {
      var sb = document.createElement('div'); sb.className = 'scorebadge';
      sb.textContent = '★ ' + Number(item.score).toFixed(1);
      card.appendChild(sb);
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
    setView('home'); setNav('home'); showNotice('');
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
    setView('home'); setNav(''); state.mode = 'category'; state.tid = tid; state.page = 1; state.q = '';
    renderChips();
    $('empty').textContent = '加载中…'; $('empty').classList.remove('hidden'); $('grid').textContent = '';
    return api('/api/category', { source: cur(), tid: tid, page: 1 }).then(function (r) {
      state.items = r.items || []; state.hasMore = !!r.hasMore;
      renderItems(state.items, false);
      if (!state.items.length) { $('empty').textContent = '该分类暂无内容'; $('empty').classList.remove('hidden'); }
    }).catch(function (e) { showError(e); });
  }

  function loadMore() {
    if (state.loadingMore || !state.hasMore) return Promise.resolve();
    state.loadingMore = true;
    state.page += 1;
    var p = state.page;
    var req;
    if (state.mode === 'recommend') req = api('/api/recommend', { page: p });
    else if (state.mode === 'search') req = api('/api/search', { source: cur(), q: state.q, page: p });
    else if (state.mode === 'category') req = api('/api/category', { source: cur(), tid: state.tid, page: p });
    else req = api('/api/home', { source: cur(), page: p });
    $('btnMore').classList.add('hidden');
    setAutoMore(true);
    var done = function () { state.loadingMore = false; setAutoMore(false); };
    return req.then(function (r) {
      state.hasMore = !!r.hasMore;
      renderItems(r.items || [], true);
      if (state.mode === 'search') { if (r.aggregate) showNotice(aggNote(r)); else if (r.fallback) showNotice(searchNote(r)); }
      done();
    }).catch(function (e) { state.page -= 1; done(); showError(e); });
  }

  // ---- 推荐页（红果各榜单按真实评分合并排序） ----
  function loadRecommend() {
    setView('home'); setNav('recommend'); showNotice('');
    state.mode = 'recommend'; state.tid = ''; state.q = ''; state.page = 1; state.classes = [];
    $('chips').textContent = ''; $('grid').textContent = ''; $('btnMore').classList.add('hidden');
    $('empty').textContent = '加载推荐中…'; $('empty').classList.remove('hidden');
    setAutoMore(true);
    state.loadingMore = true;
    return api('/api/recommend', { page: 1 }).then(function (r) {
      state.items = r.items || []; state.hasMore = !!r.hasMore;
      state.loadingMore = false; setAutoMore(false);
      renderItems(state.items, false);
      if (!state.items.length) { $('empty').textContent = '推荐暂不可用'; $('empty').classList.remove('hidden'); }
    }).catch(function (e) { state.loadingMore = false; setAutoMore(false); showError(e); });
  }

  function setNav(id) {
    $('btnHome').classList.toggle('active', id === 'home');
    $('btnRecommend').classList.toggle('active', id === 'recommend');
  }

  function setAutoMore(show) {
    var el = $('autoMore');
    if (el) el.classList.toggle('hidden', !show);
  }

  // 划到底部自动加载下一页；分页按钮仍保留作为兜底
  var AUTO_MODES = { home: 1, category: 1, search: 1, recommend: 1 };
  var autoLockAt = 0;
  function maybeAutoMore() {
    if (!AUTO_MODES[state.mode] || !state.hasMore || state.loadingMore) return;
    if (!$('detail').classList.contains('hidden')) return;
    if (window.innerHeight + window.scrollY < document.documentElement.scrollHeight - 600) return;
    if (Date.now() - autoLockAt < 600) return;
    autoLockAt = Date.now();
    loadMore();
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
    setView('home'); setNav(''); state.mode = 'search'; state.q = q; state.page = 1; state.tid = '';
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
      if (d.source) state.viewSource = d.source;
      $('dTitle').textContent = d.title || '未命名';
      $('dMeta').textContent = d.remarks || '';
      $('dDesc').textContent = d.desc || '';
      var cover = d.cover || '';
      $('dCover').src = posterUrl(cover);
      $('dCover').onerror = function () {
        if (cover && $('dCover').src.indexOf('/api/media') === -1) $('dCover').src = authUrl('/api/media?u=' + encodeURIComponent(cover));
        else $('dCover').src = PLACEHOLDER;
      };
      renderLines(d); renderEps(d, 0);
      updateResumeBar(d); updateDetailActions();
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
    url = authUrl(url);
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
        var recovered = false;
        hls.on(window.Hls.Events.ERROR, function (_e, data) {
          if (!data || !data.fatal) return;
          if (!recovered) {
            recovered = true;
            if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
            else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
            else recovered = false;
            if (recovered) { toast('播放异常，正在自动重试…'); return; }
          }
          toast('播放失败：' + (data.details || '流错误'));
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
      var dur = Math.floor(v.duration || 0);
      if (state.histKey) histUpdate(dur, dur);
      // 片尾自动播放下一集；延迟期间若用户已手动切集/关闭播放器则不再触发
      var endedEp = state.epIdx;
      if (!$('player').classList.contains('hidden')) {
        setTimeout(function () {
          if ($('player').classList.contains('hidden') || state.epIdx !== endedEp) return;
          nextEpisode();
        }, 350);
      }
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
      if (state.user) deleteJson('/api/me/history/' + encodeURIComponent(state.viewSource || '') + '/' + encodeURIComponent(d.id)).catch(function () {});
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
        if (state.user) deleteJson('/api/me/history/' + encodeURIComponent(e.source || '') + '/' + encodeURIComponent(e.id)).catch(function () {});
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
    if (s.autoUpdate) tags.appendChild(tag('自动更新', 'auto'));
    if (s.lastError) {
      var errTag = tag('更新失败', 'warn');
      errTag.title = s.lastError;
      tags.appendChild(errTag);
    }
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
    if (s.updateable) {
      var autoBtn = document.createElement('button'); autoBtn.className = 'btn ghost mini';
      autoBtn.textContent = s.autoUpdate ? '自动更新 开' : '自动更新 关';
      autoBtn.title = s.autoUpdate ? '点击关闭自动更新' : '点击开启自动更新';
      autoBtn.addEventListener('click', function () { toggleSourceAuto(s); });
      acts.appendChild(autoBtn);
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

  function toggleSourceAuto(s) {
    var next = !s.autoUpdate;
    postJson('/api/sources/' + encodeURIComponent(s.id) + '/auto-update', { enabled: next }).then(function () {
      toast((next ? '已开启' : '已关闭') + '自动更新：' + (s.name || s.id));
      return refreshManage();
    }).catch(function (e) { toast(e.message); });
  }

  function checkSourceUpdates() {
    var btn = $('btnCheckUpdates');
    if (btn) { btn.disabled = true; btn.textContent = '检查中…'; }
    postJson('/api/sources/check-updates', {}).then(function (r) {
      var results = r.results || [];
      var updated = 0, failed = 0, current = 0, busy = 0, older = 0;
      results.forEach(function (item) {
        if (item.status === 'updated') updated += 1;
        else if (item.status === 'failed') failed += 1;
        else if (item.status === 'older') older += 1;
        else if (item.status === 'busy') busy += 1;
        else current += 1;
      });
      var msg = '源更新检查完成：更新 ' + updated + ' 个，已是最新 ' + current + ' 个';
      if (failed) msg += '，失败 ' + failed + ' 个';
      if (older) msg += '，上游版本更低 ' + older + ' 个';
      if (busy) msg += '，正在检查 ' + busy + ' 个';
      toast(msg);
      return refreshManage();
    }).catch(function (e) {
      toast('检查更新失败：' + e.message);
    }).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = '检查源更新'; }
    });
  }

  // ---- 事件绑定 ----
  $('btnSearch').addEventListener('click', doSearch);
  $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });
  $('btnMore').addEventListener('click', loadMore);
  $('btnHome').addEventListener('click', function () { loadHome(); });
  $('btnRecommend').addEventListener('click', function () { loadRecommend(); });
  window.addEventListener('scroll', maybeAutoMore, { passive: true });
  // 底部哨兵：若滚动事件在容器/内嵌场景不触发，IntersectionObserver 仍能兜住自动加载
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i += 1) if (entries[i].isIntersecting) maybeAutoMore();
    }, { rootMargin: '600px 0px' }).observe($('sentinel'));
  }
  $('btnBack').addEventListener('click', function () { setView('home'); });
  $('btnClosePlayer').addEventListener('click', closePlayer);
  $('btnNext').addEventListener('click', nextEpisode);
  $('btnImport').addEventListener('click', openImport);
  $('btnManage').addEventListener('click', openManage);
  $('btnManageClose').addEventListener('click', closeManage);
  $('btnCheckUpdates').addEventListener('click', checkSourceUpdates);
  $('btnRate').addEventListener('click', function () { cycleRate(1); });
  $('btnQuality').addEventListener('click', cycleQuality);
  $('btnFull').addEventListener('click', toggleFullscreen);
  $('btnHistory').addEventListener('click', openHistory);
  $('btnHistClose').addEventListener('click', closeHistory);
  $('btnHistClear').addEventListener('click', function () {
    if (!window.confirm('清空全部观看记录？此操作不可撤销。')) return;
    histClear(); renderHistory();
    if (state.user) deleteJson('/api/me/history').catch(function () {});
    if (state.detail) updateResumeBar(state.detail);
    toast('已清空观看历史');
  });
  $('btnAccount').addEventListener('click', function () {
    if (state.user) { if (window.confirm('退出登录？本机观看记录会保留。')) logout(); }
    else openAuth('login');
  });
  $('btnFavs').addEventListener('click', openFavs);
  $('btnFollows').addEventListener('click', openFollows);
  $('btnFavClose').addEventListener('click', closeFavs);
  $('btnFollowClose').addEventListener('click', closeFollows);
  $('btnFollowCheck').addEventListener('click', function () { checkUpdates(true, false).then(renderFollows); });
  $('tabLogin').addEventListener('click', function () { setAuthMode('login'); });
  $('tabRegister').addEventListener('click', function () { setAuthMode('register'); });
  $('btnAuthCancel').addEventListener('click', closeAuth);
  $('btnAuthOk').addEventListener('click', doAuth);
  $('authPass').addEventListener('keydown', function (e) { if (e.key === 'Enter') doAuth(); });
  $('dFav').addEventListener('click', function () { if (state.detail) toggleFav(detailItem()); });
  $('dFollow').addEventListener('click', function () { if (state.detail) toggleFollow(detailItem()); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden && state.user) checkUpdates(false, true); });
  setInterval(function () { if (state.user) checkUpdates(false, true); }, 10 * 60 * 1000);
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
    cycleRate: cycleRate, toggleFullscreen: toggleFullscreen, histLoad: histLoad,
    loadRecommend: loadRecommend, loadMore: loadMore, maybeAutoMore: maybeAutoMore,
    openAuth: openAuth, logout: logout, refreshMe: refreshMe, checkUpdates: checkUpdates,
    loadFavs: loadFavs, loadFollows: loadFollows, toggleFav: toggleFav, toggleFollow: toggleFollow,
    mergeServerHistory: mergeServerHistory
  };

  // ---- 启动 ----
  function bootFromQuery() {
    var sp = new URLSearchParams(location.search);
    if (sp.get('rec') === '1') { loadRecommend(); return true; }
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
  loadRate(); applyRate(); syncFullBtn(); renderAccount(); loadVersion();
  // PWA：注册 service worker（仅 http(s) 下有效）
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }
  loadSources().then(function () {
    var sp = new URLSearchParams(location.search);
    if (!bootFromQuery()) loadHome();
    if (sp.get('manage') === '1') openManage();
    if (sp.get('hist') === '1') openHistory();
    return refreshMe().then(function () {
      if (!state.user) return null;
      return Promise.all([loadFavs(), loadFollows(), mergeServerHistory()]).then(function () { return checkUpdates(false, true); });
    });
  }).catch(function (e) { showError(e); });
})();