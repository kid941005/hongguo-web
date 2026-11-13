// ===== 本地补丁：CENC 解密能力守卫（快速失败，防静默花屏） =====
// 这个文件不属于上游 hongguo.cjs，由 server/provider.mjs 的 loadVendor() 追加到
// vendor 源的同一 vm 作用域内执行，因此可以直接复用上文的 readBox/findBox 等内部实现，
// 而 vendor 源本体保持与上游逐字节一致。
//
// 背景：vendor 的 decryptPartial 只实现 cenc(AES-128-CTR) + 每样本 8 字节 IV + 无 subsample +
// moov 前置的非分片 MP4；它从不读取 schm/tenc/senc。上游若改成 cbcs/cens、16 字节 IV、
// 含 subsample 或分片 MP4，prepareCencHeader 仍会“成功”，decryptPartial 却按 8 字节 IV 解，
// 结果是静默花屏。这里在 prepareCencHeader 之前解析真实加密头做校验，不满足即抛
// CENC_UNSUPPORTED（业务码，见 server/errors.mjs 的 502 登记），让 provider 透出明确文案而不是花屏。
//
// 导出：
//   cencInspect(buffer) -> { supported, scheme, ivSize, hasSubsample, fragmented, moovOffset, ftypSize, tracks, reason }
//     结构非法（非 MP4 / 缺 moov / 无 sinf）时抛 CENC_INSPECT_INVALID；
//   cencGuard(buffer)   -> 在 supported=false 时抛 CENC_UNSUPPORTED（供 provider 层复用/自测）。
// 真正的校验注入点见文件末尾对 prepareCencHeader 的包裹——这是唯一同时拿得到“原始头部字节”
// 且位于 prepareCencHeader 之前的注入位置。

const CENC_UNSUPPORTED_MESSAGE = "该剧加密格式暂不支持，请切换其他源";
const CENC_EIGHT_IV = 8;

function cencInvalid(detail) {
    const error = new Error("CENC_INSPECT_INVALID: " + detail);
    error.code = "CENC_INSPECT_INVALID";
    return error;
}

// 与上文 readBox 语义一致，但显式带 end 上界，便于在子区间内安全解析。
function cencReadBox(data, offset, end) {
    if (offset < 0 || offset + 8 > end) return null;
    let size = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
        if (offset + 16 > end) return null;
        const large = data.readBigUInt64BE(offset + 8);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        size = Number(large); header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) return null;
    return { offset, size, type, header, bodyStart: offset + header, end: offset + size };
}

// 顺序遍历同一层的子 box（ISO BMFF 的紧凑布局）。
function cencChildren(data, start, end) {
    const list = [];
    let cursor = start;
    while (cursor + 8 <= end) {
        const box = cencReadBox(data, cursor, end);
        if (!box || box.size <= 0) break;
        list.push(box);
        cursor = box.end;
    }
    return list;
}

function cencChild(data, start, end, type) {
    for (const box of cencChildren(data, start, end)) if (box.type === type) return box;
    return null;
}

// 在 [start,end) 内逐字节搜索指定类型的 box：用于 stsd 样本条目（encv/enca）里那段
// “固定字段 + 子 box”的非紧凑布局——sinf 的 4cc 唯一，配合 size 校验可稳定定位。
function cencFindBoxIn(data, type, start, end) {
    const bytes = Buffer.from(type, "ascii");
    let offset = Math.max(0, start);
    while (offset + 8 <= end) {
        const at = data.indexOf(bytes, offset);
        if (at < 0 || at + 4 > end) break;
        const box = cencReadBox(data, at - 4, end);
        if (box && box.type === type) return box;
        offset = at + 1;
    }
    return null;
}

