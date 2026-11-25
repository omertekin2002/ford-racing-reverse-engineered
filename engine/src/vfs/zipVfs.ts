import { normalizeGamePath, type VirtualFileSystem } from "./types.js";
import { inflate, unpackFr3Resource } from "./zlib.js";

const END_OF_DIRECTORY = 0x06054b50;
const CENTRAL_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;
const ZIP64_SIZE = 0xffffffff;

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const cp437 =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒ" +
  "áíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

function decodeName(bytes: Uint8Array, flags: number): string {
  if (flags & 0x800) return utf8.decode(bytes);
  return Array.from(bytes, byte => byte < 128 ? String.fromCharCode(byte) : cp437[byte - 128]!).join("");
}

const crcTable = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  method: number;
  flags: number;
  crc: number;
  size: number;
  start: number;
  end: number;
}

/** Read single-disk ZIP archives with standard 32-bit directory offsets. */
export class ZipVfs implements VirtualFileSystem {
  private readonly entries = new Map<string, ZipEntry>();
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.readDirectory();
  }

  private u16(offset: number): number {
    return this.view.getUint16(offset, true);
  }

  private u32(offset: number): number {
    return this.view.getUint32(offset, true);
  }

  private readDirectory(): void {
    const end = this.findDirectoryEnd();
    const count = this.u16(end + 10);
    const size = this.u32(end + 12);
    const start = this.u32(end + 16);
    if (this.u16(end + 4) || this.u16(end + 6) || this.u16(end + 8) !== count) {
      throw new Error("Multi-disk ZIP archives are unsupported");
    }
    if (size === ZIP64_SIZE || start === ZIP64_SIZE) {
      throw new Error("ZIP64 directories are unsupported");
    }
    const limit = start + size;
    if (limit > end) throw new Error("ZIP directory exceeds archive bounds");

    let offset = start;
    for (let i = 0; i < count; i++) {
      if (offset + 46 > limit || this.u32(offset) !== CENTRAL_ENTRY) {
        throw new Error(`Invalid ZIP directory entry at ${offset}`);
      }
      const nameLength = this.u16(offset + 28);
      const next = offset + 46 + nameLength + this.u16(offset + 30) + this.u16(offset + 32);
      if (next > limit || this.u16(offset + 34) !== 0) {
        throw new Error(`Invalid ZIP directory entry bounds or disk at ${offset}`);
      }

      const flags = this.u16(offset + 8);
      const name = decodeName(this.bytes.subarray(offset + 46, offset + 46 + nameLength), flags);
      const path = normalizeGamePath(name);
      if (path && !path.endsWith("/")) {
        const entry = this.readEntry(offset, start, name, flags);
        if (this.entries.has(path)) throw new Error(`Duplicate ZIP path: ${path}`);
        this.entries.set(path, entry);
      }
      offset = next;
    }
    // A central-directory digital signature may follow the last file entry.
    if (offset !== limit && (offset + 6 > limit || this.u32(offset) !== 0x05054b50
      || offset + 6 + this.u16(offset + 4) !== limit)) {
      throw new Error("ZIP directory length does not match its entries");
    }
  }

  private findDirectoryEnd(): number {
    const earliest = Math.max(0, this.bytes.length - 22 - 0xffff);
    for (let i = this.bytes.length - 22; i >= earliest; i--) {
      if (this.u32(i) === END_OF_DIRECTORY && i + 22 + this.u16(i + 20) === this.bytes.length) {
        return i;
      }
    }
    throw new Error("ZIP end of central directory is missing");
  }

  private readEntry(offset: number, directoryStart: number, name: string, flags: number): ZipEntry {
    const method = this.u16(offset + 10);
    const crc = this.u32(offset + 16);
    const compressedSize = this.u32(offset + 20);
    const size = this.u32(offset + 24);
    const local = this.u32(offset + 42);
    if ([local, size, compressedSize].includes(ZIP64_SIZE)) {
      throw new Error(`ZIP64 entry is unsupported: ${name}`);
    }
    if (local + 30 > directoryStart || this.u32(local) !== LOCAL_ENTRY
      || this.u16(local + 6) !== flags || this.u16(local + 8) !== method) {
      throw new Error(`Invalid local ZIP header: ${name}`);
    }
    const nameEnd = local + 30 + this.u16(local + 26);
    const start = nameEnd + this.u16(local + 28);
    const end = start + compressedSize;
    if (end > directoryStart
      || decodeName(this.bytes.subarray(local + 30, nameEnd), flags) !== name) {
      throw new Error(`Invalid local ZIP entry bounds or name: ${name}`);
    }
    if (!(flags & 8) && (this.u32(local + 14) !== crc || this.u32(local + 18) !== compressedSize
      || this.u32(local + 22) !== size)) {
      throw new Error(`Local and central ZIP sizes or CRC disagree: ${name}`);
    }
    return { method, flags, crc, size, start, end };
  }

  has(path: string): boolean {
    return this.entries.has(normalizeGamePath(path));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const entry = this.entries.get(normalizeGamePath(path));
    if (!entry) throw new Error(`File not found in ZIP: ${path}`);
    if (entry.flags & 0x2041) throw new Error(`Encrypted ZIP entry: ${path}`);
    const packed = this.bytes.subarray(entry.start, entry.end);
    let bytes: Uint8Array;
    switch (entry.method) {
      case 0:
        bytes = new Uint8Array(packed);
        break;
      case 8:
        bytes = await inflate(packed, "deflate-raw", entry.size);
        break;
      default:
        throw new Error(`Unsupported ZIP compression method ${entry.method}: ${path}`);
    }
    if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) {
      throw new Error(`ZIP entry size or CRC mismatch: ${path}`);
    }
    return bytes;
  }

  async readUnpacked(path: string): Promise<Uint8Array> {
    return unpackFr3Resource(await this.readBytes(path));
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readUnpacked(path));
  }

  list(prefix = ""): string[] {
    const normalized = normalizeGamePath(prefix);
    return [...this.entries.keys()].filter(path => path.startsWith(normalized)).sort();
  }
}
