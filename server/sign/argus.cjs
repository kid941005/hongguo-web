// SPDX-License-Identifier: GPL-3.0-only
// x-argus / x-ladon implementation adapted from fqapp / N3urda/hongguoTV (GPL-3.0-only).
// Full Simon 64/128 cipher, ProtoBuf bean writer, 551 framing, and Ladon 34-round ARX cipher.
const crypto = require('node:crypto');
const sm3 = require('./sm3.cjs');

// --- 1. Minimal ProtoBuf Writer ---
class ProtoBuf {
  constructor() {
    this.fields = [];
    this.blobs = [];
  }
  putVarint(idx, v) {
    this.fields.push({ tag: idx, type: 0, value: BigInt(v), blobIndex: -1 });
    return this;
  }
  putBlob(idx, data) {
    this.blobs.push(data);
    this.fields.push({ tag: idx, type: 2, value: 0n, blobIndex: this.blobs.length - 1 });
    return this;
  }
  putUtf8(idx, s) {
    return this.putBlob(idx, Buffer.from(String(s == null ? '' : s), 'utf8'));
  }
  putBytes(idx, data) {
    return this.putBlob(idx, Buffer.isBuffer(data) ? data : Buffer.from(data || ''));
  }
  putProtobuf(idx, nested) {
    return this.putBlob(idx, nested.toBuf());
  }
  toBuf() {
    const parts = [];
    for (const f of this.fields) {
      this.writeVarint(parts, (BigInt(f.tag) << 3n) | BigInt(f.type));
      if (f.type === 0) {
        this.writeVarint(parts, f.value);
      } else if (f.type === 2) {
        const b = this.blobs[f.blobIndex];
        this.writeVarint(parts, BigInt(b.length));
        parts.push(b);
      }
    }
    return Buffer.concat(parts);
  }
  writeVarint(parts, v) {
    let n = BigInt.asUintN(32, BigInt(v));
    const out = [];
    while (n >= 128n) {
      out.push(Number((n & 127n) | 128n));
      n >>= 7n;
    }
    out.push(Number(n));
    parts.push(Buffer.from(out));
  }
}

// --- 2. Simon 64/128 Block Cipher ---
const Z = 0x3DC94C3A046D678Bn;
const MASK64 = 0xFFFFFFFFFFFFFFFFn;

function rotl64(x, n) {
  const s = BigInt(n) & 63n;
  return ((x << s) | (x >> (64n - s))) & MASK64;
}
function rotr64(x, n) {
  const s = BigInt(n) & 63n;
  return ((x >> s) | (x << (64n - s))) & MASK64;
}

const Simon = {
  keyExpansion(k) {
    const key = new Array(72);
    for (let i = 0; i < 4; i++) key[i] = BigInt.asUintN(64, k[i]);
    for (let i = 4; i < 72; i++) {
      let tmp = rotr64(key[i - 1], 3) ^ key[i - 3];
      tmp ^= rotr64(tmp, 1);
      const bit = (Z >> BigInt((i - 4) % 62)) & 1n;
      key[i] = (~key[i - 4] ^ tmp ^ bit ^ 3n) & MASK64;
    }
    return key;
  },
  encrypt(xInput, x1Input, k) {
    const key = this.keyExpansion(k);
    let xi = BigInt.asUintN(64, xInput);
    let xi1 = BigInt.asUintN(64, x1Input);
    for (const roundKey of key) {
      const tmp = xi1;
      const f = rotl64(xi1, 1) & rotl64(xi1, 8);
      xi1 = (xi ^ f ^ rotl64(xi1, 2) ^ roundKey) & MASK64;
      xi = tmp;
    }
    return [xi, xi1];
  },
  decrypt(xLeftInput, xRightInput, k) {
    const key = this.keyExpansion(k);
    let xLeft = BigInt.asUintN(64, xLeftInput);
    let xRight = BigInt.asUintN(64, xRightInput);
    for (let i = 71; i >= 0; i--) {
      const tmp = xLeft;
      const f = rotl64(xLeft, 1) & rotl64(xLeft, 8);
      xLeft = (xRight ^ f ^ rotl64(xLeft, 2) ^ key[i]) & MASK64;
      xRight = tmp;
    }
    return [xLeft, xRight];
  }
};