// 解析单条轨道的加密信息（scheme/ivSize/subsample）。明文轨道（无 sinf）返回 null。
function cencTrackInfo(data, moovBody, trak) {
    const mdia = cencChild(moovBody, trak.bodyStart, trak.end, "mdia");
    if (!mdia) return null;
    const minf = cencChild(moovBody, mdia.bodyStart, mdia.end, "minf");
    if (!minf) return null;
    const stbl = cencChild(moovBody, minf.bodyStart, minf.end, "stbl");
    if (!stbl) return null;
    const sinf = cencFindBoxIn(moovBody, "sinf", stbl.bodyStart, stbl.end);
    if (!sinf) return null; // 明文轨道，跳过
    let scheme = null;
    const schm = cencFindBoxIn(moovBody, "schm", sinf.bodyStart, sinf.end);
    if (schm && schm.bodyStart + 8 <= schm.end) scheme = moovBody.toString("ascii", schm.bodyStart + 4, schm.bodyStart + 8);
    // tenc: FullBox(4) + reserved(1) + (v1?pattern(1):reserved(1)) + isProtected(1) + ivSize(1) + KID(16)
    let ivSize = null; let isProtected = null;
    const tenc = cencFindBoxIn(moovBody, "tenc", sinf.bodyStart, sinf.end);
    if (tenc && tenc.bodyStart + 8 <= tenc.end) { isProtected = moovBody[tenc.bodyStart + 6]; ivSize = moovBody[tenc.bodyStart + 7]; }
    // subsample：读 saiz 的 default_sample_info_size / 逐样本尺寸；无 subsample 时每样本 aux 恰为 ivSize(8)。
    let hasSubsample = false;
    const saiz = cencChild(moovBody, stbl.bodyStart, stbl.end, "saiz");
    if (saiz && saiz.bodyStart + 5 <= saiz.end) {
        const flags = ((moovBody[saiz.bodyStart + 1] << 16) | (moovBody[saiz.bodyStart + 2] << 8) | moovBody[saiz.bodyStart + 3]) >>> 0;
        const base = saiz.bodyStart + 4 + ((flags & 1) ? 8 : 0);
        if (base + 5 <= saiz.end) {
            const def = moovBody[base];
            const count = moovBody.readUInt32BE(base + 1);
            if (def === 0) {
                for (let i = 0; i < count && base + 5 + i < saiz.end; i += 1) {
                    if (moovBody[base + 5 + i] > CENC_EIGHT_IV) { hasSubsample = true; break; }
                }
            } else if (def > CENC_EIGHT_IV) { hasSubsample = true; }
        }
    }
    return { scheme, ivSize, isProtected, hasSubsample };
}

function cencInspect(buffer) {
    if (!Buffer.isBuffer(buffer)) throw cencInvalid("输入不是 Buffer");
    const data = buffer;
    if (data.length < 16) throw cencInvalid("数据过短");
    if (data.toString("ascii", 4, 8) !== "ftyp") throw cencInvalid("非法 MP4（缺少 ftyp）");
    let moov = null;
    let fragmented = false;
    for (const box of cencChildren(data, 0, data.length)) {
        if (box.type === "moov") moov = box;
        if (box.type === "moof") fragmented = true;
    }
    if (!moov) throw cencInvalid("缺少 moov");
    const ftypSize = data.readUInt32BE(0);
    const moovBody = data.subarray(moov.bodyStart, moov.end);
    if (cencFindBoxIn(moovBody, "mvex", 0, moovBody.length)) fragmented = true;
    const tracks = [];
    for (const box of cencChildren(moovBody, 0, moovBody.length)) {
        if (box.type !== "trak") continue;
        const info = cencTrackInfo(data, moovBody, box);
        if (info) tracks.push(info);
    }
    if (!tracks.length) throw cencInvalid("未找到 sinf/schm（未加密或结构异常）");
    const scheme = tracks[0].scheme;
    const ivSize = tracks[0].ivSize;
    const hasSubsample = tracks.some((track) => track.hasSubsample === true);
    const allCenc = tracks.every((track) => track.scheme === "cenc");
    const allEight = tracks.every((track) => track.ivSize === CENC_EIGHT_IV);
    const supported = allCenc && allEight && !hasSubsample && !fragmented;
    let reason = null;
    if (!supported) {
        if (!allCenc) reason = "加密方案非 cenc（如 cbcs/cens/cbc1）";
        else if (!allEight) reason = "IV 长度非 8 字节";
        else if (hasSubsample) reason = "包含 subsample 加密";
        else if (fragmented) reason = "分片（fragmented）MP4";
    }
    return { supported, scheme, ivSize, hasSubsample, fragmented, moovOffset: moov.offset, ftypSize, tracks, reason };
}

function cencGuard(buffer) {
    const info = cencInspect(buffer);
    if (!info.supported) {
        const error = new Error(CENC_UNSUPPORTED_MESSAGE);
        error.code = "CENC_UNSUPPORTED";
        error.cenc = info;
        throw error;
    }
    return info;
}

// 在 vendor 的 prepareCencHeader 之前插入校验（同一 vm 作用域，包裹原函数）。
// vendor 升级若改名/删除该函数则跳过包裹（cencInspect/cencGuard 仍可导出，不影响加载）。
if (typeof prepareCencHeader === "function") {
    var __cencOriginalPrepareCencHeader = prepareCencHeader;
    prepareCencHeader = function (data, key, codec) {
        try {
            cencGuard(data);
        } catch (error) {
            // 仅拦截“能解析但方案不支持”的明确结论；结构性解析失败交给原函数按既有路径处理。
            if (error && error.code === "CENC_UNSUPPORTED") throw error;
        }
        return __cencOriginalPrepareCencHeader(data, key, codec);
    };
}
