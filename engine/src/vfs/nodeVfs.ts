import { readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { normalizeGamePath, type VirtualFileSystem } from "./types.js";
import { unpackFr3Resource } from "./zlib.js";

/** Snapshot the file names in a directory for case-insensitive lookup on any host. */
export class NodeVfs implements VirtualFileSystem {
  private constructor(private readonly files: ReadonlyMap<string, string>) {}

  static async open(root: string): Promise<NodeVfs> {
    const files = new Map<string, string>();
    async function index(directory: string, prefix: string): Promise<void> {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        const relative = prefix + entry.name;
        if (entry.isDirectory()) {
          await index(absolute, relative + "/");
        } else if (entry.isFile()) {
          const path = normalizeGamePath(relative);
          if (files.has(path)) throw new Error(`Duplicate filesystem path: ${path}`);
          files.set(path, absolute);
        }
      }
    }
    await index(resolve(root), "");
    return new NodeVfs(files);
  }

  has(path: string): boolean {
    return this.files.has(normalizeGamePath(path));
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const absolute = this.files.get(normalizeGamePath(path));
    if (!absolute) throw new Error(`File not found: ${path}`);
    return readFile(absolute);
  }

  async readUnpacked(path: string): Promise<Uint8Array> {
    return unpackFr3Resource(await this.readBytes(path));
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readUnpacked(path));
  }

  list(prefix = ""): string[] {
    const normalized = normalizeGamePath(prefix);
    return [...this.files.keys()].filter(path => path.startsWith(normalized)).sort();
  }
}
