// MP4 首块结构校验（A3）。
// 上游静默失败时 HTTP 仍是 200、长度也正常，只有字节不对：
// 例如 CDN 回了 403 的 HTML、模型换了签名导致解密出乱码、节点返回了空壳。
// 这类响应如果直接写进响应头，播放器只会得到一个「格式不支持」的通用错误，
// 服务端日志里却是一片 206 正常。所以写头之前先看首块是不是合法 box。
const HEAD_BOXES = new Set([
  "ftyp", "styp", "moov", "mdat", "sidx", "moof",
  "free", "skip", "wide", "uuid", "pdin", "emsg", "meta",
]);

// 返回 { ok, box, size, bytes, reason }。数据不足 8 字节时不判死（调用方自己决定）。
export function probeMp4Head(chunk) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk || []);
  if (buf.length < 8) return { ok: false, box: "", size: 0, bytes: buf.length, reason: "too_short" };
  let size = buf.readUInt32BE(0);
  const box = buf.toString("ascii", 4, 8);
  if (size === 1) {
    if (buf.length < 16) return { ok: false, box, size: 0, bytes: buf.length, reason: "too_short" };
    size = buf.readUInt32BE(8) * 4294967296 + buf.readUInt32BE(12);
  }
  // box type 必须是可打印 ASCII（乱码/HTML 会直接失败在这一步）。
  const printable = /^[\x20-\x7e]{4}$/.test(box);
  const ok = printable && HEAD_BOXES.has(box) && (size === 0 || size >= 8);
  return {
    ok,
    box,
    size,
    bytes: buf.length,
    reason: ok ? "" : printable ? "unknown_box" : "not_box",
  };
}