// --- 3. Ladon Cipher (34-round ARX) ---
const Ladon = {
  encrypt(khronos, lcId, aid, randomBytes) {
    const data = `${khronos}-${lcId}-${aid}`;
    const md5Hex = crypto.createHash('md5').update(Buffer.concat([randomBytes, Buffer.from(String(aid))])).digest('hex');
    const ht = this.expandTable(md5Hex);
    const size = data.length;
    const newSize = size + (16 - (size % 16));
    const padVal = newSize - size;
    const input = Buffer.alloc(newSize, padVal);
    Buffer.from(data, 'utf8').copy(input, 0);
    const out = Buffer.alloc(newSize);
    for (let i = 0; i < newSize / 16; i++) {
      this.encryptBlock(ht, input, i * 16).copy(out, i * 16);
    }
    return Buffer.concat([randomBytes, out]).toString('base64');
  },
  expandTable(md5Hex) {
    const ht = Buffer.alloc(288);
    const src = Buffer.from(md5Hex, 'utf8');
    src.copy(ht, 0, 0, Math.min(32, src.length));
    let b0 = ht.readBigUInt64LE(0);
    let b8 = ht.readBigUInt64LE(8);
    const temp = [ht.readBigUInt64LE(16), ht.readBigUInt64LE(24)];
    for (let i = 0; i < 34; i++) {
      let x8 = (rotr64(b8, 8) + b0) & MASK64;
      x8 ^= BigInt(i);
      temp.push(x8);
      x8 ^= rotl64(b0, 3);
      ht.writeBigUInt64LE(x8, (i + 1) * 8);
      b0 = x8;
      b8 = temp.shift();
    }
    const table = [];
    for (let i = 0; i < 36; i++) {
      table.push(ht.readBigUInt64LE(i * 8));
    }
    return table;
  },
  encryptBlock(ht, data, at) {
    let data0 = data.readBigUInt64LE(at);
    let data1 = data.readBigUInt64LE(at + 8);
    for (let i = 0; i < 34; i++) {
      data1 = (ht[i] ^ ((data0 + rotr64(data1, 8)) & MASK64)) & MASK64;
      data0 = (data1 ^ rotl64(data0, 3)) & MASK64;
    }
    const res = Buffer.alloc(16);
    res.writeBigUInt64LE(data0, 0);
    res.writeBigUInt64LE(data1, 8);
    return res;
  }
};

// --- 4. Argus Signer (551 layout) ---
const SIGN_KEY = Buffer.from('fc78e0a9657a0c748ce51559903ccf03510e51d3cff232d71343e88a321c5304', 'hex');
const AES_KEY = Buffer.from('d31e3718288a1027baab59f146a09a9c', 'hex');
const AES_IV = Buffer.from('ea180a0336ed352fcd24e4d50018ae54', 'hex');
const MAGIC8 = Buffer.from([0xf2, 0xf7, 0xfc, 0xff, 0xf2, 0xf7, 0xfc, 0xff]);
const TAIL9 = Buffer.from([0xea, 0xfb, 0x2c, 0xfe, 0x85, 0x68, 0x51, 0x91, 0x54]);

function pkcs7Pad(buf) {
  const pad = 16 - (buf.length % 16);
  return Buffer.concat([buf, Buffer.alloc(pad, pad)]);
}

function simonEncryptPadded(protobuf) {
  const key = [
    SIGN_KEY.readBigUInt64LE(0),
    SIGN_KEY.readBigUInt64LE(8),
    SIGN_KEY.readBigUInt64LE(16),
    SIGN_KEY.readBigUInt64LE(24)
  ];
  const out = Buffer.alloc(protobuf.length);
  for (let i = 0; i < protobuf.length; i += 16) {
    const xInput = protobuf.readBigUInt64LE(i);
    const x1Input = protobuf.readBigUInt64LE(i + 8);
    const [ct0, ct1] = Simon.encrypt(xInput, x1Input, key);
    out.writeBigUInt64LE(ct0, i);
    out.writeBigUInt64LE(ct1, i + 8);
  }
  return out;
}

