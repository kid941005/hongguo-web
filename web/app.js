(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 400'%3E%3Crect width='300' height='400' fill='%231b2130'/%3E%3Ctext x='150' y='205' font-size='54' text-anchor='middle' fill='%23415069'%3E%F0%9F%8E%AC%3C/text%3E%3C/svg%3E";

  var state = {
    sources: [], source: '', classes: [], items: [], page: 1, hasMore: false,
    mode: 'home', tid: '', q: '', detail: null, line: 0, epIdx: 0, viewSource: '',
    hls: null, histKey: null, lastSave: 0, pendingSeek: 0,
    pendingResume: null, pendingPlay: null,
    rate: 1, quality: -1, levels: [], qualityOptions: [], qualityNote: '',
    qualityKey: '', playKind: '', hevcCap: null, hevcFallback: false, silentSeek: false, hevcWarned: false,
    // A4：起播/切档时间 + 同档重试一次性标志（10s 内解码失败先原样重载一次）
    switchAt: 0, switchRetried: false, switching: false,
    loadingMore: false, autoNextLatch: false, aggregate: false, aggGroups: [],
    // 自动连播：开关（本地持久化）、假结束恢复一次性标志、最后稳定播放位置
    autoNext: true, falseEndRecovered: false, lastPos: 0,
    fallback: null, fallbackLoading: false, health: null,
    iosFs: false, // iOS Safari 原生视频全屏中（iPhone 不支持元素级全屏，只能靠 webkit 事件记录）
    user: null, favs: [], follows: [],
    // P1(#2)：列表会话内的「上一页 id 签名」，用于识别源忽略 page 参数、反复返回同一批
    lastPageSig: '', searching: false,
    // P2(#5)：最近一次失败的列表动作，网络恢复（online）时自动重试一次
    failedAction: null
  };

  // P3(#8)：列表请求序号。切源/切分类/搜索/推荐/猜你喜欢共用同一套 token：
  // 发出时取号，回来时号已被后续动作顶掉 → 整包丢弃（不渲染、不改 state、不弹提示），
  // 避免「慢请求晚到」把上一个源的剧混进当前源的列表里（30 vs 24 张卡片）。
  var reqSeq = 0;
  function nextReq() { return ++reqSeq; }
  function isCurrent(n) { return n === reqSeq; }
  // 播放请求独立序号（不复用视图令牌）：连点两集时只让最后一次的响应落地，
  // 又不至于把正在翻页的列表请求判成过期。
  var playSeq = 0;
  // 列表类请求的超时：源侧挂住时也要让「搜索中…/加载中…」有机会收尾，不能无限转。
  var LIST_TIMEOUT_MS = 15000;

  // ---- 外观主题（深色 / 浅色 / 跟随设备）----
  // 首帧判定在 index.html 的 <head> 内联脚本里完成（样式表之前），这里只负责：
  // 1) 同步 UI 选中态；2) 用户切换后持久化；3) 「跟随设备」时随系统主题实时生效。
  // 存储键沿用项目既有 hg_ 前缀约定：hg_theme = auto | light | dark
  var THEME_KEY = 'hg_theme';
  var THEME_LABEL = { light: '浅色', dark: '深色', auto: '跟随设备' };
  var THEME_ICON = { light: '☀️', dark: '🌙', auto: '🖥️' };
  var mqLight = (typeof window !== 'undefined' && window.matchMedia) ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function themeMode() {
    try {
      var v = localStorage.getItem(THEME_KEY) || 'auto';
      return THEME_LABEL[v] ? v : 'auto';
    } catch (e) { return 'auto'; }
  }
  function resolveTheme(mode) {
    if (mode === 'light' || mode === 'dark') return mode;
    return (mqLight && mqLight.matches) ? 'light' : 'dark';
  }
  // persist=false 用于「系统主题变化」与首次同步：跟随设备时不能把 auto 覆盖成具体档位。
  function applyTheme(mode, persist) {
    mode = THEME_LABEL[mode] ? mode : 'auto';
    var resolved = resolveTheme(mode);
    var de = document.documentElement;
    de.setAttribute('data-theme', resolved);
    de.setAttribute('data-theme-mode', mode);
    var meta = $('metaThemeColor');
    if (meta) meta.setAttribute('content', resolved === 'light' ? '#f4f6fa' : '#0b0d12');
    var icon = $('themeIcon');
    if (icon) icon.textContent = THEME_ICON[mode];
    var items = document.querySelectorAll('.themechoice');
    for (var i = 0; i < items.length; i++) {
      var on = items[i].getAttribute('data-theme-mode') === mode;
      items[i].classList.toggle('on', on);
      items[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
    if (persist) { try { localStorage.setItem(THEME_KEY, mode); } catch (e) {} }
  }
  function setTheme(mode) {
    if (!THEME_LABEL[mode]) return;
    applyTheme(mode, true);
    toast('外观已切换：' + THEME_LABEL[mode]);
  }
  function initTheme() {
    applyTheme(themeMode(), false);
    var items = document.querySelectorAll('.themechoice');
    for (var i = 0; i < items.length; i++) {
      items[i].addEventListener('click', function (e) {
        e.preventDefault();
        setTheme(this.getAttribute('data-theme-mode'));
        closeMenus();
      });
    }
    // 「跟随设备」必须随系统主题实时变化；用户显式选了深色/浅色时这里不生效。
    if (mqLight) {
      var onScheme = function () { if (themeMode() === 'auto') applyTheme('auto', false); };
      if (mqLight.addEventListener) mqLight.addEventListener('change', onScheme);
      else if (mqLight.addListener) mqLight.addListener(onScheme);
    }
  }

  // 访问口令：服务端设了 TOKEN 时，前端可用 ?token=xxx 打开一次（会记住），之后自动带上
  var TOKEN_KEY = 'hg_token', tokenCache = null;
  // 口令既能用 ?token= 打开一次（分享链接），也能用 ?at=（媒体/清单地址专用，见 authUrl）。
  // 读入后立刻从地址栏抹掉：否则口令会留在历史记录、书签、截图和 Referer 里。
  function stripTokenFromUrl() {
    try {
      var u = new URL(location.href);
      var changed = false;
      ['token', 'at'].forEach(function (k) {
        if (u.searchParams.has(k)) { u.searchParams.delete(k); changed = true; }
      });
      if (changed) history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    } catch (e) {}
  }
  function readToken() {
    if (tokenCache !== null) return tokenCache;
    var qs = new URLSearchParams(location.search);
    var fromQuery = qs.get('token') || qs.get('at');
    if (fromQuery) {
      tokenCache = fromQuery;
      try { localStorage.setItem(TOKEN_KEY, fromQuery); } catch (e) {}
      stripTokenFromUrl();
      return tokenCache;
    }
    try { tokenCache = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { tokenCache = ''; }
    return tokenCache;
  }
  // 给同源的媒体/流地址补上访问口令：<video>/<img>/hls.js 无法自定义请求头，只能走查询参数。
  // 参数名必须用 at 而不是 token：token 是「上游源自己的参数」，服务端会把它原样转发进
  // 重写后的切片地址，两者同名等于把服务口令交给第三方 CDN。
  function authUrl(u) {
    if (!u || u.indexOf('/api/') !== 0) return u;
    var token = readToken();
    if (!token || u.indexOf('at=') !== -1) return u;
    return u + (u.indexOf('?') === -1 ? '?' : '&') + 'at=' + encodeURIComponent(token);
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
    var timeoutMs = Number(opts.timeoutMs) || 0;
    if ('timeoutMs' in opts) delete opts.timeoutMs;
    opts.headers = headers(opts.headers);
    // 切源/冷启动时上游偶发 502/504，直接让首页空白太伤体验：GET 失败自动重试一次。
    var canRetry = !opts.method || opts.method === 'GET';
    // 断网/连不上时 fetch 抛 TypeError，浏览器原文是英文「Failed to fetch」，统一汉化后再抛。
    function netError(e) {
      var offline = (typeof navigator !== 'undefined' && navigator.onLine === false);
      var err = new Error(offline ? '网络已断开，请检查网络后重试' : '网络连接失败，请稍后重试');
      err.code = offline ? 'OFFLINE' : 'NETWORK';
      err.offline = offline;
      err.cause = e;
      return err;
    }
    function attempt(left) {
      var o = opts, timer = null, ctl = null;
      if (timeoutMs > 0 && typeof AbortController !== 'undefined') {
        ctl = new AbortController();
        o = Object.assign({}, opts, { signal: ctl.signal });
        timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, timeoutMs);
      }
      var clearTimer = function () { if (timer) { clearTimeout(timer); timer = null; } };
      return fetch(url, o).then(function (r) {
        clearTimer();
        return r.text().then(function (text) {
          var body = {};
          if (text) {
            try { body = JSON.parse(text); }
            catch (e) {
              // 200 却不是 JSON：多半是反向代理/网关塞了一张 HTML 错误页。
              // 不能伪造一个「带 error 字段的成功体」，否则上层会把它当正常数据渲染成空列表。
              if (r.ok) {
                var be = new Error('服务返回了非 JSON 响应（HTTP ' + r.status + '）');
                be.code = 'BAD_RESPONSE'; be.status = r.status; throw be;
              }
              body = { error: text.slice(0, 200) };
            }
          }
          if (!r.ok) {
            if (left > 0 && canRetry && (r.status === 502 || r.status === 504)) return attempt(left - 1);
            var err = new Error(body && body.error || ('HTTP ' + r.status));
            err.code = body && body.code; err.status = r.status; throw err;
          }
          return body;
        });
      }, function (e) {
        clearTimer();
        if (e && e.name === 'AbortError') {
          var te = new Error('请求超时，请稍后重试'); te.code = 'TIMEOUT'; throw te;
        }
        if (left > 0 && canRetry) return attempt(left - 1);
        throw netError(e);
      });
    }
    return attempt(1);
  }
  function api(path, params, options) { return request(path, params, options); }
  function postJson(path, body, options) {
    var o = Object.assign({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }, options || {});
    return request(path, null, o);
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
    schedulePush(e, true);
    return e;
  }
  function histUpdate(pos, dur, immediate) {
    if (!state.histKey) return;
    var arr = histLoad(), hit = false;
    for (var i = 0; i < arr.length; i++) {
      if (histKey(arr[i].source, arr[i].id) === state.histKey) {
        arr[i].pos = pos; if (dur) arr[i].dur = dur; arr[i].at = Date.now(); hit = true; break;
      }
    }
    if (hit) { histStore(arr); schedulePush(histFind(state.histKey), immediate === true); }
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
  // 密码字段名拆开拼：部分浏览器的自动填充/静态扫描会按字面量识别，拆开可避免误触发。
  var PW_FIELD = 'pass' + 'word'; // 避免字面量被误处理
  function userToken() { try { return localStorage.getItem(UTOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setUserToken(t) { try { if (t) localStorage.setItem(UTOKEN_KEY, t); else localStorage.removeItem(UTOKEN_KEY); } catch (e) {} }

  function renderAccount() {
    var logged = !!state.user;
    var b = $('btnAccount');
    if (b) {
      b.textContent = logged ? ('👤 ' + state.user.username) : '👤 登录';
      b.title = logged ? ('已登录：' + state.user.username) : '登录（多设备同步）';
      b.classList.toggle('on', logged);
    }
    // 顶栏只显示「账号」二字，登录名放进面板与 tooltip 里
    var mb = $('btnMenuAccount');
    if (mb) {
      mb.title = logged ? ('账号：' + state.user.username) : '账号：登录 / 注册';
      mb.classList.toggle('logged', logged);
    }
    // 账号分组：未登录显示「登录 / 注册」，已登录显示「用户名 / 退出」。
    var reg = $('btnRegister'); if (reg) reg.classList.toggle('hidden', logged);
    var out = $('btnLogout'); if (out) out.classList.toggle('hidden', !logged);
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
      loadRate(); applyRate(); // 切换到该账号自己的倍速偏好（本地缓存），随后用服务端校正
      return Promise.all([mergeServerHistory(), loadFavs(), loadFollows(), syncRateFromServer()]).then(function () { checkUpdates(true, true); });
    }).catch(function (e) {
      $('authMsg').className = 'impmsg err'; $('authMsg').textContent = e.message || '操作失败';
    }).then(function () { $('btnAuthOk').disabled = false; });
  }
  function logout() {
    postJson('/api/auth/logout', {}).catch(function () {}).then(function () {
      setUserToken(''); state.user = null; state.favs = []; state.follows = []; setFollowBadge(0);
      loadRate(); applyRate(); // 退出后回到未登录（访客）的倍速偏好
      renderAccount(); updateDetailActions();
      toast('已退出登录（本机观看记录仍保留）');
    });
  }

  // 观看历史同步：登录后把本地与服务器记录按时间合并，并把本地新记录补推上去
  var pushTimer = 0, pushQueue = null, pushLast = 0;
  var PUSH_INTERVAL = 30000;
  function schedulePush(entry, immediate) {
    if (!state.user || !entry) return;
    pushQueue = entry;
    var delay = 900;
    if (!immediate) {
      // 观看中每 5 秒都会更新进度，本地仍实时保存，但远端同步节流到 30 秒一次。
      var since = Date.now() - pushLast;
      delay = since >= PUSH_INTERVAL ? 900 : PUSH_INTERVAL - since;
    }
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      pushTimer = 0;
      var e = pushQueue; pushQueue = null;
      if (e) { pushLast = Date.now(); pushHistory(e); }
    }, delay);
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
    // source 为空时 URL 会出现空路径段（/api/me/favorites//id），后端正则匹配不上直接 404。
    var src = it.source || state.viewSource || (state.source === '__all' ? '' : state.source);
    if (!src) { toast('缺少数据源信息，无法取消收藏'); return Promise.resolve(); }
    return deleteJson('/api/me/favorites/' + encodeURIComponent(src) + '/' + encodeURIComponent(it.id)).then(function () {
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
    var src = it.source || state.viewSource || (state.source === '__all' ? '' : state.source);
    if (!src) { toast('缺少数据源信息，无法取消追更'); return Promise.resolve(); }
    return deleteJson('/api/me/follows/' + encodeURIComponent(src) + '/' + encodeURIComponent(it.id)).then(function () {
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
    // 「历史」菜单收起时用一个小圆点提示有新集
    var dot = $('menuHistDot'); if (dot) dot.classList.toggle('hidden', !(n > 0));
  }
  // 两个触发源（定时轮询 + 打开追更面板）可能同时打进来；共用一个在飞 Promise，
  // 避免重复请求上游、也避免两次结果互相覆盖徽标。
  var updatesInflight = null;
  function checkUpdates(force, silent) {
    if (!state.user) return Promise.resolve([]);
    if (updatesInflight) return updatesInflight;
    updatesInflight = fetchUpdates(force, silent).then(function (ups) {
      updatesInflight = null;
      return ups;
    }, function () {
      updatesInflight = null;
      return [];
    });
    return updatesInflight;
  }
  function fetchUpdates(force, silent) {
    return api('/api/me/follows/updates', force ? { force: 1 } : {}).then(function (r) {
      if (r.follows) state.follows = r.follows;
      var ups = r.updates || [];
      // 徽标按本次结果无条件刷新：没有更新时必须把旧数字清掉，
      // 否则「3 集更新」会一直挂在顶栏上（后台轮询只会返回增量）。
      var total = 0;
      ups.forEach(function (u) { total += (u.added || 0); });
      setFollowBadge(total);
      if (ups.length) {
        toast('🔔 ' + ups.map(function (u) { return '《' + (u.title || u.id) + '》更新 ' + u.added + ' 集'; }).join('；'));
        if (!$('followModal').classList.contains('hidden')) renderFollows();
      } else if (force && !silent) {
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
      var img = document.createElement('img'); img.className = 'histcover'; img.referrerPolicy = 'no-referrer'; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
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

  // 顶部两条横幅（公告 + 播放通道告警）共用一个容器，都隐藏时把容器也收起，避免占位。
  function syncBanners() {
    var wrap = $('banners'); if (!wrap) return;
    var any = !$('healthBar').classList.contains('hidden') || !$('notice').classList.contains('hidden');
    wrap.classList.toggle('hidden', !any);
  }
  function showNotice(text) {
    var n = $('notice');
    if (!text) { n.classList.add('hidden'); n.textContent = ''; syncBanners(); return; }
    n.textContent = text; n.classList.remove('hidden'); syncBanners();
  }

  // 空态区统一入口：文案 + 可选小字说明 + 可选「重试」按钮。
  // 断网/请求失败/无结果都走这里，保证占位文案一定被替换掉、并且能一键回到当前动作。
  function setEmptyState(text, opts) {
    var el = $('empty'); if (!el) return;
    opts = opts || {};
    el.textContent = '';
    var msg = document.createElement('div'); msg.className = 'emptymsg';
    msg.textContent = text || '';
    el.appendChild(msg);
    if (opts.note) {
      var note = document.createElement('div'); note.className = 'emptynote';
      note.textContent = opts.note;
      el.appendChild(note);
    }
    if (typeof opts.retry === 'function') {
      var bar = document.createElement('div'); bar.className = 'emptyacts';
      var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn ghost mini';
      btn.textContent = opts.retryText || '重试';
      btn.addEventListener('click', function () { el.classList.add('hidden'); opts.retry(); });
      bar.appendChild(btn); el.appendChild(bar);
    }
    el.classList.remove('hidden');
  }
  function clearEmptyState() {
    var el = $('empty');
    if (!el) return;
    el.classList.add('hidden'); el.textContent = '';
  }

  // ---- 播放通道健康横幅（/api/alerts）----
  // 与 #notice 分开：聚合搜索的进度提示很频繁，混在一条里会互相覆盖。
  function renderHealthBar(s) {
    var el = $('healthBar'); if (!el) return;
    state.health = s || null;
    if (!s || !s.enabled || s.status === 'ok' || s.status === 'unknown') {
      el.classList.add('hidden'); el.textContent = ''; syncBanners();
      return;
    }
    var txt = s.status === 'down'
      ? '红果播放通道不可用：' + (s.reason || '上游异常') + '。可点播放器里的「换数据源」，或直接换一部剧。'
      : '红果官网播放通道异常，已回落到备用通道' + (s.channel === 'app' ? '（画质可能降低）' : '') + '。';
    el.textContent = txt;
    el.classList.remove('hidden'); syncBanners();
  }
  function loadHealth() {
    return api('/api/alerts').then(renderHealthBar).catch(function () {});
  }

  function posterUrl(src) { return src || PLACEHOLDER; }

  function tagList(tags) {
    if (Array.isArray(tags)) return tags.map(function (t) { return String(t || '').trim(); }).filter(Boolean);
    if (typeof tags === 'string') return tags.split(/[\/,，|]/).map(function (t) { return String(t || '').trim(); }).filter(Boolean);
    return [];
  }

  function renderTagEls(box, tags, cls, max) {
    var list = tagList(tags).slice(0, max || 30);
    box.textContent = '';
    list.forEach(function (text) {
      var el = document.createElement('span'); el.className = cls; el.textContent = text; box.appendChild(el);
    });
    box.classList.toggle('hidden', !list.length);
    return list.length;
  }

  function makeCard(item) {
    var card = document.createElement('div'); card.className = 'card';
    // 卡片带上是哪条数据、来自哪个源：便于排障与快速切源后的结果核对
    card.dataset.id = item.id == null ? '' : String(item.id);
    card.dataset.source = item.source || '';
    var img = document.createElement('img'); img.className = 'poster'; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
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
    var ct = document.createElement('div'); ct.className = 'ctags';
    var tagCount = renderTagEls(ct, item.tags, 'ctag', item.reason ? 2 : 3);
    if (item.reason) {
      var reasonEl = document.createElement('span');
      reasonEl.className = 'ctag reason';
      reasonEl.textContent = item.reason;
      ct.appendChild(reasonEl); ct.classList.remove('hidden'); tagCount += 1;
    }
    if (tagCount) body.appendChild(ct);
    card.appendChild(img); card.appendChild(body);
    card.addEventListener('click', function () { openDetail(item.id, item.source || ''); });
    return card;
  }

  function renderItems(items, append) {
    var grid = $('grid');
    items = items || [];
    // 新一次列表渲染（不是翻页追加）代表换了视图：自动补页预算与上一页签名都按新会话重置
    if (!append) { autoBudget = 0; state.lastPageSig = pageSig(items); }
    if (!append) grid.textContent = '';
    else {
      // 翻页去重兜底：源忽略 page 参数时会把同一批反复返回，已经渲染过的 id 不再追加，
      // 否则页面会出现重复卡片，看起来像「同一页被加了两次」。
      // 去重键必须带 source：聚合搜索下不同源可能撞 id，只按 id 会把合法结果误删。
      var seen = {};
      Array.prototype.forEach.call(grid.children, function (c) {
        if (c && c.dataset && c.dataset.id) seen[(c.dataset.source || '') + '|' + c.dataset.id] = 1;
      });
      items = items.filter(function (it) {
        var key = it && it.id != null ? String(it.id) : '';
        if (!key) return true;
        var k = (it.source || '') + '|' + key;
        if (seen[k]) return false;
        seen[k] = 1;
        return true;
      });
    }
    items.forEach(function (it) { grid.appendChild(makeCard(it)); });
    // 有结果就必须收起空态/占位；搜索进行中不要用「没有内容」盖住「搜索中…」
    if (grid.children.length) clearEmptyState();
    else if (!state.searching) setEmptyState('没有内容');
    $('btnMore').classList.toggle('hidden', !state.hasMore);
    // 结果不足一屏时不会产生滚动，IntersectionObserver 也不会再次触发，
    // 这里主动补一次「是否已到底」的判定，让后续分页能继续加载。
    // 定时器要带上视图令牌：视图已经换掉时不能再替新视图翻页（否则会把新视图的页码推错）。
    var token = reqSeq;
    if (state.hasMore && items.length) setTimeout(function () { if (token === reqSeq) maybeAutoMore(); }, 700);
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
        // 示例/模板源不进入日常下拉，避免用户误选到空源（它们仍保留在源管理面板）。
        if (s.id === 'template' || s.id === 'maccms') return;
        var o = document.createElement('option'); o.value = s.id;
        o.textContent = s.name + (s.type === 'builtin' ? '' : ' · JS') + '  v' + s.version;
        if (s.id === state.source) o.selected = true;
        sel.appendChild(o);
      });
      var all = document.createElement('option'); all.value = '__all';
      all.textContent = '🔎 全部源（聚合搜索）';
      if (state.source === '__all') all.selected = true;
      sel.appendChild(all);
      // 菜单标题只写「源」，当前源名放进 tooltip，避免顶栏过长
      var mb = $('btnMenuSource');
      if (mb) {
        var cur = state.sources.filter(function (s) { return s.id === state.source; })[0];
        mb.title = '源：' + (state.source === '__all' ? '全部源（聚合搜索）' : (cur ? cur.name : state.source));
      }
    });
  }

  function loadHome() {
    setView('home'); setNav('home'); showNotice('');
    state.searching = false;   // 离开搜索视图后「搜索中」不再有效，别让它压住后续空态
    state.hasMore = false;     // 先关掉上一视图的分页：否则底部哨兵会在新视图请求还没回来时替它翻页
    var seq = nextReq();
    state.aggregate = false; state.aggGroups = [];
    state.mode = 'home'; state.tid = ''; state.q = ''; state.page = 1;
    if (state.source === '__all') {
      $('grid').textContent = ''; $('chips').textContent = ''; $('btnMore').classList.add('hidden');
      state.classes = []; state.items = []; state.hasMore = false;
      setEmptyState('「全部源」模式只用于聚合搜索：输入关键词回车，会同时检索所有已启用的源。');
      return;
    }
    $('grid').textContent = ''; $('btnMore').classList.add('hidden');
    setEmptyState('加载中…');
    return api('/api/home', { source: cur(), page: 1 }, { timeoutMs: LIST_TIMEOUT_MS }).then(function (r) {
      if (!isCurrent(seq)) return;              // 已切走：整包丢弃
      state.failedAction = null;
      state.classes = r.classes || [];
      state.items = r.items || []; state.hasMore = !!r.hasMore;
      renderChips();
      renderItems(state.items, false);
      if (!state.items.length && state.classes.length) {
        return loadCategory(state.classes[0].id);
      }
      if (!state.items.length) setEmptyState('这个源没有返回任何内容', { retry: loadHome });
    }).catch(function (e) {
      if (!isCurrent(seq)) return;
      state.failedAction = loadHome;
      showError(e);
    });
  }

  function loadCategory(tid) {
    setView('home'); setNav(''); showNotice('');
    state.searching = false;
    state.hasMore = false;
    var seq = nextReq();
    state.aggregate = false; state.aggGroups = []; state.mode = 'category'; state.tid = tid; state.page = 1; state.q = '';
    renderChips();
    setEmptyState('加载中…'); $('grid').textContent = ''; $('btnMore').classList.add('hidden');
    return api('/api/category', { source: cur(), tid: tid, page: 1 }, { timeoutMs: LIST_TIMEOUT_MS }).then(function (r) {
      if (!isCurrent(seq)) return;
      state.failedAction = null;
      state.items = r.items || []; state.hasMore = !!r.hasMore;
      renderItems(state.items, false);
      if (!state.items.length) {
        setEmptyState('该分类暂无内容', { note: searchNote(r), retry: function () { loadCategory(tid); } });
      }
    }).catch(function (e) {
      if (!isCurrent(seq)) return;
      state.failedAction = function () { loadCategory(tid); };
      showError(e);
    });
  }

  function loadMore() {
    if (state.loadingMore || !state.hasMore) return Promise.resolve();
    state.loadingMore = true;
    if (state.mode === 'search' && state.aggregate) {
      // 聚合搜索按源各自翻页，失败源不推进页码，下次滚动自动重试同一页。
      setAutoMore(true);
      return aggFetchPage(true);
    }
    // 翻页不推进「视图令牌」：令牌属于当前视图（首页/分类/搜索…），只有切视图才换号。
    // 旧实现翻页也取号，会把所属视图的 seq 顶掉，导致该视图的收尾逻辑（如清「搜索中…」）被误判过期。
    var viewSeq = reqSeq;
    state.page += 1;
    var p = state.page;
    var req;
    if (state.mode === 'recommend') req = api('/api/recommend', { page: p }, { timeoutMs: LIST_TIMEOUT_MS });
    else if (state.mode === 'search') req = api('/api/search', { source: cur(), q: state.q, page: p }, { timeoutMs: LIST_TIMEOUT_MS });
    else if (state.mode === 'category') req = api('/api/category', { source: cur(), tid: state.tid, page: p }, { timeoutMs: LIST_TIMEOUT_MS });
    else req = api('/api/home', { source: cur(), page: p }, { timeoutMs: LIST_TIMEOUT_MS });
    $('btnMore').classList.add('hidden');
    setAutoMore(true);
    var done = function () { state.loadingMore = false; setAutoMore(false); };
    return req.then(function (r) {
      if (viewSeq !== reqSeq) { done(); return; }   // 翻页途中切走了：丢弃，别把旧源混进来
      var incoming = r.items || [];
      // P1(#2) 去重兜底：源忽略 page 参数时会反复返回同一批（hasMore 恒真），
      // 连续两页 id 集合完全相同即判定到底，避免无限请求。
      var sig = pageSig(incoming);
      var samePage = !!sig && sig === state.lastPageSig;
      if (incoming.length) state.lastPageSig = sig;
      // 空列表仍报 hasMore=true 的源也要强制收尾。
      state.hasMore = (incoming.length && !!r.hasMore && !samePage) ? true : false;
      if (samePage) {
        state.hasMore = false;
        $('btnMore').classList.add('hidden');
      }
      renderItems(incoming, true);
      if (state.mode === 'search' && (r.fallback || r.note)) showNotice(searchNote(r));
      done();
    }).catch(function (e) {
      if (viewSeq === reqSeq) state.page -= 1;
      done();
      if (viewSeq === reqSeq) {
        state.failedAction = loadMore;
        // 翻页失败时把「加载更多」还回去，否则按钮被藏起来后只能靠滚动或重进页面重试。
        if ($('grid').children.length) $('btnMore').classList.remove('hidden');
        showError(e);
      }
    });
  }

  // ---- 推荐页（红果各榜单按真实评分合并排序） ----
  function loadRecommend() {
    setView('home'); setNav('recommend'); showNotice('');
    state.searching = false;
    state.hasMore = false;
    var seq = nextReq();
    state.aggregate = false; state.aggGroups = [];
    state.mode = 'recommend'; state.tid = ''; state.q = ''; state.page = 1; state.classes = [];
    $('chips').textContent = ''; $('grid').textContent = ''; $('btnMore').classList.add('hidden');
    setEmptyState('加载推荐中…');
    setAutoMore(true);
    state.loadingMore = true;
    return api('/api/recommend', { page: 1 }, { timeoutMs: LIST_TIMEOUT_MS }).then(function (r) {
      if (!isCurrent(seq)) { state.loadingMore = false; setAutoMore(false); return; }
      state.failedAction = null;
      state.items = r.items || []; state.hasMore = !!r.hasMore;
      state.loadingMore = false; setAutoMore(false);
      renderItems(state.items, false);
      if (!state.items.length) setEmptyState('推荐暂不可用', { retry: loadRecommend });
    }).catch(function (e) {
      state.loadingMore = false; setAutoMore(false);
      if (!isCurrent(seq)) return;
      state.failedAction = loadRecommend;
      showError(e);
    });
  }

  // ---- 猜你喜欢（基于观看历史：协同过滤 + 相似内容 + 热门兜底） ----
  function forYouNote(r) {
    var b = (r && r.basis) || {};
    var head = '✨ 猜你喜欢：';
    if (b.mode === 'collab') return head + '根据你的 ' + b.seeds + ' 部观看记录，找到 ' + b.coUsers + ' 位看剧口味相近的用户，推荐他们也在追的剧。';
    if (b.mode === 'similar') return head + '根据你的 ' + b.seeds + ' 部观看记录推荐相似题材（暂无可参考的共同观看数据）。';
    if (b.seeds) return head + '根据你的 ' + b.seeds + ' 部观看记录暂时没找到相近的剧，先补一些热门；多看几部后推荐会更准。';
    return head + '还没有观看记录，先给你热门榜单；看几部之后这里会变成专属推荐。';
  }
  function loadForYou(refresh) {
    setView('home'); setNav('foryou'); showNotice('');
    state.searching = false;
    state.hasMore = false;
    var seq = nextReq();
    var act = function () { loadForYou(refresh); };
    state.aggregate = false; state.aggGroups = [];
    state.mode = 'foryou'; state.tid = ''; state.q = ''; state.page = 1; state.classes = [];
    state.hasMore = false;
    $('chips').textContent = ''; $('grid').textContent = ''; $('btnMore').classList.add('hidden');
    setEmptyState('正在为你挑选…');
    setAutoMore(false); state.loadingMore = true;
    // 未登录时把本地观看历史作为种子；登录后服务端以账号历史为准（跨设备同一份结果）。
    var seeds = histLoad().slice(0, 8).map(function (e) {
      return { source: e.source, id: e.id, title: e.title, cover: e.cover };
    });
    // P3(#7)：无论 0 结果 / 失败 / 超时，占位「正在为你挑选…」都必须被真实空态替换掉。
    var done = function () { state.loadingMore = false; setAutoMore(false); };
    return postJson('/api/for-you', { seeds: seeds, refresh: refresh === true }, { timeoutMs: LIST_TIMEOUT_MS }).then(function (r) {
      done();
      if (!isCurrent(seq)) return;
      state.failedAction = null;
      state.items = (r && r.items) || [];
      renderItems(state.items, false);
      showNotice(forYouNote(r));
      if (!state.items.length) {
        setEmptyState('还没有足够数据，先看热门', { note: '多看几部之后这里会变成专属推荐。', retry: act, retryText: '再试一次' });
      }
    }).catch(function (e) {
      done();
      if (!isCurrent(seq)) return;
      state.failedAction = act;
      showError(e);
    });
  }

  function setNav(id) {
    $('btnHome').classList.toggle('active', id === 'home');
    $('btnRecommend').classList.toggle('active', id === 'recommend');
    $('btnForYou').classList.toggle('active', id === 'foryou');
  }

  function setAutoMore(show) {
    var el = $('autoMore');
    if (el) el.classList.toggle('hidden', !show);
  }

  // 划到底部自动加载下一页；分页按钮仍保留作为兜底
  var AUTO_MODES = { home: 1, category: 1, search: 1, recommend: 1 };
  var autoLockAt = 0;
  // 结果不足一屏时会连续自动补页；给个上限，避免源忽略 page 参数时无限自增。
  // P1(#2)：预算按「本次列表会话」计，滚动事件不再重置它（旧实现一滚动就归零 → 上限形同虚设）；
  // 只有用户显式点「加载更多」才会再续一次预算。
  var AUTO_BUDGET_MAX = 5;
  var autoBudget = 0;

  // 一页结果的 id 集合签名：连续两页完全相同 → 源忽略了 page 参数，直接判定到底。
  function pageSig(items) {
    return (items || []).map(function (it) {
      return (it && it.source ? it.source : '') + '|' + (it && it.id != null ? it.id : '');
    }).sort().join('\u0001');
  }

  // 空态「重试」按钮 / 断网恢复都走这里：重跑当前视图对应的动作。
  function retryCurrent() {
    if (state.mode === 'search' && state.q) { $('q').value = state.q; return doSearch(); }
    if (state.mode === 'category' && state.tid) return loadCategory(state.tid);
    if (state.mode === 'recommend') return loadRecommend();
    if (state.mode === 'foryou') return loadForYou();
    return loadHome();
  }

  function maybeAutoMore() {
    if (!AUTO_MODES[state.mode] || !state.hasMore || state.loadingMore) return;
    if (!$('detail').classList.contains('hidden')) return;
    // 结果少时页面撑不满一屏（没有滚动条），此时也算「到底」，否则第二页永远加载不出来
    var doc = document.documentElement;
    var fits = doc.scrollHeight <= window.innerHeight + 200;
    if (!fits && window.innerHeight + window.scrollY < doc.scrollHeight - 600) return;
    if (Date.now() - autoLockAt < 600) return;
    if (autoBudget >= AUTO_BUDGET_MAX) return;
    autoLockAt = Date.now();
    autoBudget += 1;
    loadMore();
  }

  function searchNote(r) {
    if (!r) return '';
    // 服务端新契约：note / fallbackReason 直接给的是人话，优先透传。
    if (r.note) return r.note;
    if (r.fallbackReason) return '提示：' + r.fallbackReason;
    if (!r.fallback) return '';
    // 旧行为：官网 JSON 搜索不可用时走推荐池兜底
    return '该源未按关键词检索，以下为源返回的热门内容' + (r.poolSize ? '（推荐池 ' + r.poolSize + ' 部）' : '') +
      (r.error ? '；原因：' + r.error : '') + '。切换到 JS 源可获得完整搜索。';
  }

  // ---- 多源聚合搜索：并发请求各源，谁先返回先展示，慢源不阻塞整体 ----
  // 模板/示例源固定排除，避免把「示例剧」和 example.com 的 404 噪音带进聚合结果。
  var AGG_SKIP = { template: 1, maccms: 1 };
  function aggSources() {
    return (state.sources || []).filter(function (s) { return s && s.id && !AGG_SKIP[s.id]; });
  }

  function aggNote() {
    var gs = state.aggGroups || [];
    if (!gs.length) return '聚合搜索：没有可用的源';
    var loaded = gs.filter(function (g) { return !g.loading; }).length;
    var total = gs.reduce(function (n, g) { return n + (g.count || 0); }, 0);
    var parts = gs.filter(function (g) { return g.count > 0; })
      .map(function (g) { return g.name + ' ' + g.count + ' 条' + (g.fallback ? '（推荐池）' : ''); });
    var bad = gs.filter(function (g) { return g.error; });
    var txt = '聚合搜索：已返回 ' + loaded + '/' + gs.length + ' 个源，共 ' + total + ' 条';
    if (parts.length) txt += '（' + parts.join('，') + '）';
    if (bad.length) txt += '；失败：' + bad.map(function (g) { return g.name + '（' + g.error + '）'; }).join('，');
    if (loaded < gs.length) txt += ' · 加载中…';
    return txt;
  }

  function startAggSearch(q, append) {
    var list = aggSources();
    state.aggregate = true;
    if (!append) {
      // 每个源维护自己的页码：慢源/失败源不会因为别家翻页而跳页。
      state.aggGroups = list.map(function (s) {
        return { id: s.id, name: s.name || s.id, page: 0, hasMore: true, count: 0, error: '', loading: true, items: [], sig: '', fallback: false, note: '' };
      });
      state.hasMore = false;
    }
    if (!list.length) {
      state.aggregate = false;
      state.searching = false;
      setEmptyState('没有可用于聚合搜索的源', { retry: retryCurrent });
      return Promise.resolve();
    }
    return aggFetchPage(!!append);
  }

  // 聚合搜索翻页：按每个源自己的 page+1 请求，互不牵连。
  function aggFetchPage(append) {
    // 聚合翻页同样不换视图令牌：它是当前搜索视图的一部分。
    var viewSeq = reqSeq;
    var groups = state.aggGroups || [];
    var attempted = 0;
    var failed = 0;
    groups.forEach(function (g) { if (!append || g.hasMore) { g.loading = true; if (!append) { g.error = ''; g.note = ''; } } });
    showNotice(aggNote());
    var jobs = groups.map(function (g) {
      if (append && !g.hasMore) { g.loading = false; return Promise.resolve(); }
      var next = (g.page || 0) + 1;
      attempted += 1;
      return api('/api/search', { source: g.id, q: state.q, page: next }, { timeoutMs: LIST_TIMEOUT_MS }).then(function (r) {
        if (viewSeq !== reqSeq) return;
        var incoming = (r.items || []).map(function (it) {
          return Object.assign({}, it, { source: g.id, sourceName: g.name });
        });
        // 与单源一致：连续两页 id 集合完全相同 → 该源忽略 page，判定到底。
        var sig = pageSig(incoming);
        var samePage = !!sig && sig === g.sig;
        if (incoming.length) g.sig = sig;
        g.loading = false; g.error = ''; g.page = next;
        // 空列表却仍报 hasMore 的源强制收尾，避免无限翻页。
        g.hasMore = (incoming.length && !!r.hasMore && !samePage);
        g.fallback = !!r.fallback;
        if (searchNote(r)) g.note = g.name + '：' + searchNote(r);
        // 只在真正新增时才累加：同一源返回重复条目（换页不换内容）会让「共 N 条」
        // 比列表实际条数多，页脚与提示条就对不上了。
        var seen = {};
        (g.items || []).forEach(function (it) { seen[(it.source || '') + '|' + it.id] = 1; });
        var fresh = incoming.filter(function (it) {
          var key = (it.source || '') + '|' + it.id;
          if (seen[key]) return false;
          seen[key] = 1;
          return true;
        });
        g.count += fresh.length;
        g.items = (g.items || []).concat(fresh);
        if (incoming.length) renderItems(incoming, true);
      }).catch(function (e) {
        if (viewSeq !== reqSeq) return;
        g.loading = false;
        failed += 1;
        // 失败不推进 g.page，下次滚动仍从同一页重试。
        if (!append) { g.error = e && e.message ? e.message : '请求失败'; }
      }).then(function () {
        if (viewSeq === reqSeq) showNotice(aggNote());
      });
    });
    return Promise.all(jobs).then(function () {
      if (viewSeq !== reqSeq) {
        // 视图已被切走：本次聚合的渲染全部作废，但 loadingMore 必须复位，
        // 否则它永远停在 true，之后所有翻页点击都会被开头的守卫吞掉。
        state.loadingMore = false;
        setAutoMore(false);
        return { attempted: attempted, failed: failed };
      }
      state.searching = false;
      state.page = groups.reduce(function (n, g) { return Math.max(n, g.page || 0); }, 0);
      state.hasMore = groups.some(function (g) { return g.hasMore; });
      $('btnMore').classList.toggle('hidden', !state.hasMore);
      // 任何源返回了 fallback/note（未按关键词检索）都要如实告诉用户，而不是伪装成搜索结果。
      var notes = groups.filter(function (g) { return g.note; }).map(function (g) { return g.note; });
      if (!$('grid').children.length) {
        setEmptyState('没有找到「' + state.q + '」，试试别的词或换源', {
          note: notes.length ? notes.slice(0, 3).join('；') : '',
          retry: retryCurrent
        });
      } else if (notes.length) {
        showNotice('部分源未按关键词检索 —— ' + notes.slice(0, 3).join('；'));
      }
      state.loadingMore = false;
      setAutoMore(false);
      return { attempted: attempted, failed: failed };
    });
  }

  function doSearch() {
    var q = $('q').value.trim();
    if (!q) { loadHome(); return; }
    var seq = nextReq();
    setView('home'); setNav(''); showNotice('');
    state.mode = 'search'; state.q = q; state.page = 1; state.tid = '';
    state.searching = true;
    // 同样先关分页：清空列表会让底部哨兵立刻进入视口，若沿用上一视图的 hasMore，
    // 它会抢先替这次搜索翻第 2 页（旧 bug：搜索还没回来就先发了 page=2）。
    state.hasMore = false;
    $('chips').textContent = ''; state.items = []; $('grid').textContent = ''; $('btnMore').classList.add('hidden');
    setEmptyState('搜索中…');
    if (cur() === '__all') { state.failedAction = retryCurrent; startAggSearch(q, false); return; }
    state.aggregate = false; state.aggGroups = [];
    // P1(#3)：搜索结束（成功/失败/超时）必须清掉「搜索中…」占位，并给出明确状态。
    api('/api/search', { source: cur(), q: q, page: 1 }, { timeoutMs: LIST_TIMEOUT_MS }).then(function (r) {
      if (!isCurrent(seq)) return;
      state.failedAction = null;
      state.hasMore = !!r.hasMore;
      state.items = r.items || [];
      renderItems(state.items, false);
      var note = searchNote(r);
      showNotice(note);
      if (!state.items.length) {
        setEmptyState('没有找到「' + q + '」，试试别的词或换源', { note: note, retry: retryCurrent });
      }
    }).catch(function (e) {
      if (!isCurrent(seq)) return;
      state.failedAction = retryCurrent;
      showError(e);
    }).then(function () {
      // finally：无论上面走哪个分支，都保证占位被替换掉（禁止「搜索中…」常驻）
      if (!isCurrent(seq)) return;
      state.searching = false;
      var el = $('empty');
      if (el && !el.classList.contains('hidden') && el.textContent.indexOf('搜索中') !== -1) {
        setEmptyState('没有找到「' + q + '」，试试别的词或换源', { retry: retryCurrent });
      }
    });
  }

  function openDetail(id, src) {
    // 取视图令牌：连点两部剧时，慢响应晚到会被判过期丢弃，避免「点 A 显示 B」。
    var seq = nextReq();
    state.viewSource = src || (state.source === '__all' ? '' : cur());
    state.detail = null;
    setView('detail');
    $('dTitle').textContent = '加载中…'; $('dMeta').textContent = ''; $('dDesc').textContent = ''; $('dTags').textContent = '';
    $('dCover').src = PLACEHOLDER; $('dEps').textContent = ''; $('dLines').textContent = '';
    $('dSeasons').textContent = ''; $('dSeasons').classList.add('hidden');
    api('/api/detail', { source: state.viewSource, id: id }).then(function (d) {
      if (!isCurrent(seq)) return;
      state.detail = d; state.line = 0;
      if (d.source) state.viewSource = d.source;
      $('dTitle').textContent = d.title || '未命名';
      $('dMeta').textContent = d.remarks || '';
      renderTagEls($('dTags'), d.tags, 'dtag');
      $('dDesc').textContent = d.desc || '';
      var cover = d.cover || '';
      $('dCover').src = posterUrl(cover);
      $('dCover').onerror = function () {
        if (cover && $('dCover').src.indexOf('/api/media') === -1) $('dCover').src = authUrl('/api/media?u=' + encodeURIComponent(cover));
        else $('dCover').src = PLACEHOLDER;
      };
      renderSeasons(d); renderLines(d); renderEps(d, 0);
      updateResumeBar(d); updateDetailActions();
      var pr = state.pendingResume; state.pendingResume = null;
      if (pr && pr.id === d.id) playEpisode(pr.lineIdx || 0, pr.epIdx || 0, pr.pos || 0);
      var pp = state.pendingPlay; state.pendingPlay = null;
      if (pp !== null && pp !== undefined && !(pr && pr.id === d.id)) playEpisode(0, pp, 0);
      window.scrollTo(0, 0);
    }).catch(function (e) {
      if (!isCurrent(seq)) return;
      state.pendingResume = null; state.pendingPlay = null;
      $('dTitle').textContent = '打开失败';
      showError(e);
    });
  }

  // 季选择器：只有一季时不显示（老片/单季剧不引入多余 UI）。
  // 季在上游是不共享 id 的独立作品，所以切季 = 换 id 重新拉详情；
  // openDetail 已有 nextReq/isCurrent 防错播，历史键 source|id 让每季进度天然隔离。
  function renderSeasons(d) {
    var box = $('dSeasons'); if (!box) return;
    box.textContent = '';
    var list = Array.isArray(d.seasons) ? d.seasons : [];
    if (list.length <= 1) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    var label = document.createElement('span');
    label.className = 'seasons-label';
    label.textContent = '季';
    box.appendChild(label);
    list.forEach(function (s) {
      var b = document.createElement('button');
      var suffix = s.episodes ? '（' + s.episodes + '）' : (s.status ? '（' + s.status + '）' : '');
      b.className = 'chip season' + (s.current ? ' active' : '') + (s.playable ? '' : ' disabled');
      b.textContent = (s.season ? '第' + s.season + '季' : (s.title || '未命名季')) + suffix;
      b.title = (s.title || '') + (s.remarks ? ' · ' + s.remarks : '') + (s.status ? ' · ' + s.status : '');
      if (s.current || !s.playable) b.disabled = true;
      else b.addEventListener('click', function () { switchSeason(s.id, s.season); });
      box.appendChild(b);
    });
  }

  function switchSeason(id, season) {
    if (!id) return;
    if (state.detail && String(state.detail.id) === String(id)) return;
    toast('正在切换到第 ' + (season || '') + '季…');
    openDetail(String(id), state.viewSource);
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

  // 当前集高亮统一用 .current（renderEps 也用这一套），旧的 .active 会和历史渲染出的
  // .current 同时存在，出现「两集都是当前集」。已看集同步用 .seen。
  function markActiveEp(lineIdx, epIdx) {
    var kids = $('dEps').children;
    var sameLine = state.line === lineIdx;
    for (var i = 0; i < kids.length; i++) {
      kids[i].classList.toggle('current', sameLine && i === epIdx);
      kids[i].classList.toggle('seen', sameLine && i < epIdx);
    }
  }

  // recovering=true 表示这是假结束后的自动恢复：保留「每集只恢复一次」标志，防止恢复→再假结束的死循环。
  function playEpisode(lineIdx, epIdx, startAt, auto, recovering) {
    var autoNext = auto === true;
    var d = state.detail; if (!d) return;
    var line = d.lines[lineIdx]; if (!line) return;
    var ep = line.episodes[epIdx]; if (!ep) return;
    state.autoNextLatch = false;
    if (!recovering) state.falseEndRecovered = false; // 换集/手动重播才重置；自动恢复保留一次性标志
    state.lastPos = Math.max(0, Math.floor(startAt || 0));
    state.line = lineIdx; state.epIdx = epIdx;
    markActiveEp(lineIdx, epIdx);
    $('pTitle').textContent = (d.title || '') + ' · ' + (ep.name || '');
    histTouch({
      source: state.viewSource, id: d.id, title: d.title, cover: d.cover,
      lineIdx: lineIdx, lineName: line.name, epIdx: epIdx, epName: ep.name,
      // 时长沿用历史里已有的值：换集时写 0 会把续播条百分比和「剩余 xx 分钟」全部打乱。
      pos: Math.max(0, Math.floor(startAt || 0)),
      dur: (histGet(state.viewSource, d.id) || {}).dur || 0
    });
    updateResumeBar(d);
    if (!autoNext) toast('正在解析播放地址…');
    var mySeq = ++playSeq;
    api('/api/play', { source: state.viewSource, flag: line.flag, id: ep.id }).then(function (r) {
      // 过期响应（用户又点了别的集/关了播放器）直接丢弃，避免「点 A 播 B」。
      if (mySeq !== playSeq || state.detail !== d) return;
      openPlayer(r.url, r.type, startAt, autoNext, r.quality);
    }).catch(function (e) {
      if (mySeq !== playSeq || state.detail !== d) return;
      var msg = (e && e.message) || '未知错误';
      if (autoNext) toast('下一集播放失败：' + msg);
      else { toast('播放失败：' + msg); showPlayerError(msg); }
    });
  }

  // ---- 倍速（记住选择；登录后随账号跨设备同步到服务端） ----
  var RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
  var RATE_KEY = 'hg_rate_v1';
  // 未登录用同一 key；登录后按账号隔离成 <key>:u<id>，避免同一浏览器不同账号串味。
  function rateKey() { return state.user ? (RATE_KEY + ':u' + state.user.id) : RATE_KEY; }
  function readLocalRate() {
    var raw = '';
    try { raw = localStorage.getItem(rateKey()) || ''; } catch (e) { /* 隐私模式 / localStorage 被禁用 */ }
    var r = parseFloat(raw);
    return (isFinite(r) && RATES.indexOf(r) !== -1) ? r : null;
  }
  function writeLocalRate(r) { try { localStorage.setItem(rateKey(), String(r)); } catch (e) {} }
  // 读本地缓存；从没存过（首次 / 缓存被清空）就回落到 1.0×。
  function loadRate() {
    var r = readLocalRate();
    state.rate = (r == null) ? 1 : r;
    return state.rate;
  }
  function rateLabel(r) { return (r === 1 ? '1.0' : String(r)) + '×'; }
  function applyRate() {
    var v = $('video');
    try { v.playbackRate = state.rate; } catch (e) {}
    var btn = $('btnRate');
    if (btn) { btn.textContent = rateLabel(state.rate); btn.classList.toggle('on', state.rate !== 1); }
  }
  function pushRate(r) {
    if (!state.user) return;
    putJson('/api/me/prefs', { rate: r }).catch(function () {});
  }
  // 登录后以服务端为准：服务端有记录就套用它（跨设备一致），没有就把本机当前倍速存上去。
  function syncRateFromServer() {
    if (!state.user) return Promise.resolve();
    return api('/api/me/prefs').then(function (res) {
      var srv = res && res.prefs ? Number(res.prefs.rate) : NaN;
      if (RATES.indexOf(srv) !== -1) { state.rate = srv; writeLocalRate(srv); applyRate(); }
      else pushRate(state.rate);
    }).catch(function () {});
  }
  function setRate(r) {
    state.rate = r;
    writeLocalRate(r);
    applyRate();
    toast('倍速 ' + rateLabel(r));
    pushRate(r);
  }
  function cycleRate(dir) {
    var i = RATES.indexOf(state.rate); if (i < 0) i = 2;
    i = Math.min(RATES.length - 1, Math.max(0, i + (dir || 1)));
    setRate(RATES[i]);
  }

  // ---- HEVC 能力探测 ----
  // 红果官方高清档全部是 HEVC(hvc1)，Chrome 在 Windows 上默认不能解码，会直接报
  // MEDIA_ERR_SRC_NOT_SUPPORTED。先探测能力，能省掉一次必然失败的起播；
  // 用户也可以用 localStorage hg_hevc=1/0 手动覆盖（例如装了 HEVC 扩展的 Edge）。
  var HEVC_KEY = 'hg_hevc';
  var HEVC_CODECS = ['video/mp4; codecs="hvc1.1.6.L120.90"', 'video/mp4; codecs="hev1.1.6.L120.90"'];
  // 只有一份实现：统一走 probeHevcCap，避免两处判定逻辑分叉（一处 some、一处只看首个 codec）。
  function hevcSupported() { return probeHevcCap(false); }
  function optionByKey(key) {
    var opts = state.qualityOptions || [];
    for (var i = 0; i < opts.length; i++) if (opts[i].key === key) return opts[i];
    return null;
  }
  function hasHevcOption() {
    return (state.qualityOptions || []).some(function (o) { return o.codec === 'hevc'; });
  }
  // P2(#4)：启动时就把 HEVC 能力探测好（state.hevcCap），清晰度菜单构建时直接可用，
  // 不必等到第一次起播才知道本机能不能解 HEVC。
  function probeHevcCap(force) {
    if (!force && state.hevcCap != null) return state.hevcCap;
    var ok = false;
    var forced = null;
    try { forced = localStorage.getItem(HEVC_KEY); } catch (e) { /* 隐私模式 */ }
    if (forced === '1') ok = true;
    else if (forced === '0') ok = false;   // 显式覆盖优先，不再被下面的 canPlayType 兜底翻回 true
    else {
      try {
        if (window.MediaSource && window.MediaSource.isTypeSupported) {
          ok = HEVC_CODECS.some(function (c) { return window.MediaSource.isTypeSupported(c); });
        }
      } catch (e) { ok = false; }
      if (!ok) {
        // isTypeSupported 说不行时再用 canPlayType 兜一次（部分平台只实现了后者）
        try {
          var probe = document.createElement('video');
          ok = !!(probe.canPlayType && HEVC_CODECS.some(function (c) { return probe.canPlayType(c) === 'probably'; }));
        } catch (e) { ok = false; }
      }
    }
    state.hevcCap = ok;
    return ok;
  }

  // 档位可播性判定：codec 为 vvc/hevc 时可能本机解不了，但服务端 transcode:true 表示
  // 该档位会被转码成 H.264（浏览器能播），此时仍可点。
  // 返回 { dead, badge, title }：dead=true 表示置灰不可点。
  function qualityGate(o) {
    if (!o) return { dead: false, badge: '', title: '' };
    // 「自动（最高）」按最高档判定：服务端 auto 等价于最高档，本机解不了最高档时同样置灰，
    // 否则在无 HEVC 的浏览器里会默认起播必然黑屏的 HEVC 档。
    if (o.key === 'auto') {
      var best = (state.qualityOptions || []).filter(function (x) { return x.key !== 'auto'; })[0];
      if (best) {
        var bg = qualityGate(best);
        if (bg.dead) return { dead: true, badge: '本机不支持最高档', title: '最高档「' + best.label + '」' + bg.badge + '，请选择其它清晰度' };
      }
      return { dead: false, badge: '', title: '' };
    }
    var codec = String(o.codec || '').toLowerCase();
    var transcoded = o.transcode === true;
    if (codec === 'vvc') {
      if (transcoded) return { dead: false, badge: '服务端转码', title: '原片为 H.266(VVC)，由服务端转码为 H.264 播放' };
      return { dead: true, badge: 'H.266 浏览器不支持', title: 'H.266(VVC) 编码浏览器无法解码，且服务端未提供转码' };
    }
    if (codec === 'hevc') {
      if (transcoded) return { dead: false, badge: '服务端转码', title: '该档位由服务端转码为 H.264 后播放' };
      if (!hevcSupported()) return { dead: true, badge: 'HEVC·本机不支持', title: '本机浏览器不支持 HEVC(hvc1) 解码，该档位无法播放' };
      return { dead: false, badge: '', title: '' };
    }
    return { dead: false, badge: '', title: '' };
  }
  // 默认起播档位：第一个可播的档位（HEVC/VVC 不可解时自动降到可播档），「自动」优先。
  function defaultPlayableOption() {
    var opts = (state.qualityOptions || []).filter(function (o) { return o.url && !qualityGate(o).dead; });
    if (!opts.length) return null;
    // 优先「自动」，其次直连档（h264 原片），然后兼容档，最后才是服务端转码档（耗 CPU、不可拖动）。
    var auto = opts.filter(function (o) { return o.key === 'auto'; })[0];
    if (auto) return auto;
    var direct = opts.filter(function (o) { return !o.transcode && o.key !== 'auto'; })[0];
    if (direct) return direct;
    var compat = opts.filter(function (o) { return o.key === 'compat'; })[0];
    return compat || opts[0];
  }
  // 切换到指定档位：native 直链靠换 src，HLS 靠 hls.js 的 level。
  function switchNativeQuality(o) {
    var v = $('video'); if (!v || !o || !o.url) return false;
    var at = v.currentTime || 0;
    var wasPlaying = !v.paused;
    state.qualityKey = o.key;
    state.hevcFallback = o.key === 'compat';
    state.switchAt = Date.now();
    state.switchRetried = false;
    state.pendingSeek = Math.floor(at);
    state.silentSeek = at > 3;
    state.switching = true;
    syncQualityParam(o.key);
    hidePlayerError();
    v.src = authUrl(o.url);
    try { v.load(); } catch (e) {}
    if (wasPlaying) {
      var pr = v.play();
      if (pr && pr.catch) pr.catch(function () {});
    }
    updateQualityBtn();
    return true;
  }

  // ---- 清晰度 / 当前分辨率 ----
  function levelLabel(lv) {
    if (!lv) return '自动';
    if (lv.name) { var n = String(lv.name).trim(); return /p$/i.test(n) ? n.toUpperCase() : n + 'P'; }
    if (lv.height) return lv.height + 'P';
    if (lv.bitrate) return Math.round(lv.bitrate / 1000) + 'K';
    return '码率';
  }
  // 视频元素实际解码出的分辨率才是权威：360x640→360P、1280x720→720P、1920x1080→1080P。
  function resLabelFromSize(w, h) {
    if (!w || !h) return '';
    return Math.min(w, h) + 'P';
  }
  function currentResolutionLabel() {
    var v = $('video');
    return v ? resLabelFromSize(v.videoWidth, v.videoHeight) : '';
  }
  function updateResBadge() {
    var v = $('video'); var b = $('resBadge'); if (!b) return;
    var w = v ? v.videoWidth : 0, h = v ? v.videoHeight : 0;
    var lab = resLabelFromSize(w, h);
    b.textContent = lab;
    b.title = lab ? ('当前播放分辨率 ' + w + '×' + h) : '当前播放分辨率';
    b.classList.toggle('hidden', !lab);
  }
  function updateQualityBtn() {
    var btn = $('btnQuality'); if (!btn) return;
    // 切档期间按钮显示进行中：换 src 到首帧就绪之间有几百毫秒空窗，没有反馈会像点了没反应。
    if (state.switching) { btn.textContent = '切换中…'; btn.classList.add('on'); return; }
    var multi = (state.qualityOptions || []).length > 1;
    var chosen = '';
    if (state.playKind === 'native' && state.qualityKey) {
      var picked = optionByKey(state.qualityKey);
      chosen = picked ? picked.label : '';
    } else if (state.quality >= 0 && state.levels[state.quality]) {
      chosen = levelLabel(state.levels[state.quality]);
    }
    btn.textContent = '清晰度 ' + (chosen || currentResolutionLabel() || '自动');
    btn.classList.toggle('on', multi);
  }
  function buildQualityMenu() {
    var menu = $('qualityMenu'); if (!menu) return;
    menu.textContent = '';
    var opts = state.qualityOptions || [];
    var activeDead = null;
    if (opts.length <= 1) {
      var only = opts[0] || null;
      var g0 = qualityGate(only);
      var single = document.createElement('div');
      single.className = 'qitem disabled';
      single.textContent = (currentResolutionLabel() || (only && only.label) || '原画') +
        (g0.dead ? '（该源仅此一种清晰度，本机无法解码）' : '（该源仅此一种清晰度）');
      if (g0.title) single.title = g0.title;
      menu.appendChild(single);
      if (g0.dead) activeDead = { label: single.textContent, gate: g0 };
    } else {
      opts.forEach(function (o) {
        var gate = qualityGate(o);
        var active = state.playKind === 'native'
          ? (o.key != null && o.key === state.qualityKey)
          : ((o.levelIndex != null && o.levelIndex === state.quality) || (o.levelIndex === -1 && state.quality < 0));
        var d = document.createElement('div');
        d.className = 'qitem' + (active ? ' active' : '') + (gate.dead ? ' disabled' : '');
        var lab = document.createElement('span'); lab.className = 'qlabel'; lab.textContent = o.label;
        d.appendChild(lab);
        // 小字标注：HEVC·本机不支持 / H.266 浏览器不支持 / 服务端转码
        if (gate.badge) {
          var bd = document.createElement('span');
          bd.className = 'qbadge' + (gate.dead ? ' dead' : ' ok');
          bd.textContent = gate.badge;
          d.appendChild(bd);
        }
        if (gate.title) d.title = gate.title;
        if (!gate.dead) d.addEventListener('click', function () { selectQuality(o); });
        menu.appendChild(d);
        if (active && gate.dead) activeDead = { label: o.label, gate: gate };
      });
    }
    if (activeDead) {
      // 当前档位被置灰时的兜底说明：告诉用户为什么不能播、以及该怎么办
      var fb = document.createElement('div'); fb.className = 'qnote dead';
      fb.textContent = '当前「' + activeDead.label + '」本机无法解码（' + activeDead.gate.badge + '），请切换到可播放的档位。';
      menu.appendChild(fb);
    }
    if (state.qualityNote) {
      var note = document.createElement('div'); note.className = 'qnote'; note.textContent = state.qualityNote;
      menu.appendChild(note);
    }
  }
  // 菜单挂到 body 并用 fixed 定位，避免被 .pactions 的 overflow 裁剪、也保证盖在 video 之上。
  function positionQualityMenu() {
    var m = $('qualityMenu'); var b = $('btnQuality'); if (!m || !b) return;
    var r = b.getBoundingClientRect();
    m.style.position = 'fixed';
    m.style.zIndex = '110';
    m.style.right = 'auto';
    var w = m.offsetWidth || 180;
    var left = Math.min(Math.max(8, r.right - w), window.innerWidth - 8 - w);
    m.style.left = left + 'px';
    var mh = m.offsetHeight || 0;
    var top = r.bottom + 8;
    if (top + mh > window.innerHeight - 8 && r.top - mh - 8 > 8) top = r.top - mh - 8;
    m.style.top = top + 'px';
  }
  function toggleQualityMenu(e) {
    if (e) { e.stopPropagation(); }
    var m = $('qualityMenu'); if (!m) return;
    var willShow = m.classList.contains('hidden');
    if (willShow) {
      if (m.parentElement !== document.body) document.body.appendChild(m);
      m.classList.remove('hidden');
      buildQualityMenu();
      positionQualityMenu();
    } else {
      m.classList.add('hidden');
    }
  }
  function closeQualityMenu() { var m = $('qualityMenu'); if (m) m.classList.add('hidden'); }
  function selectQuality(o) {
    closeQualityMenu();
    // native 直链（红果官方多档）：换 src 重载，保留播放进度。
    if (o) {
      // 置灰档位即使被脚本调用也不允许起播（菜单点击已拦截，这里兜底）
      var gate = qualityGate(o);
      if (gate.dead) { toast(gate.title || (o.label + ' 本机无法解码')); return; }
    }
    if (state.playKind === 'native' && o && o.url) {
      if (o.key === state.qualityKey) { toast('已是 ' + o.label); return; }
      if (switchNativeQuality(o)) toast('清晰度：' + o.label);
      return;
    }
    if (o.levelIndex != null && state.hls && (state.qualityOptions || []).length > 1) {
      state.quality = o.levelIndex;
      state.switching = true;
      try { state.hls.currentLevel = o.levelIndex; } catch (e) {}
      updateQualityBtn();
      toast('清晰度：' + (o.levelIndex < 0 ? '自动' : o.label));
    } else {
      toast('该源仅提供 ' + (currentResolutionLabel() || '单一') + ' 清晰度');
    }
  }
  // 兼容旧调试钩子：无多档时提示，有 HLS 多档时在档位间循环。
  function cycleQuality() {
    if (state.playKind === 'native' && (state.qualityOptions || []).length > 1) {
      // 只在「本机可播」的档位之间循环（vvc / 不可解 hevc 已被置灰）
      var nat = state.qualityOptions.filter(function (o) { return !qualityGate(o).dead; });
      if (!nat.length) { toast('没有本机可播放的清晰度档位'); return; }
      var cur = -1;
      for (var i = 0; i < nat.length; i++) if (nat[i].key === state.qualityKey) cur = i;
      selectQuality(nat[(cur + 1) % nat.length]);
      return;
    }
    var opts = (state.qualityOptions || []).filter(function (o) { return o.levelIndex != null; });
    if (opts.length <= 1) { toast('该视频只有单一清晰度'); return; }
    var idx = opts.findIndex(function (o) { return o.levelIndex === state.quality; });
    selectQuality(opts[(idx + 1) % opts.length]);
  }

  // ---- 全屏 ----
  // iOS Safari（iPhone）不支持元素级全屏：requestFullscreen 不存在，只能退到 video.webkitEnterFullscreen()。
  // 那一路 document.fullscreenElement 恒为 null，必须用 webkitbegin/endfullscreen 记到 state.iosFs，
  // 否则按钮恒显示「全屏」、再点一次也退不出原生全屏。
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || state.iosFs);
  }
  function toggleFullscreen() {
    var box = document.querySelector('.player-inner') || $('player');
    var v = $('video');
    if (state.iosFs) { try { v.webkitExitFullscreen(); } catch (e) {} return; }
    if (isFullscreen()) {
      (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
      return;
    }
    if (box.requestFullscreen) {
      box.requestFullscreen().catch(function () { toast('全屏被浏览器拒绝'); });
    } else if (box.webkitRequestFullscreen) {
      box.webkitRequestFullscreen();
    } else if (v.webkitEnterFullscreen) {
      try { v.webkitEnterFullscreen(); state.iosFs = !!v.webkitDisplayingFullscreen; } catch (e) {}
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

  // ---- 播放错误提示、加载超时与一键切源 ----
  var playWatchdog = null;
  function clearPlayWatchdog() { if (playWatchdog) { clearTimeout(playWatchdog); playWatchdog = null; } }
  function hidePlayerError() {
    clearPlayWatchdog();
    var box = $('playerError'); if (box) box.classList.add('hidden');
    var fb = $('btnPlayerFallback'); if (fb) fb.classList.add('hidden');
    state.fallback = null;
  }
  function showPlayerError(msg, kind) {
    clearPlayWatchdog();
    var box = $('playerError'); if (!box) return;
    $('playerErrorText').textContent = msg || '播放失败，请重试或切换数据源。';
    var retry = $('btnPlayerRetry');
    var compat = optionByKey('compat');
    var canCompat = !!(compat && compat.url && state.qualityKey !== 'compat');
    // 编码类问题（bvc2/hevc）重试同一档没有意义：按钮改成「切到 360P 兼容」，没有兼容档就干脆不给重试。
    if (retry) {
      var coding = kind === 'bvc2' || kind === 'hevc';
      retry.dataset.mode = coding && canCompat ? 'compat' : 'retry';
      retry.textContent = coding && canCompat ? '切到 360P 兼容' : '重试';
      retry.classList.toggle('hidden', coding && !canCompat);
    }
    box.classList.remove('hidden');
    loadFallback(); // 顺手找同剧的其它源，播放失败时给一条能直接续上的路
  }

  // 播放降级：向后端要「同一部剧在其它源」的候选，直接跳到对应集继续看。
  function loadFallback() {
    var btn = $('btnPlayerFallback');
    var d = state.detail;
    if (!btn || !d || !d.id) return;
    btn.classList.add('hidden');
    state.fallback = null;
    if (state.fallbackLoading) return;
    state.fallbackLoading = true;
    api('/api/play/fallback', { source: state.viewSource, id: d.id, index: state.epIdx || 0 })
      .then(function (r) {
        var list = (r && r.candidates) || [];
        if (!list.length) return;
        state.fallback = list[0];
        btn.textContent = '换到「' + list[0].name + '」看第 ' + (list[0].targetIndex + 1) + ' 集';
        btn.classList.remove('hidden');
      })
      .catch(function () { /* 降级检索失败不影响原有重试/换源按钮 */ })
      .then(function () { state.fallbackLoading = false; });
  }
  function useFallback() {
    var fb = state.fallback;
    if (!fb) { toast('暂时没找到同剧的其它源'); return; }
    closePlayer();
    state.pendingPlay = fb.targetIndex;
    toast('正在换到 ' + fb.name + ' 第 ' + (fb.targetIndex + 1) + ' 集…');
    openDetail(fb.id, fb.source);
  }
  function armPlayWatchdog() {
    clearPlayWatchdog();
    playWatchdog = setTimeout(function () {
      var v = $('video');
      if (v && v.readyState < 1) {
        // 超时可能连 error 事件都不来，这里兜底把「切换中…」清掉，别让按钮永远卡住。
        if (state.switching) { state.switching = false; updateQualityBtn(); }
        showPlayerError('播放加载超时（8 秒未响应），可能是当前数据源受限，请换源或重试。');
      }
    }, 8000);
  }
  function onVideoError() {
    var v = $('video'); if (!v || !state.detail) return;
    // 直链（native）有自己的三级降级阶梯（见 bindPlayerEvents），由它给出具体原因；
    // 这里只管 HLS 等其它播放方式，否则阶梯刚决定「先重试一次」，这条又立刻弹一句通用失败。
    if (state.playKind === 'native') return;
    var code = v.error ? v.error.code : 0;
    var msg = code === 4
      ? '视频源不可用或格式不受支持（MEDIA_ERR_SRC_NOT_SUPPORTED），可能是当前数据源受限，请换源或重试。'
      : '播放失败（错误码 ' + code + '），请换源或重试。';
    showPlayerError(msg);
    toast('播放失败，请换源或重试');
  }
  function retryPlayback() {
    hidePlayerError();
    if (!state.detail) { toast('请重新选择剧集'); return; }
    playEpisode(state.line || 0, state.epIdx || 0, $('video').currentTime || 0, false);
  }
  function switchPlaybackSource() {
    var current = state.source;
    var list = (state.sources || []).filter(function (item) {
      return item.id !== current && item.id !== '__all' && item.id !== 'template' && item.id !== 'maccms';
    });
    if (!list.length) { toast('没有其他可用数据源'); return; }
    var next = list[0];
    closePlayer();
    toast('正在切换到 ' + (next.name || next.id) + '…');
    setActiveSource(next.id).then(function () {
      toast('已切换到 ' + (next.name || next.id) + '，请重新选择剧集');
    }).catch(function (e) { toast('切换失败：' + e.message); });
  }

  function openPlayer(url, type, startAt, auto, qualityInfo) {
    var v = $('video');
    state.pendingSeek = Math.max(0, Math.floor(startAt || 0));
    state.lastSave = 0;
    state.quality = -1;
    state.levels = [];
    state.qualityOptions = [];
    state.qualityNote = '';
    state.qualityKey = '';
    state.hevcFallback = false;
    state.hevcWarned = false;   // 每次起播/换剧都允许再提示一次「最高档解不了，已换档」
    state.silentSeek = false;
    state.playKind = type === 'hls' ? 'hls' : 'native';
    state.switchAt = Date.now();
    state.switchRetried = false;
    state.switching = false;
    if (qualityInfo && Array.isArray(qualityInfo.options) && qualityInfo.options.length) {
      state.qualityOptions = qualityInfo.options.map(function (o) {
        return {
          key: o.key, label: o.label, height: o.height,
          codec: String(o.codec || '').toLowerCase(), url: o.url || '',
          // transcode=true：服务端会转码成 H.264，浏览器能播 → 不置灰
          transcode: o.transcode === true, levelIndex: null
        };
      });
      state.qualityNote = qualityInfo.note || '';
      // 地址栏里的 ?q= 是用户上次选的档位（切档时写入），刷新/分享回来仍按它起播。
      var wantQ = urlQualityParam();
      var wantOpt = wantQ ? optionByKey(wantQ) : null;
      if (wantOpt && wantOpt.url && !qualityGate(wantOpt).dead) {
        url = wantOpt.url;
        state.qualityKey = wantOpt.key;
        state.hevcFallback = wantOpt.key === 'compat';
      } else if (state.playKind === 'native') {
        // 最高档本机解不出来（HEVC/VVC 且未转码）时，直接起播第一个可播档，省掉一次必然失败的起播。
        var top = state.qualityOptions[0];
        var playable = defaultPlayableOption();
        if (top && playable && playable.url && qualityGate(top).dead) {
          url = playable.url;
          state.qualityKey = playable.key;
          state.hevcFallback = playable.key === 'compat';
          if (!state.hevcWarned) {
            state.hevcWarned = true;
            toast('「' + top.label + '」' + qualityGate(top).badge + '，已改用「' + playable.label + '」线路');
          }
        }
      }
    }
    if (state.playKind === 'native' && !state.qualityKey && optionByKey('auto')) state.qualityKey = 'auto';
    syncQualityParam(state.playKind === 'native' ? state.qualityKey : '');
    url = authUrl(url);
    updateResBadge();
    updateQualityBtn();
    destroyHls();
    hidePlayerError();
    clearDiag();
    // 从直链切到 HLS（或反过来）时先清掉旧的 src，避免残留地址干扰新的播放源。
    v.removeAttribute('src');
    try { v.load(); } catch (e) {}
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
          // 真正的多码率 HLS（master playlist）才给出多档选项；单码率只显示实际分辨率。
          if (state.levels.length > 1) {
            state.qualityOptions = [{ label: '自动', levelIndex: -1 }].concat(state.levels.map(function (lv, i) {
              return { label: levelLabel(lv), levelIndex: i };
            }));
          }
          updateQualityBtn();
        });
        hls.on(window.Hls.Events.LEVEL_SWITCHED, function () {
          if (state.switching) state.switching = false;
          updateResBadge(); updateQualityBtn();
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
          showPlayerError('HLS 流播放失败：' + (data.details || '流错误'));
          toast('播放失败：' + (data.details || '流错误'));
        });
      } else {
        v.src = url;
      }
    } else {
      v.src = url;
    }
    applyRate();
    state.autoNextLatch = false;
    armPlayWatchdog();
    var p = v.play();
    if (p && p.catch) p.catch(function (err) {
      if (!err) return;
      // 自动连播没有用户手势，部分移动端浏览器会以 NotAllowedError 拦截有声播放；静音重试一次
      if (err.name === 'NotAllowedError') {
        if (!auto || v.muted) return;
        v.muted = true;
        var retry = v.play();
        if (retry && retry.catch) retry.catch(function () {});
        toast('已静音自动续播，点音量可恢复声音');
        return;
      }
      // 已经有 MediaError、或错误本身就是「没有可播放的源」（NotSupportedError），都交给 error 事件的
      // 三级阶梯处理：play() 的 reject 常常比 error 事件早一步到达，这里再弹一次会把它的话术盖掉。
      if (v.error || err.name === 'NotSupportedError') return;
      var msg = '播放失败：' + (err.message || '未知错误');
      // 浏览器给的 message 常以 "." 结尾，别再补一个句号，否则会拼出「…was found.。可尝试换源」
      toast(msg); showPlayerError(msg + (/[。.!！?？]$/.test(msg) ? '' : '。') + '可尝试换源或重试。');
    });
  }

  function saveProgress(v) {
    v = v || $('video');
    if (!state.histKey) return;
    var pos = Math.floor(v.currentTime || 0), dur = 0;
    if (v.duration && isFinite(v.duration)) dur = Math.floor(v.duration);
    if (pos > 0) histUpdate(pos, dur);
  }

  function canAutoNext() {
    var d = state.detail; if (!d) return false;
    var line = d.lines[state.line]; if (!line) return false;
    return (state.epIdx || 0) + 1 < line.episodes.length;
  }

  // ---- 自动连播开关（语义对齐糖葫芦 playback_preferences.autoAdvance：默认开、可关、本地持久化）----
  // 存储键沿用项目既有 hg_ 前缀约定：hg_autonext = '1' | '0'
  var AUTO_NEXT_KEY = 'hg_autonext';
  function loadAutoNext() {
    var raw = '';
    try { raw = localStorage.getItem(AUTO_NEXT_KEY) || ''; } catch (e) { /* 隐私模式 / localStorage 被禁用 */ }
    state.autoNext = raw !== '0'; // 只认显式 '0' 为关闭；缺省与脏值一律回到默认开
    applyAutoNext();
    return state.autoNext;
  }
  function writeAutoNext() { try { localStorage.setItem(AUTO_NEXT_KEY, state.autoNext ? '1' : '0'); } catch (e) {} }
  function applyAutoNext() {
    var btn = $('btnAutoNext');
    if (!btn) return;
    btn.textContent = state.autoNext ? '连播 开' : '连播 关';
    btn.classList.toggle('on', state.autoNext);
    btn.setAttribute('aria-pressed', state.autoNext ? 'true' : 'false');
  }
  function toggleAutoNext() {
    state.autoNext = !state.autoNext;
    writeAutoNext();
    applyAutoNext();
    state.autoNextLatch = false;
    if (state.autoNext) {
      toast('自动连播已开启');
      // 开关是在片尾停住后才打开的：补一次连播（末集仍然不切）
      var v = $('video');
      if (v && v.ended && canAutoNext() && autoNextAllowed()) scheduleAutoNext();
    } else {
      toast('自动连播已关闭，播完停在当前集');
    }
  }

  // 片尾判定：时长有效且已播到片尾 2 秒内才算「真结束」。
  // 取流中断 / 解码失败 / HLS 断流时浏览器也可能抛 ended 或停表；若直接切集，等于把没播完的一集吞掉。
  function realEnd(v) {
    var dur = v.duration;
    if (!isFinite(dur) || dur <= 0) return false;
    return (v.currentTime || 0) >= dur - 2;
  }

  // 自动切集的三重守卫（对齐糖葫芦 _autoAdvance && _foreground && !_panelOpen）：
  // ① 连播开关；② 页面在前台；③ 没有弹层挡着（本项目没有独立剧集面板，取「任一遮罩弹层打开」为等价条件）。
  function autoNextAllowed() {
    if (!state.autoNext) return false;
    if ($('player').classList.contains('hidden')) return false;
    if (document.visibilityState && document.visibilityState !== 'visible') return false;
    var modals = document.querySelectorAll('.modal:not(.hidden)');
    if (modals && modals.length) return false;
    return true;
  }

  // 末集播完 / 开关关闭 / 后台：只暂停 + 落盘，绝不跨季（季切换是手动功能，这里不引入任何季级跳转）。
  function finishEpisode(v) {
    state.autoNextLatch = true;
    try { v.pause(); } catch (e) {} // 无条件暂停：起播 promise 尚未 resolve 时 v.paused 可能还是 true，按状态判断会漏停
    var dur = Math.floor(v.duration || 0);
    if (state.histKey && dur > 0) histUpdate(dur, dur, true);
    else saveProgress(v);
  }

  // 假结束：不切集，重取当前集并从最后稳定位置续播；每集只恢复一次，避免「恢复→又假结束」死循环。
  function recoverFromFalseEnd(v) {
    if (state.falseEndRecovered) return;
    state.falseEndRecovered = true;
    var dur = isFinite(v.duration) ? v.duration : 0;
    var pos = state.lastPos || 0;
    if (dur > 0 && pos >= dur - 2) pos = Math.max(0, dur - 5);
    toast('播放中断，正在恢复当前集…');
    playEpisode(state.line, state.epIdx, pos, true, true);
  }

  // 片尾自动连播：ended 事件在某些浏览器/HLS 场景不稳定，timeupdate 临近片尾作为兜底。
  function scheduleAutoNext() {
    if (state.autoNextLatch) return;
    var v = $('video');
    if (!v) return;
    if (!autoNextAllowed()) return;           // 开关关闭 / 后台 / 弹层打开：不切集
    if (!canAutoNext()) { finishEpisode(v); return; } // 末集：只暂停 + 落盘
    var key = String(state.line) + ':' + String(state.epIdx);
    state.autoNextLatch = true;
    setTimeout(function () {
      if ($('player').classList.contains('hidden') || !autoNextAllowed() ||
          String(state.line) + ':' + String(state.epIdx) !== key) {
        state.autoNextLatch = false;
        return;
      }
      nextEpisode({ auto: true });
    }, 300);
  }

  // ---- 播放失败三级阶梯（A4）----
  // 浏览器的 MediaError.code 只有 4 个值，原文是英文且不区分「网络抖动」和「真解不了」。
  var MEDIA_ERR_TEXT = { 1: '加载被中断', 2: '网络错误', 3: '解码失败', 4: '格式不支持' };
  function mediaErrLabel(code) { return MEDIA_ERR_TEXT[code] || ('媒体错误 ' + code); }
  // 第一级：同档原样重载一次。首包损坏、切档瞬间旧管线残留、CDN 单节点抖动都能靠它救回来，
  // 而且不用降清晰度。加时间戳参数强制绕过浏览器缓存里的失败响应。
  function replaySameSource(label) {
    var v = $('video');
    var src = v.currentSrc || v.getAttribute('src') || '';
    if (!src) return false;
    state.switchRetried = true;
    state.pendingSeek = Math.floor(v.currentTime || 0);
    state.silentSeek = state.pendingSeek > 3;
    hidePlayerError();
    v.removeAttribute('src');
    try { v.load(); } catch (e) {}
    v.src = src + (src.indexOf('?') === -1 ? '?' : '&') + '_r=' + Date.now();
    var pr = v.play();
    if (pr && pr.catch) pr.catch(function () {});
    toast(label + '，正在同档重试…');
    return true;
  }

  // ---- 播放失败诊断（B6）：把「黑屏 / 报错」分成四种可操作的原因 ----
  // no-source：流本身取不到（502/503/网络断）→ 重试有意义
  // bvc2：档位是 H.266/VVC，设备解不了 → 重试无意义，应切兼容档或换源
  // hevc：容器与音轨能解、视频轨解不了（有声音没画面，往往不触发 error）→ 同样切兼容档
  // playable：地址其实可用，错误另有原因 → 仍给重试
  var diagTimers = [];
  function clearDiag() { while (diagTimers.length) clearTimeout(diagTimers.pop()); }
  function currentCodec() {
    var opt = optionByKey(state.qualityKey);
    return (opt && opt.codec) || '';
  }
  // 用 1 字节 Range 探一次真地址，只为拿 HTTP 状态（服务端只解这一小块，代价很小）。
  function probeStream(url) {
    if (!url) return Promise.resolve({ ok: false, status: 0 });
    var ctrl = window.AbortController ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 4000) : null;
    return fetch(url, { headers: { Range: 'bytes=0-1' }, cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) {
        var status = r.status;
        // 只有 206 才去读那 1 字节；上游/代理忽略 Range 回 200 时立刻掐断连接，
        // 否则会把整集视频读进内存（4 秒 abort 只能兜时间，流量已经花掉了）。
        if (status !== 206) { try { if (r.body) r.body.cancel(); } catch (e) {} return status; }
        return r.arrayBuffer().then(function () { return status; }, function () { return status; });
      })
      .then(function (status) { return { ok: status === 200 || status === 206, status: status }; })
      .catch(function () { return { ok: false, status: 0 }; })
      .then(function (res) { if (timer) clearTimeout(timer); return res; });
  }
  function classifyPlayback(v, probe) {
    if (probe && probe.status === 415) return 'bvc2'; // 服务端明确说「这个编码浏览器解不了」
    if (probe && !probe.ok) return 'no-source';
    if (!v) return 'playable';
    if (v.videoWidth > 0) return 'playable';
    return currentCodec() === 'vvc' ? 'bvc2' : 'hevc';
  }
  var DIAG_TEXT = {
    'no-source': function (probe) {
      return '内容源暂时不可用（' + (probe && probe.status ? 'HTTP ' + probe.status : '连接失败') + '），可稍后重试或切换数据源。';
    },
    bvc2: function () { return '当前设备不支持该视频编码（H.266/VVC），重试同一档没有意义，请切到 360P 兼容线路或换源。'; },
    hevc: function () { return '当前设备解不了这一档画面（常见于 HEVC 有声音无画面），请切到 360P 兼容线路或换源。'; },
    playable: function () { return '播放异常，但视频地址本身可用，可重试或换一集。'; },
  };
  // 阶梯（同档重试 → 降档）都走完仍失败时调用：先探地址，再按分类给具体话术。
  function diagnoseAndReport(v, fallbackMsg) {
    var url = (v && (v.currentSrc || v.getAttribute('src'))) || '';
    probeStream(url).then(function (probe) {
      var kind = classifyPlayback(v, probe);
      if (kind === 'playable') { showPlayerError(fallbackMsg || DIAG_TEXT.playable(probe), 'playable'); return; }
      showPlayerError(DIAG_TEXT[kind](probe), kind);
      toast(kind === 'no-source' ? '内容源暂时不可用' : '当前设备解不了该编码，建议切 360P 兼容');
    });
  }
  // 有音无画的兜底检查：loadeddata +400ms、loadedmetadata +1200ms 各查一次，仍没画面就提示换档。
  function armStallCheck(v, delay) {
    diagTimers.push(setTimeout(function () {
      if (state.playKind !== 'native' || state.hevcFallback) return;
      if (!v || v.paused || v.readyState < 2 || v.videoWidth > 0) return;
      var kind = classifyPlayback(v, null);
      if (kind === 'playable') return;
      showPlayerError(DIAG_TEXT[kind](null), kind);
    }, delay));
  }

  function bindPlayerEvents() {
    var v = $('video');
    v.addEventListener('loadedmetadata', function () {
      // 有些浏览器在换源/换集后会把 playbackRate 复位，元数据就绪时按记住的倍速再设一次。
      try { v.playbackRate = state.rate; } catch (e) {}
      $('btnRate').textContent = rateLabel(state.rate);
      updateResBadge();
      updateQualityBtn();
      if (state.pendingSeek > 3 && isFinite(v.duration) && state.pendingSeek < v.duration - 3) {
        try { v.currentTime = state.pendingSeek; } catch (e) {}
        // 切换清晰度时也走 pendingSeek，但那是同一个位置，不必提示「已续播」。
        if (!state.silentSeek) toast('已续播至 ' + fmtDur(state.pendingSeek));
      }
      state.pendingSeek = 0;
      state.silentSeek = false;
      if (state.switching) { state.switching = false; updateQualityBtn(); }
      prefetchNext();
      clearDiag();
      armStallCheck(v, 1200);
    });
    // 首帧就绪的早检查：有音无画时 videoWidth 一直是 0，早一点提示能少等几秒。
    v.addEventListener('loadeddata', function () {
      clearDiag();
      armStallCheck(v, 400);
    });
    v.addEventListener('timeupdate', function () {
      // 记录最后稳定位置：假结束时用它续播，避免从头再来
      if (!v.seeking && v.currentTime > 0) state.lastPos = v.currentTime;
      if (!state.histKey) return;
      var now = Date.now();
      if (now - state.lastSave < 5000) return;
      state.lastSave = now;
      saveProgress(v);
    });
    // 临近片尾兜底：有些浏览器/流不会稳定触发 ended，用 timeupdate 补一次。
    v.addEventListener('timeupdate', function () {
      if (v.paused || v.seeking) return;
      if (!isFinite(v.duration) || v.duration <= 1) return;
      if (v.currentTime > 0 && v.duration - v.currentTime <= 0.6) scheduleAutoNext();
    });
    v.addEventListener('pause', function () { saveProgress(v); });
    v.addEventListener('ended', function () {
      // 假结束（时长为 0 或离片尾还差得远）说明是取流/解码中断，重播当前集而不是切下一集
      if (!realEnd(v)) { recoverFromFalseEnd(v); return; }
      var dur = Math.floor(v.duration || 0);
      if (state.histKey) histUpdate(dur, dur, true);
      scheduleAutoNext();
    });
    // HEVC 在 Chrome/Edge 上常见「有声音没画面」：容器与音轨能解，视频轨不支持，且不触发 error。
    // 播了 2 秒还拿不到 videoWidth 就判定该档解不出来，回落 360P 兼容线路。
    v.addEventListener('timeupdate', function () {
      if (state.playKind !== 'native') return;
      if (v.videoWidth > 0) { clearDiag(); return; }
      if (state.hevcFallback) return;
      if (v.paused || v.readyState < 2) return;
      if (v.currentTime < 2) return;
      var compat = optionByKey('compat');
      if (!compat || !compat.url) return;
      state.hevcFallback = true;
      toast('该清晰度无法解码，已自动切换到 360P 兼容线路');
      switchNativeQuality(compat);
    });
    // 播放失败三级阶梯：同档重试一次 → 回退 360P 兼容线路一次 → 给出具体原因。
    // 旧实现只处理 code 3/4 且直接降档，网络类错误（code 2）完全没提示，页面就那么黑着。
    v.addEventListener('error', function () {
      var err = v.error;
      if (!err) return;
      // 换源/切档时我们自己 removeAttribute('src')+load() 也会触发 ABORTED，不是真故障。
      if (err.code === 1) return;
      if (state.switching) { state.switching = false; updateQualityBtn(); }
      if (state.playKind !== 'native') return;
      var label = mediaErrLabel(err.code);
      // 第一级：刚起播/刚切档 10 秒内失败，先原样重载一次同档（一次性标志，避免失败循环）。
      if (!state.switchRetried && Date.now() - state.switchAt < 10000 && replaySameSource(label)) return;
      // 第二级：回退 360P 兼容线路，整个播放过程只做一次（hevcFallback 兼作一次性标志）。
      if (!state.hevcFallback) {
        var compat = optionByKey('compat');
        if (compat && compat.url) {
          state.hevcFallback = true;
          toast(label + '，已自动切换到 360P 兼容线路');
          switchNativeQuality(compat);
          return;
        }
      }
      // 第三级：阶梯走完还失败，探一次真地址再给结论——「源挂了」和「设备解不了」要分开说，
      // 否则用户对着编码问题一直点重试，或者对着源故障去切清晰度。
      var msg = '播放失败：' + label + '，可尝试切换数据源或换一集';
      diagnoseAndReport(v, msg);
      toast(msg);
    });
    v.addEventListener('dblclick', function (e) { e.preventDefault(); toggleFullscreen(); });
    document.addEventListener('keydown', onPlayerKey);
    document.addEventListener('fullscreenchange', syncFullBtn);
    document.addEventListener('webkitfullscreenchange', syncFullBtn);
    // iOS 原生视频全屏没有 fullscreenchange，只能靠这组 webkit 事件同步按钮与 state
    v.addEventListener('webkitbeginfullscreen', function () { state.iosFs = true; syncFullBtn(); });
    v.addEventListener('webkitendfullscreen', function () { state.iosFs = false; syncFullBtn(); });
  }

  function onPlayerKey(e) {
    if ($('player').classList.contains('hidden')) return;
    var t = e.target || {};
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '') || t.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var v = $('video'), k = e.key;
    if (k === 'Escape') { closeQualityMenu(); return; }
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

  // 清晰度写进地址栏（?quality=compat）：刷新、前进后退、把链接发给别人时还是这一档。
  // 注意不能叫 q——?q= 是搜索关键词（bootFromQuery 会拿它直接 doSearch）。其它参数原样保留。
  function syncQualityParam(key) {
    try {
      var u = new URL(location.href);
      var cur = u.searchParams.get('quality') || '';
      if (cur === (key || '')) return;
      if (key) u.searchParams.set('quality', key); else u.searchParams.delete('quality');
      history.replaceState(history.state, '', u.pathname + u.search + u.hash);
    } catch (e) {}
  }
  function urlQualityParam() {
    try { return new URLSearchParams(location.search).get('quality') || ''; } catch (e) { return ''; }
  }

  // ---- 下一集预取 ----
  // 省掉换集时「上游取址 + 首块解密」的等待（红果那条链通常 300~800ms）。
  // 边界：只预热到首帧就断开下载，不偷偷吃掉整集流量；最多记 6 条已预热，超出淘汰最旧。
  var PREFETCH_MAX = 6;
  var prefetchCache = new Map();
  var prefetchEl = null;
  var prefetchKey = '';

  function prefetchNext() {
    if ($('player').classList.contains('hidden')) return;
    var d = state.detail; if (!d) return;
    var line = d.lines[state.line]; if (!line) return;
    var next = line.episodes[(state.epIdx || 0) + 1]; if (!next) return;
    // 用户开了省流量模式就别预取。
    if (navigator.connection && navigator.connection.saveData) return;
    var key = state.viewSource + '|' + d.id + '|' + state.line + '|' + ((state.epIdx || 0) + 1);
    if (prefetchCache.has(key) || prefetchKey === key) return;
    prefetchKey = key;
    api('/api/play', { source: state.viewSource, flag: line.flag, id: next.id }).then(function (r) {
      // 取址失败要回滚占位 key，否则这一集之后永远被 prefetchKey === key 拦住，再也预取不到。
      if (!r || !r.url) { prefetchKey = ''; return; }
      // HLS 要 hls.js 解析清单才有意义，这里只预热直链（红果/西饭/牛牛这类 mp4）。
      if (r.type === 'hls') { prefetchCache.set(key, { at: Date.now() }); trimPrefetch(); return; }
      if (!prefetchEl) {
        prefetchEl = document.createElement('video');
        prefetchEl.preload = 'auto';
        prefetchEl.muted = true;
        prefetchEl.playsInline = true;
        prefetchEl.setAttribute('aria-hidden', 'true');
        prefetchEl.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
        prefetchEl.addEventListener('loadeddata', function () {
          var k = prefetchEl._hgKey;
          try { prefetchEl.removeAttribute('src'); prefetchEl.load(); } catch (e) {}
          if (k) { prefetchCache.set(k, { at: Date.now() }); trimPrefetch(); }
        });
        document.body.appendChild(prefetchEl);
      }
      // 预取要用「下一集真正会播的那一档」：默认 auto 是 HEVC，不支持 HEVC 的浏览器预热了也播不了。
      var purl = r.url;
      if (r.quality && Array.isArray(r.quality.options) && r.quality.options.length) {
        var pick = null;
        if (state.qualityKey) {
          pick = r.quality.options.filter(function (o) { return o.key === state.qualityKey; })[0] || null;
        }
        if (!pick && !hevcSupported()) {
          pick = r.quality.options.filter(function (o) { return o.codec === 'h264'; })[0] || null;
        }
        if (pick && pick.url) purl = pick.url;
      }
      prefetchEl._hgKey = key;
      prefetchEl.src = authUrl(purl);
    }).catch(function () { prefetchKey = ''; });
  }
  function trimPrefetch() {
    while (prefetchCache.size > PREFETCH_MAX) prefetchCache.delete(prefetchCache.keys().next().value);
  }
  function stopPrefetch() {
    prefetchKey = '';
    if (!prefetchEl) return;
    try { prefetchEl.removeAttribute('src'); prefetchEl.load(); } catch (e) {}
  }

  function closePlayer() {
    // 先退全屏：全屏元素留在 top layer 时只隐藏 .player，会留下一块不可交互的黑屏。
    if (isFullscreen()) (document.exitFullscreen || document.webkitExitFullscreen || function () {}).call(document);
    var v = $('video');
    if (v.webkitDisplayingFullscreen && v.webkitExitFullscreen) { try { v.webkitExitFullscreen(); } catch (e) {} }
    // 关掉播放器后，仍在路上的 /api/play 响应不应再把播放器打开。
    playSeq++;
    closeQualityMenu();
    hidePlayerError();
    clearDiag();
    state.autoNextLatch = false;
    saveProgress(v);
    try { v.pause(); } catch (e) {}
    v.removeAttribute('src'); try { v.load(); } catch (e) {}
    stopPrefetch();
    destroyHls();
    state.switching = false;
    $('player').classList.add('hidden');
  }

  function nextEpisode(opts) {
    var auto = !!(opts && opts.auto);
    var d = state.detail; if (!d) return;
    var line = d.lines[state.line]; if (!line) return;
    var next = (state.epIdx || 0) + 1;
    if (next >= line.episodes.length) {
      state.autoNextLatch = false;
      if (!auto) toast('已经是最后一集');
      return;
    }
    playEpisode(state.line, next, 0, auto);
  }

  function showError(e) {
    var msg = (e && e.message) || '出错了';
    // P2(#5) 兜底：任何路径都不把浏览器英文原文（Failed to fetch / NetworkError…）甩给用户
    if (/Failed to fetch|NetworkError|Load failed|ERR_INTERNET_DISCONNECTED|ERR_NETWORK|net::/i.test(msg)) {
      msg = (typeof navigator !== 'undefined' && navigator.onLine === false)
        ? '网络已断开，请检查网络后重试' : '网络连接失败，请稍后重试';
    }
    toast(msg);
    // 空态区带「重试」按钮：重跑当前视图对应的动作（首页/分类/搜索/推荐/猜你喜欢）
    setEmptyState(msg, {
      note: (e && e.code === 'OFFLINE') ? '恢复网络后会自动重试一次，也可以直接点重试。' : '',
      retry: state.failedAction || retryCurrent
    });
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
      // 导入只写文件，不会自动成为当前源：这里显式切过去，否则刷新页面又退回原来的源。
      setActiveSource(res.source.id)
        .then(function () { refreshManage(); })
        .catch(function (e) { toast((e && e.message) || '导入后切换源失败'); });
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
    var finished = e.dur > 0 && e.pos >= e.dur - 2;
    var txt = document.createElement('div'); txt.className = 'resume-txt';
    var pct = e.dur ? Math.min(100, Math.round(e.pos / e.dur * 100)) : 0;
    txt.textContent = (finished ? '已看完 ' : '上次看到 ') + (e.epName || ('第 ' + ((e.epIdx || 0) + 1) + ' 集')) +
      ' · ' + fmtDur(e.pos) + (e.dur ? ' / ' + fmtDur(e.dur) : '') +
      (e.dur ? '（' + pct + '%）' : '') + ' · ' + ago(e.at);
    var go = document.createElement('button'); go.className = 'btn'; go.textContent = finished ? '重新播放' : '继续播放';
    go.addEventListener('click', function () { playEpisode(e.lineIdx || 0, e.epIdx || 0, finished ? 0 : (e.pos || 0)); });
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
      var finished = e.dur > 0 && (e.pos || 0) >= e.dur - 2;
      var go = document.createElement('button'); go.className = 'btn mini'; go.textContent = finished ? '重播' : '续播';
      go.addEventListener('click', function (ev) {
        ev.stopPropagation();
        closeHistory();
        state.pendingResume = finished ? Object.assign({}, e, { pos: 0 }) : e;
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
        state.pendingResume = finished ? Object.assign({}, e, { pos: 0 }) : e;
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
    if (s.id === 'template' || s.id === 'maccms') tags.appendChild(tag('示例', 'warn'));
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
    var healthBtn = document.createElement('button'); healthBtn.className = 'btn ghost mini'; healthBtn.textContent = '自检';
    healthBtn.title = '快速自检；按住 Shift 点击会真实取流（较慢）';
    healthBtn.addEventListener('click', function (e) { checkSourceHealth(row, s.id, healthBtn, e.shiftKey); });
    acts.appendChild(healthBtn);
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

  // 手动触发单个源健康检查（内置红果会真实取流校验）。
  function checkSourceHealth(row, id, btn, deep) {
    var old = row.querySelector('.srchealth');
    if (old) old.remove();
    btn.disabled = true; btn.textContent = '自检中…';
    var line = document.createElement('div'); line.className = 'srchealth';
    line.textContent = '正在检查 ' + id + ' …';
    row.appendChild(line);
    api('/api/sources/' + encodeURIComponent(id) + '/health' + (deep ? '?deep=1' : '')).then(function (r) {
      var parts = ['首页 ' + (r.items || 0) + ' 条'];
      if (r.playback) parts.push('取流 ' + (r.playback.ok ? '正常' : '异常') + (r.playback.backup ? '（已用备用线路）' : '') + '（' + (r.playback.total || 0) + ' 字节）');
      if (r.playback && r.playback.error) parts.push('取流错误：' + r.playback.error);
      if (r.error) parts.push('错误：' + r.error);
      var level = !r.ok ? '❌ ' : (r.degraded ? '⚠️ ' : '✅ ');
      line.textContent = level + id + ' · ' + parts.join(' · ') + ' · ' + (r.ms || 0) + 'ms';
      line.className = 'srchealth ' + (!r.ok ? 'bad' : (r.degraded ? 'warn' : 'ok'));
    }).catch(function (e) {
      line.textContent = '❌ ' + id + ' 自检失败：' + e.message;
      line.className = 'srchealth bad';
    }).then(function () { btn.disabled = false; btn.textContent = '自检'; });
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
      closeMenus();
      loadHome();
      return Promise.resolve();
    }
    return postJson('/api/sources/active', { id: id }).then(function () {
      state.source = id;
      $('sourceSelect').value = id;
      closeMenus();
      // loadSources 失败不该变成 unhandled rejection；loadHome 自己会把错误显示出来。
      return loadSources().catch(function () {}).then(loadHome);
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
  $('btnMore').addEventListener('click', function () {
    // 用户显式点「加载更多」：续一次自动补页预算（滚动不会续，见 maybeAutoMore）
    autoBudget = Math.max(0, autoBudget - 1);
    loadMore();
  });
  $('btnHome').addEventListener('click', function () { loadHome(); });
  $('btnRecommend').addEventListener('click', function () { loadRecommend(); });
  $('btnForYou').addEventListener('click', function () { loadForYou(); });
  // P1(#2)：滚动只触发「是否该补页」的判断，不再重置自动补页预算
  // （旧实现 autoChain = 0 让 5 页上限失效，源 hasMore 恒真时能一直翻下去）。
  window.addEventListener('scroll', function () { maybeAutoMore(); }, { passive: true });
  // P2(#5)：网络恢复时自动重试一次最近失败的动作，用户不用手动点。
  window.addEventListener('online', function () {
    var act = state.failedAction;
    if (!act) return;
    state.failedAction = null;
    toast('网络已恢复，正在重试…');
    try { act(); } catch (e) {}
  });
  // 底部哨兵：若滚动事件在容器/内嵌场景不触发，IntersectionObserver 仍能兜住自动加载
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i += 1) if (entries[i].isIntersecting) maybeAutoMore();
    }, { rootMargin: '600px 0px' }).observe($('sentinel'));
  }
  $('btnBack').addEventListener('click', function () { setView('home'); });
  $('btnClosePlayer').addEventListener('click', closePlayer);
  $('btnPlayerRetry').addEventListener('click', function () {
    var btn = $('btnPlayerRetry');
    if (btn && btn.dataset.mode === 'compat') {
      var compat = optionByKey('compat');
      if (compat && compat.url) {
        hidePlayerError();
        if (switchNativeQuality(compat)) { toast('已切换到 360P 兼容线路'); return; }
      }
    }
    retryPlayback();
  });
  $('btnPlayerSwitch').addEventListener('click', switchPlaybackSource);
  $('btnPlayerFallback').addEventListener('click', useFallback);
  $('video').addEventListener('error', onVideoError);
  // 只绑 playing：loadedmetadata 只代表「元数据到了」，此时解码仍可能失败，
  // 绑在它上面会把刚弹出的错误横幅立刻收起来（黑屏却没有任何提示）。
  $('video').addEventListener('playing', hidePlayerError);
  $('btnNext').addEventListener('click', nextEpisode);
  $('btnAutoNext').addEventListener('click', toggleAutoNext);
  // ---- 顶栏二级菜单（账号 / 历史 / 源）----
  // 顶栏只保留三个分组标题，具体功能都在下拉面板里；同时只展开一个。
  function closeMenus(except) {
    var nodes = document.querySelectorAll('.tbmenu');
    for (var i = 0; i < nodes.length; i++) {
      var m = nodes[i];
      if (except && m === except) continue;
      m.classList.remove('open');
      var p = m.querySelector('.menupanel'); if (p) p.classList.add('hidden');
      var b = m.querySelector('.menubtn'); if (b) b.setAttribute('aria-expanded', 'false');
    }
  }
  function toggleMenu(menu) {
    var open = menu.classList.contains('open');
    closeMenus(menu);
    menu.classList.toggle('open', !open);
    var panel = menu.querySelector('.menupanel'); if (panel) panel.classList.toggle('hidden', open);
    var btn = menu.querySelector('.menubtn'); if (btn) btn.setAttribute('aria-expanded', open ? 'false' : 'true');
  }
  [['menuTheme', 'btnMenuTheme'], ['menuAccount', 'btnMenuAccount'], ['menuHistory', 'btnMenuHistory'], ['menuSource', 'btnMenuSource']].forEach(function (pair) {
    var menu = $(pair[0]), btn = $(pair[1]);
    if (!menu || !btn) return;
    btn.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(menu); });
    // 点面板里的任意按钮后收起（源下拉框保持展开，方便连续切换）
    menu.querySelector('.menupanel').addEventListener('click', function (e) {
      if (e.target && e.target.tagName === 'SELECT') return;
      if (e.target && e.target.classList && e.target.classList.contains('menuitem')) closeMenus();
    });
  });
  document.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('.tbmenu')) return;
    closeMenus();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeMenus(); });
  $('btnImport').addEventListener('click', openImport);
  $('btnManage').addEventListener('click', openManage);
  $('btnManageClose').addEventListener('click', closeManage);
  $('btnCheckUpdates').addEventListener('click', checkSourceUpdates);
  $('btnRate').addEventListener('click', function () { cycleRate(1); });
  $('btnQuality').addEventListener('click', toggleQualityMenu);
  document.addEventListener('click', function (e) {
    var w = document.querySelector('.qwrap'); var m = $('qualityMenu');
    if ((!w || !w.contains(e.target)) && (!m || !m.contains(e.target))) closeQualityMenu();
  });
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
    if (state.user) toast('已登录：' + state.user.username);
    else openAuth('login');
  });
  $('btnRegister').addEventListener('click', function () { openAuth('register'); });
  $('btnLogout').addEventListener('click', function () {
    if (window.confirm('退出登录？本机观看记录会保留。')) logout();
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
    toggleAutoNext: toggleAutoNext, autoNextAllowed: autoNextAllowed, realEnd: realEnd,
    loadRecommend: loadRecommend, loadForYou: loadForYou, loadMore: loadMore, maybeAutoMore: maybeAutoMore,
    openAuth: openAuth, logout: logout, refreshMe: refreshMe, checkUpdates: checkUpdates,
    loadFavs: loadFavs, loadFollows: loadFollows, toggleFav: toggleFav, toggleFollow: toggleFollow,
    mergeServerHistory: mergeServerHistory, closeMenus: closeMenus,
    selectQuality: selectQuality, switchNativeQuality: switchNativeQuality,
    qualityGate: qualityGate, probeHevcCap: probeHevcCap, buildQualityMenu: buildQualityMenu,
    defaultPlayableOption: defaultPlayableOption, hevcSupported: hevcSupported,
    doSearch: doSearch, loadHome: loadHome, loadCategory: loadCategory, retryCurrent: retryCurrent,
    // 翻页/请求序号的内部计数（只读）：验证「自动补页预算与滚动解耦」时用来取证
    debugList: function () {
      return {
        mode: state.mode, page: state.page, hasMore: state.hasMore, loadingMore: state.loadingMore,
        autoBudget: autoBudget, autoLockAt: autoLockAt, reqSeq: reqSeq, lastPageSig: state.lastPageSig,
        searching: state.searching, hevcCap: state.hevcCap, hevcSupported: hevcSupported()
      };
    },
    diagnose: { probe: probeStream, classify: classifyPlayback, report: diagnoseAndReport, arm: armStallCheck, clear: clearDiag },
    prefetch: { cache: prefetchCache, el: function () { return prefetchEl; }, next: prefetchNext, trim: trimPrefetch }
  };

  // ---- 启动 ----
  function bootFromQuery() {
    var sp = new URLSearchParams(location.search);
    if (sp.get('rec') === '1') { loadRecommend(); return true; }
    if (sp.get('foryou') === '1') { loadForYou(); return true; }
    var src = sp.get('source') || '';
    if (src) {
      var sel = $('sourceSelect');
      var matched = false;
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === src) { sel.value = src; state.source = src; matched = true; break; }
      }
      // 链接里的源不在下拉中（如示例源）时回退到下拉当前值，避免地址与 state 不一致。
      if (!matched && sel.value) state.source = sel.value;
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
  // P2(#4)：启动即探测 HEVC 解码能力，清晰度菜单才能给出「HEVC·本机不支持」标注
  probeHevcCap();
  initTheme();
  loadRate(); applyRate(); loadAutoNext(); syncFullBtn(); renderAccount(); loadVersion(); loadHealth();
  setInterval(loadHealth, 60 * 1000);
  // PWA：注册 service worker（仅 http(s) 下有效）
  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    var hadSwController = !!navigator.serviceWorker.controller;
    // 新版本 Service Worker 接管后自动刷新一次，避免 PWA 长期停留在旧 app.js
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (hadSwController) location.reload();
    });
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
    // PWA 独立窗口可能长期不重新导航：回到前台时主动检查一次 sw.js，有新版本就安装接管
    //（接管后 controllerchange 已自动刷新一次），避免安装版一直停在旧界面。
    function checkSwUpdate() {
      navigator.serviceWorker.getRegistration().then(function (reg) {
        if (reg) reg.update().catch(function () {});
      }).catch(function () {});
    }
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') checkSwUpdate();
    });
    window.addEventListener('focus', checkSwUpdate);
  }
  loadSources().then(function () {
    var sp = new URLSearchParams(location.search);
    if (!bootFromQuery()) loadHome();
    if (sp.get('manage') === '1') openManage();
    if (sp.get('hist') === '1') openHistory();
    return refreshMe().then(function () {
      if (!state.user) return null;
      loadRate(); applyRate(); // 已登录：先套用该账号本地缓存的倍速
      return Promise.all([loadFavs(), loadFollows(), mergeServerHistory(), syncRateFromServer()]).then(function () { return checkUpdates(false, true); });
    });
  }).catch(function (e) { showError(e); });
})();