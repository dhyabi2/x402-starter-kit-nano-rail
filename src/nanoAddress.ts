/**
 * Dependency-free Nano address validation, including the checksum.
 *
 * A Nano address is `nano_` (or legacy `xrb_`) followed by 60 characters in
 * Nano's base-32 alphabet: 52 characters encode the 32-byte public key (with
 * 4 leading pad bits) and the last 8 encode a 5-byte BLAKE2b digest of that
 * key, stored byte-reversed. A regex alone accepts a mistyped address whose
 * checksum does not match, which would send a payment to an account nobody
 * holds; this check rejects it.
 */

const NANO_ALPHABET = '13456789abcdefghijkmnopqrstuwxyz';
const NANO_ADDR_RE = /^(?:nano_|xrb_)[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/;

const MASK = (1n << 64n) - 1n;
const IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const rotr = (x: bigint, n: bigint): bigint => ((x >> n) | (x << (64n - n))) & MASK;

/** BLAKE2b (RFC 7693), unkeyed, for short inputs; `outLen` in bytes (1..64). */
export function blake2b(input: Uint8Array, outLen: number): Uint8Array {
  const h = IV.slice();
  h[0] ^= 0x01010000n ^ BigInt(outLen);
  const blocks = Math.max(1, Math.ceil(input.length / 128));
  for (let b = 0; b < blocks; b++) {
    const block = new Uint8Array(128);
    block.set(input.subarray(b * 128, b * 128 + 128));
    const m: bigint[] = [];
    for (let i = 0; i < 16; i++) {
      let w = 0n;
      for (let j = 7; j >= 0; j--) w = (w << 8n) | BigInt(block[i * 8 + j]);
      m.push(w);
    }
    const last = b === blocks - 1;
    const t = BigInt(last ? input.length : (b + 1) * 128);
    const v = [...h, ...IV];
    v[12] ^= t & MASK;
    if (last) v[14] ^= MASK;
    const g = (a: number, bb: number, c: number, d: number, x: bigint, y: bigint) => {
      v[a] = (v[a] + v[bb] + x) & MASK;
      v[d] = rotr(v[d] ^ v[a], 32n);
      v[c] = (v[c] + v[d]) & MASK;
      v[bb] = rotr(v[bb] ^ v[c], 24n);
      v[a] = (v[a] + v[bb] + y) & MASK;
      v[d] = rotr(v[d] ^ v[a], 16n);
      v[c] = (v[c] + v[d]) & MASK;
      v[bb] = rotr(v[bb] ^ v[c], 63n);
    };
    for (let r = 0; r < 12; r++) {
      const s = SIGMA[r % 10];
      g(0, 4, 8, 12, m[s[0]], m[s[1]]);
      g(1, 5, 9, 13, m[s[2]], m[s[3]]);
      g(2, 6, 10, 14, m[s[4]], m[s[5]]);
      g(3, 7, 11, 15, m[s[6]], m[s[7]]);
      g(0, 5, 10, 15, m[s[8]], m[s[9]]);
      g(1, 6, 11, 12, m[s[10]], m[s[11]]);
      g(2, 7, 8, 13, m[s[12]], m[s[13]]);
      g(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  }
  const out = new Uint8Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = Number((h[i >> 3] >> BigInt(8 * (i & 7))) & 0xffn);
  return out;
}

/** Decode the 60-character body into its 32-byte key and 5-byte checksum. */
function decodeBody(body: string): { key: Uint8Array; checksum: Uint8Array } | null {
  let bits = 0n;
  for (const c of body) {
    const i = NANO_ALPHABET.indexOf(c);
    if (i < 0) return null;
    bits = (bits << 5n) | BigInt(i);
  }
  // 60 chars * 5 bits = 300 bits = 4 pad bits + 256-bit key + 40-bit checksum.
  const bytes = new Uint8Array(37);
  for (let i = 36; i >= 0; i--) {
    bytes[i] = Number(bits & 0xffn);
    bits >>= 8n;
  }
  if (bits !== 0n) return null; // the 4 pad bits must be zero
  return { key: bytes.subarray(0, 32), checksum: bytes.subarray(32) };
}

/** True only for a well-formed Nano address whose checksum matches its key. */
export function isValidNanoAddress(address: string): boolean {
  if (typeof address !== 'string' || !NANO_ADDR_RE.test(address)) return false;
  const decoded = decodeBody(address.slice(address.indexOf('_') + 1));
  if (!decoded) return false;
  const expected = blake2b(decoded.key, 5).reverse();
  return expected.every((b, i) => b === decoded.checksum[i]);
}
