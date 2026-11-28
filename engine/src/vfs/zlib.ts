const MAX_TRAILING_INFLATE_BYTES = 64 * 1024 * 1024;
const HARD_INFLATE_CAP_BYTES = 256 * 1024 * 1024;

const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15] as const;
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
] as const;
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
] as const;
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
] as const;
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
] as const;

interface HuffmanTable {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function buildHuffman(lengths: Uint8Array): HuffmanTable | null {
  const counts = new Uint16Array(16);
  for (let i = 0; i < lengths.length; i++) {
    const len = lengths[i]!;
    if (len > 15) return null;
    counts[len] = counts[len]! + 1;
  }
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left = (left << 1) - counts[len]!;
    if (left < 0) return null;
  }
  const offsets = new Uint16Array(16);
  for (let len = 1; len < 15; len++) {
    offsets[len + 1] = offsets[len]! + counts[len]!;
  }
  const symbols = new Uint16Array(lengths.length);
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym]!;
    if (len !== 0) {
      symbols[offsets[len]!] = sym;
      offsets[len] = offsets[len]! + 1;
    }
  }
  return { counts, symbols };
}

const FIXED_LIT_TABLE = (() => {
  const lengths = new Uint8Array(288);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, 288);
  return buildHuffman(lengths)!;
})();

const FIXED_DIST_TABLE = (() => {
  const lengths = new Uint8Array(32);
  lengths.fill(5);
  return buildHuffman(lengths)!;
})();

function adler32(bytes: Uint8Array): number {
  let s1 = 1;
  let s2 = 0;
  for (let i = 0; i < bytes.length; i++) {
    s1 = (s1 + bytes[i]!) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  return ((s2 << 16) | s1) >>> 0;
}

/**
 * Pure-TS RFC 1950 + RFC 1951 fallback used only when a valid FR3 zlib stream
 * has trailing junk bytes after its Adler-32 trailer (which causes browser and
 * Node `DecompressionStream("deflate")` to reject) and/or a stale 4-byte size
 * prefix. Returns `null` unless the stream is completely valid, Adler-32
 * verified, and strictly followed by trailing bytes.
 */
function tryInflateZlibWithTrailing(
  stream: Uint8Array,
  initialHint: number,
  maxOutputSize: number,
): Uint8Array | null {
  if (stream.length < 6) return null;
  const cmf = stream[0]!;
  const flg = stream[1]!;
  if ((cmf & 0x0f) !== 8 || (cmf >>> 4) > 7 || ((cmf << 8) | flg) % 31 !== 0) return null;
  if (flg & 0x20) return null; // FDICT preset dictionary is unsupported.

  let pos = 2;
  let bitBuf = 0;
  let bitCount = 0;

  const readBits = (n: number): number => {
    while (bitCount < n) {
      if (pos >= stream.length) return -1;
      bitBuf |= stream[pos++]! << bitCount;
      bitCount += 8;
    }
    const value = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCount -= n;
    return value;
  };

  const decodeSymbol = (table: HuffmanTable): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= 15; len++) {
      if (bitCount === 0) {
        if (pos >= stream.length) return -1;
        bitBuf = stream[pos++]!;
        bitCount = 8;
      }
      code |= bitBuf & 1;
      bitBuf >>>= 1;
      bitCount--;
      const count = table.counts[len]!;
      if (code - count < first) {
        return table.symbols[index + (code - first)]!;
      }
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    return -1;
  };

  let out = new Uint8Array(Math.min(Math.max(initialHint, 1024), maxOutputSize));
  let outLen = 0;
  const ensureCapacity = (needed: number): boolean => {
    if (needed > maxOutputSize) return false;
    if (needed <= out.length) return true;
    let nextCap = out.length;
    while (nextCap < needed) nextCap = Math.min(nextCap * 2, maxOutputSize);
    const grown = new Uint8Array(nextCap);
    grown.set(out.subarray(0, outLen));
    out = grown;
    return true;
  };

  let bfinal = 0;
  while (bfinal === 0) {
    const header = readBits(3);
    if (header < 0) return null;
    bfinal = header & 1;
    const btype = header >>> 1;

    if (btype === 0) {
      bitBuf = 0;
      bitCount = 0;
      if (pos + 4 > stream.length) return null;
      const len = stream[pos]! | (stream[pos + 1]! << 8);
      const nlen = stream[pos + 2]! | (stream[pos + 3]! << 8);
      pos += 4;
      if ((len ^ 0xffff) !== nlen || pos + len > stream.length) return null;
      if (!ensureCapacity(outLen + len)) return null;
      out.set(stream.subarray(pos, pos + len), outLen);
      pos += len;
      outLen += len;
    } else if (btype === 1 || btype === 2) {
      let litTable: HuffmanTable;
      let distTable: HuffmanTable;
      if (btype === 1) {
        litTable = FIXED_LIT_TABLE;
        distTable = FIXED_DIST_TABLE;
      } else {
        const hlit = readBits(5);
        const hdist = readBits(5);
        const hclen = readBits(4);
        if (hlit < 0 || hdist < 0 || hclen < 0) return null;
        const litCount = hlit + 257;
        const distCount = hdist + 1;
        if (litCount > 286 || distCount > 30) return null;

        const clLengths = new Uint8Array(19);
        for (let i = 0; i < hclen + 4; i++) {
          const bits = readBits(3);
          if (bits < 0) return null;
          clLengths[CODE_LENGTH_ORDER[i]!] = bits;
        }
        const clTable = buildHuffman(clLengths);
        if (!clTable) return null;

        const totalLengths = litCount + distCount;
        const lengths = new Uint8Array(totalLengths);
        let idx = 0;
        while (idx < totalLengths) {
          const sym = decodeSymbol(clTable);
          if (sym < 0) return null;
          if (sym < 16) {
            lengths[idx++] = sym;
          } else if (sym === 16) {
            if (idx === 0) return null;
            const extra = readBits(2);
            if (extra < 0) return null;
            const repeat = extra + 3;
            if (idx + repeat > totalLengths) return null;
            lengths.fill(lengths[idx - 1]!, idx, idx + repeat);
            idx += repeat;
          } else if (sym === 17) {
            const extra = readBits(3);
            if (extra < 0) return null;
            const repeat = extra + 3;
            if (idx + repeat > totalLengths) return null;
            idx += repeat;
          } else if (sym === 18) {
            const extra = readBits(7);
            if (extra < 0) return null;
            const repeat = extra + 11;
            if (idx + repeat > totalLengths) return null;
            idx += repeat;
          } else {
            return null;
          }
        }
        const builtLit = buildHuffman(lengths.subarray(0, litCount));
        const builtDist = buildHuffman(lengths.subarray(litCount));
        if (!builtLit || !builtDist) return null;
        litTable = builtLit;
        distTable = builtDist;
      }

      while (true) {
        const sym = decodeSymbol(litTable);
        if (sym < 0) return null;
        if (sym < 256) {
          if (!ensureCapacity(outLen + 1)) return null;
          out[outLen++] = sym;
        } else if (sym === 256) {
          break;
        } else {
          const lenIdx = sym - 257;
          if (lenIdx >= LENGTH_BASE.length) return null;
          const lenExtra = LENGTH_EXTRA[lenIdx]!;
          const extraLen = lenExtra ? readBits(lenExtra) : 0;
          if (extraLen < 0) return null;
          const length = LENGTH_BASE[lenIdx]! + extraLen;

          const distSym = decodeSymbol(distTable);
          if (distSym < 0 || distSym >= DIST_BASE.length) return null;
          const distExtra = DIST_EXTRA[distSym]!;
          const extraDist = distExtra ? readBits(distExtra) : 0;
          if (extraDist < 0) return null;
          const distance = DIST_BASE[distSym]! + extraDist;
          if (distance > outLen) return null;

          if (!ensureCapacity(outLen + length)) return null;
          for (let i = 0; i < length; i++) {
            out[outLen] = out[outLen - distance]!;
            outLen++;
          }
        }
      }
    } else {
      return null;
    }
  }

  // Align to byte boundary and verify RFC 1950 4-byte big-endian Adler-32 trailer.
  bitBuf = 0;
  bitCount = 0;
  if (pos + 4 > stream.length) return null;
  const expectedAdler = (
    ((stream[pos]! << 24) | (stream[pos + 1]! << 16) | (stream[pos + 2]! << 8) | stream[pos + 3]!) >>> 0
  );
  pos += 4;
  // Only accept via this fallback when trailing junk bytes actually exist after EOF;
  // clean streams without trailing junk must keep strict declared-size validation.
  if (pos >= stream.length) return null;

  const result = out.slice(0, outLen);
  if (adler32(result) !== expectedAdler) return null;
  return result;
}

