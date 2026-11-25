const spcEntrySize = 76;
const mpcEntrySize = 64;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function ascii(bytes: Uint8Array, start: number, length: number, nulTerminated = false): string {
  let value = "";
  for (let index = start; index < start + length; index++) {
    const byte = bytes[index]!;
    if (nulTerminated && byte === 0) break;
    if (nulTerminated && (byte < 32 || byte > 126)) throw new Error(`Invalid ASCII name at byte ${index}`);
    value += String.fromCharCode(byte);
  }
  return value;
}

export interface WaveFormat {
  readonly codec: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly byteRate: number;
  readonly blockAlign: number;
  readonly bitsPerSample: number;
}

export interface SmplLoop {
  readonly cueId: number;
  readonly type: number;
  readonly startFrame: number;
  readonly endFrameInclusive: number;
  readonly fraction: number;
  /** Zero denotes indefinite repetition. */
  readonly playCount: number;
}

export interface WsmpLoop {
  readonly type: number;
  readonly startFrame: number;
  readonly frameCount: number;
}

export interface WaveSample {
  readonly format: WaveFormat;
  /** Views of the input bytes. */
  readonly riff: Uint8Array;
  readonly data: Uint8Array;
  readonly smplLoops: readonly SmplLoop[];
  readonly wsmpLoops: readonly WsmpLoop[];
}

export function parseWaveSample(riff: Uint8Array): WaveSample {
  const binary = view(riff);
  const u32 = (offset: number) => binary.getUint32(offset, true);
  if (riff.length < 12 || ascii(riff, 0, 4) !== "RIFF" || ascii(riff, 8, 4) !== "WAVE") {
    throw new Error("Expected a RIFF/WAVE header");
  }
  if (u32(4) + 8 !== riff.length) throw new Error("RIFF size does not match the supplied slice");

  let format: WaveFormat | undefined;
  let data: Uint8Array | undefined;
  const smplLoops: SmplLoop[] = [];
  const wsmpLoops: WsmpLoop[] = [];
  let cursor = 12;
  while (cursor < riff.length) {
    if (riff.length - cursor < 8) throw new Error(`Truncated WAVE chunk header at byte ${cursor}`);
    const type = ascii(riff, cursor, 4);
    const size = u32(cursor + 4);
    const start = cursor + 8;
    const end = start + size;
    cursor = end + (size & 1);
    if (cursor > riff.length) throw new Error(`Truncated WAVE chunk "${type}" at byte ${start - 8}`);

    switch (type) {
      case "fmt ":
        if (size < 16 || format) throw new Error("Invalid or duplicate WAVE fmt chunk");
        format = {
          codec: binary.getUint16(start, true),
          channels: binary.getUint16(start + 2, true),
          sampleRate: u32(start + 4),
          byteRate: u32(start + 8),
          blockAlign: binary.getUint16(start + 12, true),
          bitsPerSample: binary.getUint16(start + 14, true),
        };
        break;
      case "data":
        if (data) throw new Error("Duplicate WAVE data chunk");
        data = riff.subarray(start, end);
        break;
      case "smpl": {
        if (size < 36) throw new Error("Truncated WAVE smpl header");
        const count = u32(start + 28);
        const samplerBytes = u32(start + 32);
        if (36 + count * 24 + samplerBytes > size) throw new Error("Truncated WAVE smpl loop table or sampler data");
        for (let offset = start + 36; offset < start + 36 + count * 24; offset += 24) {
          smplLoops.push({
            cueId: u32(offset), type: u32(offset + 4), startFrame: u32(offset + 8),
            endFrameInclusive: u32(offset + 12), fraction: u32(offset + 16), playCount: u32(offset + 20),
          });
        }
        break;
      }
      case "wsmp": {
        if (size < 20) throw new Error("Truncated WAVE wsmp header");
        const headerSize = u32(start);
        const count = u32(start + 16);
        if (headerSize < 20 || headerSize + count * 16 > size) throw new Error("Invalid WAVE wsmp header or loop count");
        let offset = start + headerSize;
        for (let index = 0; index < count; index++) {
          if (end - offset < 16) throw new Error("Truncated WAVE wsmp loop");
          const recordSize = u32(offset);
          if (recordSize < 16 || recordSize > end - offset) throw new Error("Invalid WAVE wsmp loop size");
          wsmpLoops.push({ type: u32(offset + 4), startFrame: u32(offset + 8), frameCount: u32(offset + 12) });
          offset += recordSize;
        }
        break;
      }
    }
  }

  if (!format || !data) throw new Error("WAVE requires fmt and data chunks");
  return { riff, format, data, smplLoops, wsmpLoops };
}

