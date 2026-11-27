import { normalizeGamePath, type VirtualFileSystem } from "./types.js";
import { unpackFr3Resource } from "./zlib.js";

export interface HttpVfsManifest {
  readonly version?: number;
  readonly baseUrl?: string;
  readonly files: readonly (string | { readonly path: string })[];
}

export interface HttpVfsOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly onProgress?: (fraction: number, status: string) => void;
}

function encodeRelativePath(relativePath: string): string {
  return relativePath
    .split("/")
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join("/");
}

function resolveBaseUrl(manifestUrl: string, baseUrl: string | undefined): string {
  const base = baseUrl && baseUrl.trim() ? baseUrl.trim() : ".";
  const normalizedBase = base.endsWith("/") ? base : `${base}/`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(manifestUrl)) {
    return new URL(normalizedBase, manifestUrl).href;
  }
  const slash = manifestUrl.lastIndexOf("/");
  const manifestDir = slash >= 0 ? manifestUrl.slice(0, slash + 1) : "";
  if (normalizedBase === "./") return manifestDir;
  if (normalizedBase.startsWith("/")) return normalizedBase;
  const joined = `${manifestDir}${normalizedBase}`;
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.length ? `${parts.join("/")}/` : "";
}

/** On-demand HTTP VirtualFileSystem backed by a precomputed game-manifest.json index. */
export class HttpVfs implements VirtualFileSystem {
  private readonly cache = new Map<string, Promise<Uint8Array>>();

  private constructor(
    private readonly baseUrl: string,
    private readonly files: ReadonlyMap<string, string>,
    private readonly fetchImpl: typeof globalThis.fetch,
  ) {}

  static async open(manifestUrl: string, options: HttpVfsOptions = {}): Promise<HttpVfs> {
    const rawFetch = options.fetch ?? globalThis.fetch;
    if (typeof rawFetch !== "function") {
      throw new Error("HTTP asset loading requires fetch()");
    }
    // Browsers reject window.fetch when invoked with an HttpVfs instance as `this` (Illegal invocation).
    const fetchImpl: typeof globalThis.fetch = rawFetch === globalThis.fetch
      ? (input, init) => rawFetch.call(globalThis, input, init)
      : (input, init) => rawFetch(input, init);
    options.onProgress?.(0.05, "Loading game file manifest");
    const response = await fetchImpl(manifestUrl);
    if (!response.ok) {
      throw new Error(`Could not load game manifest ${manifestUrl} (HTTP ${response.status})`);
    }
    const raw: unknown = await response.json();
    const manifest: HttpVfsManifest = Array.isArray(raw)
      ? { files: raw }
      : (raw && typeof raw === "object" && Array.isArray((raw as HttpVfsManifest).files))
        ? raw as HttpVfsManifest
        : (() => { throw new Error(`Invalid game manifest format at ${manifestUrl}`); })();

    const files = new Map<string, string>();
    for (const entry of manifest.files) {
      const relative = typeof entry === "string" ? entry : entry?.path;
      if (typeof relative !== "string" || !relative) continue;
      const cleaned = relative.replace(/\\/g, "/").replace(/^\/+/, "");
      const key = normalizeGamePath(cleaned);
      if (key && !key.endsWith("/")) files.set(key, cleaned);
    }
    if (files.size === 0) {
      throw new Error(`Game manifest at ${manifestUrl} lists no files`);
    }
    options.onProgress?.(0.2, `Indexed ${files.size} game files`);
    return new HttpVfs(resolveBaseUrl(manifestUrl, manifest.baseUrl), files, fetchImpl);
  }

  has(path: string): boolean {
    return this.files.has(normalizeGamePath(path));
  }

  readBytes(path: string): Promise<Uint8Array> {
    const key = normalizeGamePath(path);
    const relative = this.files.get(key);
    if (!relative) return Promise.reject(new Error(`File not found in manifest: ${path}`));
    let pending = this.cache.get(key);
    if (!pending) {
      const url = `${this.baseUrl}${encodeRelativePath(relative)}`;
      const fetchImpl = this.fetchImpl;
      pending = (async () => {
        const response = await fetchImpl(url);
        if (!response.ok) throw new Error(`Could not fetch ${relative} (HTTP ${response.status})`);
        return new Uint8Array(await response.arrayBuffer());
      })().catch(error => {
        this.cache.delete(key);
        throw error;
      });
      this.cache.set(key, pending);
    }
    return pending;
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