function aesEncrypt(data, key, iv) {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function queryParam(query, name) {
  if (!query) return null;
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    const k = eq < 0 ? part : part.substring(0, eq);
    let decodedK = k;
    try {
      decodedK = decodeURIComponent(k);
    } catch {
      decodedK = k;
    }
    if (decodedK === name) {
      const v = eq < 0 ? '' : part.substring(eq + 1);
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    }
  }
  return null;
}

const Argus = {
  bodyHash(stubHex) {
    if (!stubHex) return sm3(Buffer.alloc(16)).subarray(0, 6);
    try {
      return sm3(Buffer.from(stubHex, 'hex')).subarray(0, 6);
    } catch {
      return sm3(Buffer.alloc(0)).subarray(0, 6);
    }
  },
  queryHash(query) {
    if (!query) return sm3(Buffer.alloc(16)).subarray(0, 6);
    return sm3(Buffer.from(query, 'utf8')).subarray(0, 6);
  },
  sign(query, stubHex, ts, aid, licenseId, deviceId, installId, randField) {
    const bean = new ProtoBuf();
    bean.putVarint(1, 1077940818);
    bean.putVarint(2, 2);
    bean.putVarint(3, BigInt.asUintN(32, BigInt(randField)));
    bean.putUtf8(4, String(aid === 0 ? 1967 : aid));
    bean.putUtf8(5, deviceId || '');
    bean.putUtf8(6, String(licenseId === 0 ? 1611921764 : licenseId));
    bean.putUtf8(7, queryParam(query, 'version_name') || '');
    bean.putUtf8(8, 'v04.04.05-ov-android');
    bean.putVarint(9, 134744640);
    bean.putBytes(10, Buffer.alloc(8));
    bean.putVarint(11, 0);
    bean.putVarint(12, (BigInt(ts) << 1n) & 0xffffffffn);
    bean.putBytes(13, this.bodyHash(stubHex));
    bean.putBytes(14, this.queryHash(query));
    const sub15 = new ProtoBuf();
    sub15.putVarint(1, 1).putVarint(2, 1).putVarint(3, 1).putVarint(7, 0xC792ECCC);
    bean.putProtobuf(15, sub15);
    bean.putUtf8(16, installId || '');
    bean.putUtf8(20, 'none');
    bean.putVarint(21, 738);
    const sub23 = new ProtoBuf();
    sub23.putUtf8(1, 'NX551J').putVarint(2, 8196).putVarint(4, 0x80E0D800);
    bean.putProtobuf(23, sub23);
    bean.putVarint(25, 2);

    const protobuf = pkcs7Pad(bean.toBuf());
    const encPb = simonEncryptPadded(protobuf);

    const un = Buffer.concat([MAGIC8, encPb, TAIL9]);
    const buf = Buffer.alloc(un.length);
    MAGIC8.copy(buf, 0);
    for (let i = 8; i < un.length; i++) {
      buf[i] = un[i] ^ MAGIC8[i % 8];
    }
    buf.reverse();
    const padded = pkcs7Pad(Buffer.concat([buf, Buffer.from([0x61, 0x6f])])); // 'ao'
    const encrypted = aesEncrypt(padded, AES_KEY, AES_IV);
    return Buffer.concat([Buffer.from([0xf2, 0x81]), encrypted]).toString('base64');
  }
};

const PlayerSigner = {
  LICENSE_ID: 1611921764,
  headers(query, body, ts = Math.floor(Date.now() / 1000)) {
    const aid = Number(queryParam(query, 'aid') || 1967);
    const stub = body && body.length > 0 ? crypto.createHash('md5').update(body).digest('hex') : '';
    const ladonRandom = crypto.randomBytes(4);
    const randField = crypto.randomBytes(4).readInt32LE(0);
    const deviceId = queryParam(query, 'device_id') || '';
    const installId = queryParam(query, 'iid') || '';
    const headers = {
      'x-ss-req-ticket': String(ts * 1000),
      'x-khronos': String(ts),
      'x-ladon': Ladon.encrypt(ts, this.LICENSE_ID, aid, ladonRandom),
      'x-argus': Argus.sign(query, stub, ts, aid, this.LICENSE_ID, deviceId, installId, randField)
    };
    if (stub) headers['x-ss-stub'] = stub.toUpperCase();
    return headers;
  }
};

module.exports = { ProtoBuf, Simon, Ladon, Argus, PlayerSigner, queryParam };