export interface SpcEntry {
  readonly name: string;
  readonly metadata: Uint8Array;
  /** Offset relative to the start of the payload area. */
  readonly offset: number;
  readonly length: number;
  readonly wave: WaveSample;
}

export interface SpcBank {
  readonly entries: readonly SpcEntry[];
  readonly payloadOffset: number;
  /** Bytes outside all table entries and WAVE slices, including gaps. */
  readonly leftoverBytes: number;
}

export function parseSpc(bytes: Uint8Array): SpcBank {
  if (bytes.length < 4) throw new Error("Truncated SPC count");
  const binary = view(bytes);
  const count = binary.getUint32(0, true);
  const payloadOffset = 4 + count * spcEntrySize;
  if (payloadOffset > bytes.length) throw new Error("Truncated SPC entry table");

  const entries: SpcEntry[] = [];
  for (let index = 0; index < count; index++) {
    const entry = 4 + index * spcEntrySize;
    const name = ascii(bytes, entry, 32, true);
    const offset = binary.getUint32(entry + 68, true);
    const length = binary.getUint32(entry + 72, true);
    const start = payloadOffset + offset;
    const end = start + length;
    if (length < 12 || end > bytes.length) throw new Error(`SPC entry ${index} has an invalid payload range`);
    const metadata = bytes.subarray(entry + 32, entry + 68);
    try {
      entries.push({ name, metadata, offset, length, wave: parseWaveSample(bytes.subarray(start, end)) });
    } catch (cause) {
      throw new Error(`Invalid SPC WAVE for entry ${index} "${name}"`, { cause });
    }
  }

  let cursor = 0;
  let leftoverBytes = 0;
  for (const { offset, length } of [...entries].sort((a, b) => a.offset - b.offset)) {
    if (offset < cursor) throw new Error("Overlapping SPC WAVE slices");
    leftoverBytes += offset - cursor;
    cursor = offset + length;
  }
  leftoverBytes += bytes.length - payloadOffset - cursor;
  return { entries, payloadOffset, leftoverBytes };
}

export interface MpcEntry {
  readonly stem: string;
  /** Bytes following the NUL terminator in the fixed-width record. */
  readonly metadata: Uint8Array;
}

export interface MpcIndex {
  readonly declaredCount: number;
  readonly entries: readonly MpcEntry[];
  readonly shortfall: number;
}

export function parseMpc(bytes: Uint8Array, options: { readonly allowShortfall?: boolean } = {}): MpcIndex {
  if (bytes.length < 4) throw new Error("Truncated MPC count");
  const declaredCount = view(bytes).getUint32(0, true);
  const payloadLength = bytes.length - 4;
  if (payloadLength % mpcEntrySize !== 0) throw new Error("Partial MPC entry");
  const present = payloadLength / mpcEntrySize;
  const shortfall = declaredCount - present;
  if (shortfall < 0 || (shortfall > 0 && !options.allowShortfall)) {
    throw new Error(`MPC declares ${declaredCount} entries but contains ${present}`);
  }

  const entries: MpcEntry[] = [];
  for (let index = 0; index < present; index++) {
    const start = 4 + index * mpcEntrySize;
    const end = start + mpcEntrySize;
    const entry = bytes.subarray(start, end);
    const terminator = entry.indexOf(0);
    if (terminator <= 0) throw new Error(`MPC entry ${index} requires a nonempty NUL-terminated stem`);
    entries.push({ stem: ascii(entry, 0, terminator, true), metadata: entry.subarray(terminator + 1) });
  }
  return { declaredCount, entries, shortfall };
}
