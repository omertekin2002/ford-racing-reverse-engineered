import { decodeTextureMip, type TextureRecord } from "../formats/dxt.js";
import type { FontAtlas } from "../formats/fonts.js";
import { decodePcgEntryRgba, type PcgEntry } from "../formats/pcg.js";

type GLResource = WebGLBuffer | WebGLVertexArrayObject | WebGLProgram | WebGLTexture;

/** Shared owner for the renderers' WebGL resources. */
export class GlContext {
  readonly gl: WebGL2RenderingContext;
  readonly s3tc: WEBGL_compressed_texture_s3tc | null;
  private readonly resources = new Map<GLResource, () => void>();
  private disposed = false;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext("webgl2", {
      alpha: false, antialias: true, depth: true, powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 is unavailable");
    this.gl = gl;
    this.s3tc = gl.getExtension("WEBGL_compressed_texture_s3tc");
  }

  private own<T extends GLResource>(resource: T | null, destroy: (value: T) => void): T {
    if (!resource) throw new Error("Could not allocate a WebGL resource");
    if (this.disposed) {
      destroy(resource);
      throw new Error("WebGL context owner has been disposed");
    }
    this.resources.set(resource, () => destroy(resource));
    return resource;
  }

  createBuffer(): WebGLBuffer {
    return this.own(this.gl.createBuffer(), value => this.gl.deleteBuffer(value));
  }

  createVertexArray(): WebGLVertexArrayObject {
    return this.own(this.gl.createVertexArray(), value => this.gl.deleteVertexArray(value));
  }

  release(resource: GLResource): void {
    this.resources.get(resource)?.();
    this.resources.delete(resource);
  }

  dispose(): void {
    for (const destroy of this.resources.values()) destroy();
    this.resources.clear();
    this.disposed = true;
  }

  createProgram(vertexSource: string, fragmentSource: string): WebGLProgram {
    const gl = this.gl;
    const compile = (stage: number, source: string): WebGLShader => {
      const shader = gl.createShader(stage);
      if (!shader) throw new Error("Could not allocate a WebGL shader");
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`GLSL ${stage === gl.VERTEX_SHADER ? "vertex" : "fragment"} compilation failed: ${log}`);
    };

    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    let fragment: WebGLShader | undefined;
    let program: WebGLProgram | undefined;
    try {
      fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
      program = this.own(gl.createProgram(), value => {
        if (gl.getParameter(gl.CURRENT_PROGRAM) === value) gl.useProgram(null);
        gl.deleteProgram(value);
      });
      gl.attachShader(program, vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`GLSL program link failed: ${gl.getProgramInfoLog(program)}`);
      }
      gl.detachShader(program, vertex);
      gl.detachShader(program, fragment);
      return program;
    } catch (error) {
      if (program) this.release(program);
      throw error;
    } finally {
      gl.deleteShader(vertex);
      if (fragment) gl.deleteShader(fragment);
    }
  }

  private upload(levels: number, repeat: boolean, nearest: boolean, write: () => void): WebGLTexture {
    const gl = this.gl;
    const previous = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
    const pbo = gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING) as WebGLBuffer | null;
    const stores = [gl.UNPACK_ALIGNMENT, gl.UNPACK_ROW_LENGTH, gl.UNPACK_SKIP_PIXELS, gl.UNPACK_SKIP_ROWS];
    const pixelStore = stores.map(name => gl.getParameter(name) as number);
    const texture = this.own(gl.createTexture(), value => gl.deleteTexture(value));
    try {
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      stores.forEach((name, i) => gl.pixelStorei(name, i === 0 ? 1 : 0));
      gl.bindTexture(gl.TEXTURE_2D, texture);
      const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels - 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, nearest ? gl.NEAREST : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
        levels > 1 ? gl.LINEAR_MIPMAP_LINEAR : nearest ? gl.NEAREST : gl.LINEAR);
      write();
      return texture;
    } catch (error) {
      this.release(texture);
      throw error;
    } finally {
      gl.bindTexture(gl.TEXTURE_2D, previous);
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, pbo);
      stores.forEach((name, i) => gl.pixelStorei(name, pixelStore[i]!));
    }
  }

  uploadTexture(record: TextureRecord): WebGLTexture | null {
    if (record.kind === "reference") return null;
    const gl = this.gl;
    const extension = this.s3tc;
    // The extension requires block-aligned top-level dimensions.
    const top = record.mips[0];
    if (!top) throw new Error(`Texture ${record.name} has no mip levels`);
    const isCompressedStorage = record.storage === "dxt1" || record.storage === "dxt3";
    const compressed = extension && isCompressedStorage && top.width % 4 === 0 && top.height % 4 === 0
      && record.mips.every(({ width, height }) => (width <= 2 || width % 4 === 0) && (height <= 2 || height % 4 === 0));
    return this.upload(record.mips.length, (record.flags & 0x200) === 0, false, () => {
      record.mips.forEach(({ width, height, data }, level) => {
        if (compressed) {
          const format = record.storage === "dxt3" ? extension.COMPRESSED_RGBA_S3TC_DXT3_EXT
            : extension.COMPRESSED_RGBA_S3TC_DXT1_EXT;
          gl.compressedTexImage2D(gl.TEXTURE_2D, level, format, width, height, 0, data);
        } else {
          this.writeRgba(level, width, height, decodeTextureMip(record, level));
        }
      });
    });
  }

  private writeRgba(level: number, width: number, height: number, rgba: Uint8Array): void {
    const gl = this.gl;
    gl.texImage2D(gl.TEXTURE_2D, level, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  }

  uploadRgba(width: number, height: number, rgba: Uint8Array, nearest = false): WebGLTexture {
    return this.upload(1, false, nearest, () => this.writeRgba(0, width, height, rgba));
  }

  uploadPcg(entry: PcgEntry): WebGLTexture {
    return this.uploadRgba(entry.storedWidth, entry.storedHeight, decodePcgEntryRgba(entry));
  }

  uploadFont(atlas: FontAtlas): WebGLTexture {
    return this.uploadRgba(atlas.width, atlas.height, atlas.rgba, true);
  }
}