/** Identify a size-prefixed zlib stream by its RFC 1950 header. */
export function hasFr3Wrapper(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const cmf = bytes[4]!;
  const flg = bytes[5]!;
  return (cmf & 0x0f) === 8 && (cmf >>> 4) <= 7 && ((cmf << 8) | flg) % 31 === 0;
}

/** Inflate a complete stream, checking the size before retaining each output chunk. */
export async function inflate(
  bytes: Uint8Array,
  format: "deflate" | "deflate-raw",
  expectedSize: number,
): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      // Copy into an ordinary ArrayBuffer, including when the input is a Buffer
      // subview or backed by SharedArrayBuffer.
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream(format)).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > expectedSize) {
        await reader.cancel();
        throw new Error(`Inflated data exceeds declared size ${expectedSize}`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (size !== expectedSize) {
    throw new Error(`Inflated size ${size} does not match declared size ${expectedSize}`);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export async function unpackFr3Resource(bytes: Uint8Array): Promise<Uint8Array> {
  if (!hasFr3Wrapper(bytes)) return bytes;
  const declaredSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const stream = bytes.subarray(4);
  try {
    return await inflate(stream, "deflate", declaredSize);
  } catch (error) {
    const cap = Math.min(Math.max(declaredSize, MAX_TRAILING_INFLATE_BYTES), HARD_INFLATE_CAP_BYTES);
    const fallback = tryInflateZlibWithTrailing(stream, Math.min(declaredSize, cap), cap);
    if (fallback) return fallback;
    throw error;
  }
}
