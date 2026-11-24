export interface VirtualFileSystem {
  /** Case-insensitive lookup accepting both forward and backslashes. */
  has(path: string): boolean;
  /** Read raw file bytes (still compressed if wrapped in FR3's 4-byte-size+zlib header). */
  readBytes(path: string): Promise<Uint8Array>;
  /** Read and automatically inflate FR3's 4-byte-size + zlib wrapper if present. */
  readUnpacked(path: string): Promise<Uint8Array>;
  /** Read UTF-8 / ASCII text. */
  readText(path: string): Promise<string>;
  /** List all known file paths (normalized with forward slashes). */
  list(prefix?: string): string[];
}

export function normalizeGamePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
}
