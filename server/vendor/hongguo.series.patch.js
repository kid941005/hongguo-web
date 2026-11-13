// ===== 本地补丁：官方系列剧（多季）列表通道 =====
// 这个文件不属于上游 hongguo.cjs，由 server/provider.mjs 的 loadVendor() 追加到
// vendor 源的同一 vm 作用域内执行，因此可以直接复用上文的 signedAppGet / APP_DEVICE /
// str / cleanUrl 等内部实现，而 vendor 源本体保持与上游逐字节一致。
// 对齐上游 spider.seriesSeasons（/reading/bookapi/plan/v + bookmall/cell/change/v）。
const HG_SERIES_BASE = 'https://reading.snssdk.com';
const HG_DISCOVERY_PATHS = new Set([
    '/reading/bookapi/plan/v',
    '/reading/bookapi/bookmall/cell/change/v',
]);

function hgPositiveInt(value) {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// 上游的 signedAppGet 把目标地址写死成 APP_SEARCH_API（搜索接口），无法复用去请求 plan/v。
// 这里在同一作用域内用同名的签名原语复刻一份「可指定地址」的签名 GET：
// 签名算法（x-gorgon/x-argus/x-ladon/x-helios/x-medusa）与 pythonUrlEncode 全部复用上文实现，
// 只在 vendor 本体之外新增，因此 vendor 源仍与上游逐字节一致。
async function hgSignedGet(apiUrl, values) {
    const khronos = Math.floor(Date.now() / 1000);
    const ticket = Date.now();
    const query = pythonUrlEncode({ ...values, ts: String(khronos), _rticket: String(ticket) });
    const url = apiUrl + '?' + query;
    const random = Math.floor(Math.random() * 65536);
    const body = null;
    const headers = {
        'User-Agent': APP_UA, Accept: 'application/json; charset=utf-8,application/x-protobuf',
        'x-ss-req-ticket': String(ticket), 'x-tt-request-tag': 't=0;n=0', 'sdk-version': '2',
        'passport-sdk-version': '50561', 'x-xs-from-web': '0', 'x-khronos': String(khronos),
        'x-ladon': be32(khronos).toString('base64'), 'x-argus': le32(khronos).toString('base64'),
        'x-gorgon': xGorgon(query, body, khronos, random), 'x-helios': helios(khronos),
        'x-medusa': buildMedusa(url, body, khronos), 'lc': '101', 'x-tt-dt': '',
    };
    const resp = await axios(url, { headers, timeout: 20000, responseType: 'text' });
    let data = null;
    try { data = JSON.parse(resp.data); } catch { data = null; }
    // 空正文 = 身份被风控：保持与 App 搜索一致的判据，交给 provider 换身份重试。
    if (resp.status !== 200 || !data) throw new Error('App search failed: ' + resp.status);
    return data;
}

// 只放行白名单路径，避免补丁被误用成任意官方接口代理（上游同款 SECURITY_BLOCKED 语义）。
async function hgDiscoveryGet(path, params) {
    if (!HG_DISCOVERY_PATHS.has(path)) throw new Error('不支持的官方接口：' + path);
    return hgSignedGet(HG_SERIES_BASE + path, { ...APP_DEVICE, ...params });
}

// 返回 { list: [{vod_id, vod_name, vod_pic, vod_content, vod_episodes, vod_remarks,
//               vod_release_status, season, playable, status}] }，按季号升序。
async function appSeriesSeasons(rawId) {
    const id = str(rawId).replace(/^hongguo:/, '');
    if (!/^[1-9]\d{9,29}$/.test(id)) throw new Error('INVALID_SERIES_ID');
    let response;
    try {
        response = await hgDiscoveryGet('/reading/bookapi/plan/v', {
            scene: 10, from: 'single_col_same_ip_series', book_id: id, filter_ids: id,
        });
    } catch (error) {
        throw new Error('SERIES_REJECTED: ' + ((error && error.message) || error));
    }
    if (Number(response.code) !== 0) throw new Error('SERIES_REJECTED');
    let cell = (Array.isArray(response.data) ? response.data : []).find((value) =>
        Array.isArray(value.video_data) && value.video_data.some((video) => hgPositiveInt(video.season_index) > 0));
    if (!cell) return { list: [] };
    const rows = new Map();
    const cursors = new Set();
    for (let page = 0; page < 10; page += 1) {
        for (const video of cell.video_data || []) {
            const raw = video.series_id_str || video.series_id;
            const vid = typeof raw === 'string' ? raw : Number.isSafeInteger(raw) ? String(raw) : '';
            const season = hgPositiveInt(video.season_index);
            if (!/^[1-9]\d{9,29}$/.test(vid) || !season || season > 200 || !str(video.title)) continue;
            const episodes = hgPositiveInt(video.episode_cnt);
            const upcoming = !episodes && !!video.subscribe_item;
            const playable = video.disable_play !== true && (!upcoming || episodes > 0);
            const status = upcoming ? '待上线' : (video.disable_play === true ? '暂不可播放' : '');
            rows.set(vid, {
                vod_id: vid, vod_name: str(video.title), vod_pic: cleanUrl(str(video.cover)),
                vod_content: str(video.video_desc), vod_episodes: episodes,
                vod_remarks: episodes ? episodes + '集' : status,
                vod_release_status: upcoming ? 'upcoming' : '',
                season, playable, status,
            });
        }
        if (cell.has_more !== true) break;
        const cursor = {
            cell_id: str(cell.cell_id_str), offset: hgPositiveInt(cell.next_offset),
            session_id: str(cell.session_id), filter_ids: id,
        };
        const key = cursor.cell_id + ':' + cursor.offset;
        if (!cursor.cell_id || !cursor.offset || cursors.has(key) || page === 9) throw new Error('INVALID_SERIES_CURSOR');
        cursors.add(key);
        const next = await hgDiscoveryGet('/reading/bookapi/bookmall/cell/change/v', cursor);
        if (Number(next.code) !== 0 || !next.data || !next.data.cell_view) throw new Error('INVALID_RESPONSE');
        cell = next.data.cell_view;
    }
    return { list: [...rows.values()].sort((a, b) => a.season - b.season) };
}
