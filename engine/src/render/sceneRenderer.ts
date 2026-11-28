import type { TextureArchive } from "../formats/dxt.js";
import type { BinInfo, MeshPartGeometry, MeshSlot, SceneChild, SceneDatabase, SceneRoot } from "../formats/xbx.js";
import {
  clamp, fromEulerYXZ, identity, invert, lookAtLH, mat3NormalFromMat4, multiply, perspectiveLH, transformPoint,
  type Mat4, type Vec3,
} from "../math/mat4.js";
import { GlContext } from "./glContext.js";

type XbxModel = readonly MeshSlot<MeshPartGeometry>[];
type Rgb = readonly [number, number, number];
type Rgba = readonly [number, number, number, number];
export type RenderPass = "opaque" | "cutout" | "alpha" | "shadow";
export interface ViewportRect { x: number; y: number; width: number; height: number }
export interface Bounds { min: Vec3; max: Vec3 }

export interface ModelNode {
  id: number;
  name: string;
  aliases: readonly string[];
  parent: number | null;
  meshSlotId: number;
  localTransform: Mat4;
  worldTransform: Mat4;
}

export interface RenderMaterial {
  textureIndex: number | null;
  detailTextureIndex: number | null;
  darkTextureIndex?: number;
  colour: Rgba;
  prelit: boolean;
  shine: number;
  pass: RenderPass;
  additive?: boolean;
}
export interface GeometryBatch {
  nodeId: number;
  material: RenderMaterial;
  firstIndex: number;
  indexCount: number;
  center: Vec3;
  halfExtent: Vec3;
}
export interface CompiledGeometry {
  /** Interleaved position, normal, RGBA, UV0 and UV1 in that order. */
  vertices: Float32Array;
  /** Separate UVs for the subtractive stage when present. */
  darkUvs?: Float32Array;
  indices: Uint32Array;
  batches: GeometryBatch[];
  nodes: ModelNode[];
  subObjects: ReadonlyMap<string, readonly ModelNode[]>;
  bounds: Bounds;
}
export interface CompileOptions {
  rootNames?: readonly string[];
  livery?: string | number;
}

const STRIDE = 14;
const WHITE: Rgba = [1, 1, 1, 1];
const LIGHTS = /^(HEADLIGHTS|BRAKE_LIGHTS|REVERSE_LIGHTS)_(ON|OFF)$/;
const WHEEL = /^WHEEL_(FRONT|BACK)_(LEFT|RIGHT)$/;
const HUB = /^HUB_(FRONT|BACK)_(LEFT|RIGHT)$/;
const EXHAUST = /^(LEFT|RIGHT)_EXHAUST_/;

function pose(values: ArrayLike<number>): Mat4 {
  // Attachment records contain XYZ translation followed by yaw, pitch and roll.
  const matrix = fromEulerYXZ(values[3]!, values[4]!, values[5]!);
  matrix[12] = values[0]!;
  matrix[13] = values[1]!;
  matrix[14] = values[2]!;
  return matrix;
}

function expandBounds(bounds: Bounds, point: Readonly<Vec3>): void {
  for (const axis of [0, 1, 2] as const) {
    bounds.min[axis] = Math.min(bounds.min[axis], point[axis]);
    bounds.max[axis] = Math.max(bounds.max[axis], point[axis]);
  }
}

function emptyBounds(): Bounds {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

function centerOf({ min, max }: Bounds): Vec3 {
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

function decodeArgb(word: number): Rgba {
  return [(word >>> 16 & 255) / 255, (word >>> 8 & 255) / 255, (word & 255) / 255, (word >>> 24) / 255];
}

function textureSelectors(archive: TextureArchive, livery: number): (index: number | null) => number | null {
  const defaults = new Map<string, number>();
  const variants = new Map<string, number>();
  for (const [i, texture] of archive.textures.entries()) {
    if (texture.kind === "reference") continue;
    const name = texture.name.toUpperCase();
    const variantId = texture.flags >>> 24;
    if (variantId === 0) {
      if (!defaults.has(name) || (texture.flags & 0xff0000) !== 0) defaults.set(name, i);
    } else if (variantId === livery) {
      variants.set(name, i);
    }
  }

  return index => {
    if (index === null) return null;
    const texture = archive.textures[index];
    if (!texture) return null;
    const name = texture.name.toUpperCase();
    if (texture.kind === "reference") return variants.get(name) ?? defaults.get(name) ?? null;
    if (livery > 0) {
      // fr3.exe (0x43db54) stores the variant count in bits 16..23 and matches bits 24..31 against the livery index.
      const variantCount = (texture.flags >>> 16) & 0xff;
      for (let offset = 1; offset <= variantCount && index + offset < archive.textures.length; offset++) {
        const candidate = archive.textures[index + offset];
        if (candidate?.kind === "texture" && (candidate.flags >>> 24) === livery
          && candidate.name.toUpperCase() === name) {
          return index + offset;
        }
      }
      const byName = variants.get(name);
      if (byName !== undefined) return byName;
    }
    return index;
  };
}

/** Compile parsed meshes without DOM or WebGL dependencies. Select a root by name to place individual props. */
export function compileModelGeometry(
  model: XbxModel, archive: TextureArchive, names: BinInfo, scene: SceneDatabase, options: CompileOptions = {},
): CompiledGeometry {
  const requestedLivery = options.livery;
  const livery = typeof requestedLivery === "string"
    ? names.textureLiveries.findIndex(name => name.toUpperCase() === requestedLivery.toUpperCase())
    : requestedLivery ?? 0;
  const selectTexture = textureSelectors(archive, livery);
  const nodes: ModelNode[] = [];
  const subObjects = new Map<string, ModelNode[]>();
  const batches: GeometryBatch[] = [];
  const vertices: number[] = [];
  let darkUvs: number[] | undefined;
  const indices: number[] = [];
  const bounds = emptyBounds();

  function addNode(
    meshSlotId: number, parent: ModelNode | null, localTransform: Mat4, aliases: string[], shadow: boolean,
  ): ModelNode {
    const worldTransform = parent ? multiply(parent.worldTransform, localTransform) : localTransform;
    const node: ModelNode = {
      id: nodes.length, parent: parent?.id ?? null, meshSlotId, localTransform, worldTransform,
      aliases, name: aliases[0] ?? `mesh:${meshSlotId}`,
    };
    nodes.push(node);
    for (const alias of new Set(aliases)) {
      const handles = subObjects.get(alias) ?? [];
      handles.push(node);
      subObjects.set(alias, handles);
    }
    const mesh = model[meshSlotId];
    if (!mesh || meshSlotId === 0) return node;

    const groups = new Map<string, { material: RenderMaterial; parts: MeshPartGeometry[] }>();
    for (const [groupIndex, group] of mesh.groups.entries()) {
      for (const part of group) {
        if (!part.indices.length) continue;
        let extra = (part.g & 8 ? 5 : 0) + (part.g & 1);
        const colour = part.primaryTexture === null || part.f & 6
          ? decodeArgb(part.descriptorExtension[extra++] ?? 0xffffffff) : WHITE;
        const shine = part.f & 8 ? (part.descriptorExtension[extra++]! >>> 24) / 255 : 0;
        if (part.f & 16) extra++;
        // fr3.exe's prelit renderer uses SUBTRACT for 0x80 (0x457d33)
        // and BLENDTEXTUREALPHA for 0x40 (0x457dd7), in that order.
        const darkLayer = part.f & 0x80 ? part.descriptorExtension[extra++] : undefined;
        const detailLayer = part.f & 0x40 ? part.descriptorExtension[extra] : undefined;
        const darkTextureIndex = darkLayer !== undefined && part.uv1 ? selectTexture(darkLayer >>> 16) : null;
        const detailUvs = part.f & 0x80 ? part.uv2 : part.uv1;
        const detailTextureIndex = detailLayer !== undefined && detailUvs ? selectTexture(detailLayer >>> 16) : null;
        const textureIndex = selectTexture(part.primaryTexture);
        const record = textureIndex === null ? undefined : archive.textures[textureIndex];
        const textureClass = record?.kind === "texture" ? record.formatClass : 1;
        const prelit = Boolean(part.g & 4) || (part.g & 0x30) === 0 && part.colors[3] !== 0;
        // fr3.exe sets both framebuffer blend factors to ONE for this flag (0x45629b).
        const additive = !shadow && Boolean(part.f & 1);
        const pass: RenderPass = shadow ? "shadow"
          : additive || groupIndex > 0 || textureClass === 3 || colour[3] < 1 ? "alpha"
          : textureClass === 2 ? "cutout" : "opaque";
        const material = { textureIndex, detailTextureIndex, colour, shine, prelit, pass,
          ...(darkTextureIndex !== null && { darkTextureIndex }), ...(additive && { additive }) };
        const key = JSON.stringify(material);
        const entry = groups.get(key) ?? { material, parts: [] };
        entry.parts.push(part);
        groups.set(key, entry);
      }
    }

    for (const { material, parts } of groups.values()) {
      const firstIndex = indices.length;
      const localBounds = emptyBounds();
      const point: Vec3 = [0, 0, 0];
      const world: Vec3 = [0, 0, 0];
      for (const part of parts) {
        const base = vertices.length / STRIDE;
        const detail = part.f & 0x80 ? part.uv2 : part.uv1;
        const dark = material.darkTextureIndex === undefined ? undefined : part.uv1;
        if (dark && !darkUvs) darkUvs = new Array<number>(base * 2).fill(0);
        for (let v = 0; v < part.vertexCount; v++) {
          const p = v * 3, c = v * 4, uv = v * 2;
          point[0] = part.positions[p]!;
          point[1] = part.positions[p + 1]!;
          point[2] = part.positions[p + 2]!;
          expandBounds(localBounds, point);
          if (!shadow) expandBounds(bounds, transformPoint(worldTransform, point, world));
          vertices.push(...point, part.normals[p]!, part.normals[p + 1]!, part.normals[p + 2]!,
            part.colors[c]! / 255, part.colors[c + 1]! / 255, part.colors[c + 2]! / 255, part.colors[c + 3]! / 255,
            part.uv0?.[uv] ?? 0, part.uv0?.[uv + 1] ?? 0, detail?.[uv] ?? 0, detail?.[uv + 1] ?? 0);
          darkUvs?.push(dark?.[uv] ?? 0, dark?.[uv + 1] ?? 0);
        }
        for (const index of part.indices) indices.push(base + index);
      }
      const { min, max } = localBounds;
      batches.push({
        nodeId: node.id, material, firstIndex, indexCount: indices.length - firstIndex, center: centerOf(localBounds),
        halfExtent: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
      });
    }
    return node;
  }

  function childNames(pairs: SceneChild["pairs"], child: number): string[] {
    return pairs.flatMap(([nameIndex, childIndex]) => {
      const name = names.subObjects[nameIndex];
      return childIndex === child && name ? [name.toUpperCase()] : [];
    });
  }

  function visitChild(child: SceneChild, parent: ModelNode, aliases: string[], shadow: boolean): void {
    const node = addNode(child.meshSlotId, parent, pose(child.transform), aliases, shadow);
    child.children.forEach((nested, index) => visitChild(nested, node, childNames(child.pairs, index), shadow));
  }

  function visitRoot(root: SceneRoot, parent: ModelNode | null, transform: Mat4, ancestors: ReadonlySet<number>): void {
    if (ancestors.has(root.shapeId)) throw new Error(`Cyclic XBX scene reference at shape ${root.shapeId}`);
    const name = names.shapes[root.shapeId]?.toUpperCase() ?? `SHAPE:${root.shapeId}`;
    const shadow = name.endsWith("_SHADOW");
    const node = addNode(root.meshSlotId, parent, transform, [name], shadow);

    if (root.children.kind === "inline") {
      const children = root.lodValues.length > 1 ? root.children.nodes.slice(0, 1) : root.children.nodes;
      children.forEach((child, index) => {
        const aliases = childNames(root.meshPairs, index);
        if (index === 0 && root.lodValues.length > 1 && !shadow && children[0]?.pairs.length) aliases.push("BODY");
        visitChild(child, node, aliases, shadow);
      });
    } else {
      const refs = root.lodValues.length > 1 ? root.children.references.subarray(0, 1) : root.children.references;
      refs.forEach((meshId, index) => {
        if (meshId) addNode(meshId, node, identity(), childNames(root.meshPairs, index), shadow);
      });
    }

    if (!root.secondaryRecords.length) return;
    const chain = new Set(ancestors).add(root.shapeId);
    for (const record of root.secondaryRecords) {
      const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
      const target = scene.roots[view.getUint32(0, true)];
      if (!target) continue;
      // Cut-up sector vertices already include the XBX slot's X/Z origin.
      const local = name.endsWith("_CUT_UP") ? identity()
        : pose(Float32Array.from([
          view.getFloat32(8, true), view.getFloat32(12, true), view.getFloat32(16, true),
          -view.getFloat32(20, true), -view.getFloat32(24, true), -view.getFloat32(28, true),
        ]));
      visitRoot(target, node, local, chain);
    }
  }

  const requested = options.rootNames?.map(name => name.toUpperCase());
  const cutUp = names.shapes.find(name => name.toUpperCase().endsWith("_CUT_UP"));
  const defaults = cutUp ? [cutUp.toUpperCase(), cutUp.toUpperCase().replace(/_CUT_UP$/, "_OBJECTS")] : undefined;
  const active = requested ?? defaults;
  for (const root of scene.roots) {
    const name = names.shapes[root.shapeId]?.toUpperCase();
    if (!active || name && active.includes(name)) visitRoot(root, null, identity(), new Set());
  }
  const modelBounds = Number.isFinite(bounds.min[0]) ? bounds : { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 };
  return {
    vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices), batches, nodes, subObjects, bounds: modelBounds,
    ...(darkUvs && { darkUvs: Float32Array.from(darkUvs) }),
  };
}

const MESH_VERTEX = `#version 300 es
layout(location=0) in vec3 position;
layout(location=1) in vec3 normal;
layout(location=2) in vec4 color;
layout(location=3) in vec2 uv0;
layout(location=4) in vec2 uv1;
layout(location=5) in vec2 darkUv;
uniform mat4 model, view, projection;
uniform mat3 normalMatrix;
uniform bool projectShadow;
uniform float groundY;
out vec3 worldPosition, worldNormal;
out vec4 vertexColor;
out vec2 baseUV, detailUV, darkUV;
out float depth;
void main() {
  vec4 world = model * vec4(position, 1.0);
  if (projectShadow) world.y = groundY;
  vec4 eye = view * world;
  gl_Position = projection * eye;
  worldPosition = world.xyz;
  worldNormal = normalMatrix * normal;
  vertexColor = color;
  baseUV = uv0;
  detailUV = uv1;
  darkUV = darkUv;
  depth = eye.z;
}`;

function meshFragment(vehicle: boolean): string {
  return `#version 300 es
precision highp float;
#define VEHICLE ${vehicle ? 1 : 0}
in vec3 worldPosition, worldNormal;
in vec4 vertexColor;
in vec2 baseUV, detailUV, darkUV;
in float depth;
uniform sampler2D baseTexture, detailTexture, darkTexture;
uniform bool prelit, hasDetail, hasDark, projectShadow, additive;
uniform vec4 colour;
uniform vec3 camera, sun, tint, emissive, fogColour;
uniform float cutoff, shine;
uniform vec4 fogRange;
out vec4 pixel;
void main() {
  vec4 base = texture(baseTexture, baseUV) * colour;
  if (projectShadow) {
    pixel = vec4(0.03, 0.03, 0.04, base.a * 0.56);
    return;
  }
  if (prelit) base *= vertexColor;
  if (base.a <= cutoff) discard;
  if (hasDark) base.rgb = max(vec3(0.0), base.rgb - texture(darkTexture, darkUV).rgb);
  if (hasDetail) {
    vec4 detail = texture(detailTexture, detailUV);
    base.rgb = mix(base.rgb, detail.rgb, detail.a);
  }
  vec3 n = length(worldNormal) > 0.001 ? normalize(worldNormal) : vec3(0.0, 1.0, 0.0);
  float diffuse = max(0.0, dot(n, sun));
  vec3 hemi = mix(vec3(0.28, 0.25, 0.21), vec3(0.62, 0.68, 0.78), n.y * 0.5 + 0.5);
  vec3 lit = base.rgb * (prelit ? vec3(1.0) : hemi + diffuse * vec3(0.57, 0.54, 0.48));
#if VEHICLE
  vec3 toEye = normalize(camera - worldPosition);
  vec3 reflected = reflect(-toEye, n);
  float facing = max(0.0, dot(n, toEye));
  float fresnel = 0.08 + 0.58 * pow(1.0 - facing, 4.0);
  vec3 skyReflection = mix(fogColour, vec3(0.48, 0.68, 0.93), smoothstep(-0.08, 0.78, reflected.y));
  float specular = pow(max(0.0, dot(n, normalize(sun + toEye))), mix(16.0, 96.0, shine));
  lit = lit * mix(vec3(1.0), tint, smoothstep(0.0, 0.35, shine));
  lit = mix(lit, skyReflection, shine * fresnel) + vec3(specular * shine) + emissive * base.rgb;
#endif
  float travel = max(0.0, depth - fogRange.x);
  float extent = max(fogRange.y - fogRange.x, 0.001);
  float haze = fogRange.w > 0.5 ? 1.0 - exp(-fogRange.z * travel / extent)
    : fogRange.z * clamp(travel / extent, 0.0, 1.0);
  pixel = vec4(mix(lit, additive ? vec3(0.0) : fogColour, clamp(haze, 0.0, 1.0)), base.a);
}`;
}

const SKY_VERTEX = `#version 300 es
out vec2 ndc;
void main() {
  ndc = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  gl_Position = vec4(ndc, 1.0, 1.0);
}`;
const SKY_FRAGMENT = `#version 300 es
precision highp float;
in vec2 ndc;
uniform mat4 inverseViewProjection;
uniform vec3 camera, horizon, zenith;
out vec4 pixel;
void main() {
  vec4 farPoint = inverseViewProjection * vec4(ndc, 1.0, 1.0);
  vec3 ray = normalize(farPoint.xyz - camera * farPoint.w);
  pixel = vec4(mix(horizon, zenith, smoothstep(-0.035, 0.72, ray.y)), 1.0);
}`;
const SHADOW_VERTEX = `#version 300 es
uniform mat4 model, viewProjection;
out vec2 uv;
void main() {
  uv = vec2(gl_VertexID & 1, gl_VertexID >> 1) * 2.0 - 1.0;
  gl_Position = viewProjection * model * vec4(uv.x, 0.0, uv.y, 1.0);
}`;
const SHADOW_FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 pixel;
void main() {
  pixel = vec4(0.02, 0.02, 0.03, 0.50 * (1.0 - smoothstep(0.30, 1.0, length(uv))));
}`;

/** RGB read from the environment config, in byte units. */
export type FogConfig = ({ color: Rgb } | { colour: Rgb }) & {
  density: number;
  mode?: "linear" | "exp";
  start?: number;
  end?: number;
  sunDirection?: Rgb;
  skyColor?: Rgb;
};

/** Read a FOG: density r g b directive. */
export function parseFogConfig(config: string): FogConfig | null {
  const fields = /^\s*FOG\s*:\s*([^\r\n]+)/im.exec(config)?.[1]?.trim().split(/\s+/).slice(0, 4).map(Number);
  if (!fields || fields.length < 4 || !fields.every(Number.isFinite)) return null;
  return { density: Math.max(0, fields[0]!), color: [fields[1]!, fields[2]!, fields[3]!] };
}

export class CompiledModel {
  private disposed = false;

  constructor(
    readonly geometry: CompiledGeometry,
    readonly vao: WebGLVertexArrayObject,
    readonly textures: readonly (WebGLTexture | null)[],
    private readonly cleanup: () => void,
  ) {}

  get isDisposed(): boolean { return this.disposed; }
  get bounds(): Bounds { return this.geometry.bounds; }
  get subObjects(): CompiledGeometry["subObjects"] { return this.geometry.subObjects; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cleanup();
  }
}

export interface ModelInstance {
  model: CompiledModel;
  transform?: Mat4;
  /** Additional local poses for named or otherwise animated nodes, keyed by node ID. */
  nodeTransforms?: ReadonlyMap<number, Mat4>;
  hiddenNodes?: ReadonlySet<number>;
}
export interface CarInstance extends ModelInstance {
  wheelSpeed?: number;
  wheelMovingThreshold?: number;
  wheelSpin?: number;
  steeringAngle?: number;
  headlights?: boolean;
  braking?: boolean;
  reversing?: boolean;
  paintTint?: Rgb;
  exhaust?: boolean;
  /** World-space ground height under the car. */
  groundY?: number;
}

function matrixHandedness(m: Mat4): number {
  const a = m[0]!, b = m[4]!, c = m[8]!;
  return a * (m[5]! * m[10]! - m[9]! * m[6]!) - b * (m[1]! * m[10]! - m[9]! * m[2]!)
    + c * (m[1]! * m[6]! - m[5]! * m[2]!);
}

function frustumPlanes(matrix: Mat4): Rgba[] {
  const planes: Rgba[] = [];
  // Clip-space limits are -w <= x, y, z <= w.
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [1, -1]) {
      planes.push([
        matrix[3]! + sign * matrix[axis]!, matrix[7]! + sign * matrix[axis + 4]!,
        matrix[11]! + sign * matrix[axis + 8]!, matrix[15]! + sign * matrix[axis + 12]!,
      ]);
    }
  }
  return planes;
}

function outsideFrustum(planes: readonly Rgba[], world: Mat4, center: Vec3, halfExtent: Vec3): boolean {
  for (const [x, y, z, w] of planes) {
    const distance = x * center[0] + y * center[1] + z * center[2] + w;
    const radius = Math.abs(x * world[0]! + y * world[1]! + z * world[2]!) * halfExtent[0]
      + Math.abs(x * world[4]! + y * world[5]! + z * world[6]!) * halfExtent[1]
      + Math.abs(x * world[8]! + y * world[9]! + z * world[10]!) * halfExtent[2];
    if (distance < -radius) return true;
  }
  return false;
}

function byteRgb(rgb: Rgb): Rgb {
  return [clamp(rgb[0] / 255, 0, 1), clamp(rgb[1] / 255, 0, 1), clamp(rgb[2] / 255, 0, 1)];
}

const DEFAULT_FOG: FogConfig = { density: 0, color: [179, 191, 209] };
const SUN: Rgb = [-0.46, 0.74, -0.49];
const WHITE_RGB: Rgb = [1, 1, 1];
const BLACK: Rgb = [0, 0, 0];
const BASE_TRANSFORM = identity();

const MESH_UNIFORMS = [
  "model", "view", "projection", "normalMatrix", "projectShadow", "groundY", "baseTexture", "detailTexture",
  "prelit", "hasDetail", "colour", "camera", "sun", "tint", "emissive", "fogColour", "cutoff", "shine", "fogRange",
  "additive", "darkTexture", "hasDark",
] as const;
type Pipeline<T extends string> = { program: WebGLProgram; uniforms: Record<T, WebGLUniformLocation | null> };
type MeshPipeline = Pipeline<typeof MESH_UNIFORMS[number]>;
interface SceneDraw {
  model: CompiledModel;
  batch: GeometryBatch;
  transform: Mat4;
  car?: CarInstance;
  emissive: Rgb;
  depth: number;
}

export class SceneRenderer {
  private readonly world: MeshPipeline;
  private readonly vehicle: MeshPipeline;
  private readonly sky: Pipeline<"inverseViewProjection" | "camera" | "horizon" | "zenith">;
  private readonly shadow: Pipeline<"model" | "viewProjection">;
  private readonly white: WebGLTexture;
  private readonly emptyVao: WebGLVertexArrayObject;
  private readonly models = new Set<CompiledModel>();
  private disposed = false;

  constructor(private readonly context: GlContext) {
    const owned: WebGLProgram[] = [];
    try {
      const make = <T extends string>(vertex: string, fragment: string, names: readonly T[]): Pipeline<T> => {
        const program = context.createProgram(vertex, fragment);
        owned.push(program);
        return { program, uniforms: Object.fromEntries(names.map(name =>
          [name, context.gl.getUniformLocation(program, name)])) as Pipeline<T>["uniforms"] };
      };
      this.world = make(MESH_VERTEX, meshFragment(false), MESH_UNIFORMS);
      this.vehicle = make(MESH_VERTEX, meshFragment(true), MESH_UNIFORMS);
      this.sky = make(SKY_VERTEX, SKY_FRAGMENT, ["inverseViewProjection", "camera", "horizon", "zenith"]);
      this.shadow = make(SHADOW_VERTEX, SHADOW_FRAGMENT, ["model", "viewProjection"]);
      this.emptyVao = context.createVertexArray();
      try {
        this.white = context.uploadRgba(1, 1, new Uint8Array([255, 255, 255, 255]));
      } catch (error) {
        context.release(this.emptyVao);
        throw error;
      }
    } catch (error) {
      owned.forEach(program => context.release(program));
      throw error;
    }
  }

  compileModel(model: XbxModel, textures: TextureArchive, names: BinInfo, scene: SceneDatabase, options?: CompileOptions): CompiledModel {
    return this.uploadModel(compileModelGeometry(model, textures, names, scene, options), textures);
  }

  uploadModel(geometry: CompiledGeometry, archive: TextureArchive): CompiledModel {
    if (this.disposed) throw new Error("Scene renderer has been disposed");
    const gl = this.context.gl;
    const vao = this.context.createVertexArray();
    const owned: (WebGLBuffer | WebGLTexture | WebGLVertexArrayObject)[] = [vao];
    const release = () => owned.forEach(resource => this.context.release(resource));
    try {
      const vertexBuffer = this.context.createBuffer();
      owned.push(vertexBuffer);
      const indexBuffer = this.context.createBuffer();
      owned.push(indexBuffer);
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, geometry.vertices, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geometry.indices, gl.STATIC_DRAW);
      let offset = 0;
      [3, 3, 4, 2, 2].forEach((size, location) => {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
        offset += size;
      });
      if (geometry.darkUvs) {
        const darkUvBuffer = this.context.createBuffer();
        owned.push(darkUvBuffer);
        gl.bindBuffer(gl.ARRAY_BUFFER, darkUvBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, geometry.darkUvs, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(5);
        gl.vertexAttribPointer(5, 2, gl.FLOAT, false, 0, 0);
      }
      const textures: (WebGLTexture | null)[] = Array.from({ length: archive.textures.length }, () => null);
      const used = new Set(geometry.batches.flatMap(({ material }) =>
        [material.textureIndex, material.detailTextureIndex, material.darkTextureIndex ?? null]));
      for (const index of used) {
        if (index === null || !archive.textures[index]) continue;
        const texture = this.context.uploadTexture(archive.textures[index]!);
        textures[index] = texture;
        if (texture) owned.push(texture);
      }
      const compiled = new CompiledModel(geometry, vao, textures, () => {
        release();
        this.models.delete(compiled);
      });
      this.models.add(compiled);
      return compiled;
    } catch (error) {
      release();
      throw error;
    } finally {
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const model of this.models) model.dispose();
    for (const pipeline of [this.world, this.vehicle, this.sky, this.shadow]) this.context.release(pipeline.program);
    this.context.release(this.white);
    this.context.release(this.emptyVao);
  }

  private collect(
    instance: ModelInstance, view: Mat4, planes: readonly Rgba[], draws: SceneDraw[], car?: CarInstance,
  ): void {
    const { model } = instance;
    if (model.isDisposed) return;
    const { nodes, batches, subObjects } = model.geometry;
    const transforms: (Mat4 | undefined)[] = [];
    const emissions: Rgb[] = [];
    const steered: boolean[] = [];
    const moving = Math.abs(car?.wheelSpeed ?? 0) >= (car?.wheelMovingThreshold ?? 12);
    const hasWheelAlternative = subObjects.has("WHEEL_STATIC") && subObjects.has("WHEEL_MOVING");
    const rootMatrix = instance.transform ?? BASE_TRANSFORM;
    const useStaticPoses = !car && rootMatrix === BASE_TRANSFORM && !instance.nodeTransforms;
    for (const node of nodes) {
      const parent = node.parent === null ? rootMatrix : transforms[node.parent];
      if (!parent || instance.hiddenNodes?.has(node.id)) continue;
      let local = node.localTransform;
      let emissive = node.parent === null ? BLACK : emissions[node.parent] ?? BLACK;
      let parentSteered = node.parent !== null && Boolean(steered[node.parent]);
      if (car) {
        const name = node.name;
        if (hasWheelAlternative && (name === "WHEEL_STATIC" && moving || name === "WHEEL_MOVING" && !moving)) continue;
        if (EXHAUST.test(name) && !car.exhaust) continue;
        const light = LIGHTS.exec(name);
        if (light) {
          const enabled = light[1] === "HEADLIGHTS" ? car.headlights : light[1] === "BRAKE_LIGHTS" ? car.braking : car.reversing;
          const on = light[2] === "ON";
          const opposite = `${light[1]}_${on ? "OFF" : "ON"}`;
          if (Boolean(enabled) !== on && subObjects.has(opposite)) continue;
          if (on && enabled) emissive = light[1] === "BRAKE_LIGHTS" ? [1.1, 0.15, 0.07] : [0.85, 0.81, 0.65];
        }
        if (WHEEL.test(name) || HUB.test(name)) {
          const spin = WHEEL.test(name) ? car.wheelSpin ?? 0 : 0;
          const steer = !parentSteered && name.includes("_FRONT_") ? car.steeringAngle ?? 0 : 0;
          if (spin || steer) local = multiply(local, fromEulerYXZ(steer, spin, 0));
          parentSteered ||= steer !== 0;
        }
      }
      const override = instance.nodeTransforms?.get(node.id);
      if (override) local = multiply(local, override);
      transforms[node.id] = useStaticPoses ? node.worldTransform : multiply(parent, local);
      emissions[node.id] = emissive;
      steered[node.id] = parentSteered;
    }
    const center: Vec3 = [0, 0, 0];
    for (const batch of batches) {
      const transform = transforms[batch.nodeId];
      if (!transform || batch.material.pass === "shadow" && !car) continue;
      transformPoint(transform, batch.center, center);
      if (batch.material.pass !== "shadow" && outsideFrustum(planes, transform, center, batch.halfExtent)) continue;
      const depth = view[2]! * center[0] + view[6]! * center[1] + view[10]! * center[2] + view[14]!;
      draws.push({ model, batch, transform, car, depth, emissive: emissions[batch.nodeId] ?? BLACK });
    }
  }

  /** Render to a pixel rectangle measured from the drawing buffer's top-left corner. */
  renderScene(
    viewMat: Mat4, projMat: Mat4, track: CompiledModel | ModelInstance | readonly ModelInstance[] | null,
    cars: readonly CarInstance[], fogConfig: FogConfig = DEFAULT_FOG, viewport?: ViewportRect,
  ): void {
    const gl = this.context.gl;
    this.drawFrame(viewMat, projMat, track, cars, fogConfig,
      viewport ?? { x: 0, y: 0, width: gl.drawingBufferWidth, height: gl.drawingBufferHeight }, gl.drawingBufferHeight);
  }

  private drawFrame(
    view: Mat4, projection: Mat4, track: CompiledModel | ModelInstance | readonly ModelInstance[] | null,
    cars: readonly CarInstance[], fog: FogConfig, viewport: ViewportRect, canvasHeight: number, sky = true,
  ): void {
    if (this.disposed) throw new Error("Scene renderer has been disposed");
    const gl = this.context.gl;
    const x = Math.round(viewport.x), top = Math.round(viewport.y);
    const width = Math.round(viewport.x + viewport.width) - x;
    const height = Math.round(viewport.y + viewport.height) - top;
    if (width <= 0 || height <= 0) return;
    const y = canvasHeight - top - height;
    const inverseView = invert(view);
    const viewProjection = multiply(projection, view);
    const inverseViewProjection = invert(viewProjection);
    if (!inverseView || !inverseViewProjection) throw new Error("Scene view and projection must be invertible");
    const camera: Vec3 = [inverseView[12]!, inverseView[13]!, inverseView[14]!];
    const viewSign = matrixHandedness(view);
    const horizon = byteRgb("color" in fog ? fog.color : fog.colour);
    const skyColour = byteRgb(fog.skyColor ?? [81, 140, 202]);
    const sun = fog.sunDirection ?? SUN;
    const draws: SceneDraw[] = [];
    const world: readonly ModelInstance[] = !track ? [] : track instanceof CompiledModel ? [{ model: track }]
      : "model" in track ? [track] : track;
    const planes = frustumPlanes(viewProjection);
    for (const instance of world) this.collect(instance, view, planes, draws);
    for (const car of cars) this.collect(car, view, planes, draws, car);

    const sections = { opaque: [] as SceneDraw[], alpha: [] as SceneDraw[], shadow: [] as SceneDraw[] };
    for (const draw of draws) {
      const pass = draw.batch.material.pass;
      sections[pass === "cutout" ? "opaque" : pass].push(draw);
    }
    sections.alpha.sort((a, b) => b.depth - a.depth);

    const previousViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const previousScissor = gl.getParameter(gl.SCISSOR_BOX) as Int32Array;
    const scissorEnabled = gl.isEnabled(gl.SCISSOR_TEST);
    gl.viewport(x, y, width, height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, y, width, height);
    gl.colorMask(true, true, true, true);
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clear(gl.DEPTH_BUFFER_BIT);

    try {
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(this.emptyVao);
      // The sky pass paints every pixel of the viewport; overlays (the CAR.UI turntable) skip it so the UI
      // already drawn underneath stays visible.
      if (sky) {
        gl.useProgram(this.sky.program);
        gl.uniformMatrix4fv(this.sky.uniforms.inverseViewProjection, false, inverseViewProjection);
        gl.uniform3f(this.sky.uniforms.camera, ...camera);
        gl.uniform3f(this.sky.uniforms.horizon, ...horizon);
        gl.uniform3f(this.sky.uniforms.zenith, ...skyColour);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      for (const pipeline of [this.world, this.vehicle]) {
        const u = pipeline.uniforms;
        gl.useProgram(pipeline.program);
        gl.uniformMatrix4fv(u.view, false, view);
        gl.uniformMatrix4fv(u.projection, false, projection);
        gl.uniform3f(u.camera, ...camera);
        const sunLength = Math.hypot(...sun) || 1;
        gl.uniform3f(u.sun, sun[0] / sunLength, sun[1] / sunLength, sun[2] / sunLength);
        gl.uniform3f(u.fogColour, ...horizon);
        gl.uniform4f(u.fogRange, fog.start ?? 45, fog.end ?? 550, fog.density, fog.mode === "exp" ? 1 : 0);
        gl.uniform1i(u.baseTexture, 0);
        gl.uniform1i(u.detailTexture, 1);
        gl.uniform1i(u.darkTexture, 2);
      }

      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      for (const draw of sections.opaque) this.drawMesh(draw, viewSign);

      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.disable(gl.CULL_FACE);
      for (const draw of sections.shadow) this.drawMesh(draw, viewSign);
      const casters = new Set(sections.shadow.map(draw => draw.car));
      for (const car of cars) {
        if (!car.model.isDisposed && !casters.has(car)) this.drawContactShadow(car, viewProjection);
      }

      gl.enable(gl.CULL_FACE);
      let additiveBlend = false;
      for (const draw of sections.alpha) {
        const additive = draw.batch.material.additive === true;
        if (additive !== additiveBlend) {
          if (additive) gl.blendFunc(gl.ONE, gl.ONE);
          else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          additiveBlend = additive;
        }
        this.drawMesh(draw, viewSign);
      }
    } finally {
      gl.depthMask(true);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindVertexArray(null);
      gl.viewport(previousViewport[0]!, previousViewport[1]!, previousViewport[2]!, previousViewport[3]!);
      gl.scissor(previousScissor[0]!, previousScissor[1]!, previousScissor[2]!, previousScissor[3]!);
      if (!scissorEnabled) gl.disable(gl.SCISSOR_TEST);
    }
  }

  private drawMesh({ model, batch, transform, car, emissive }: SceneDraw, viewSign: number): void {
    const gl = this.context.gl;
    const pipeline = car ? this.vehicle : this.world;
    const u = pipeline.uniforms;
    const { material } = batch;
    const normal = mat3NormalFromMat4(transform);
    if (!normal) return;
    gl.useProgram(pipeline.program);
    // Positive-depth views show outward-facing XBX triangles clockwise.
    gl.frontFace(matrixHandedness(transform) * viewSign < 0 ? gl.CCW : gl.CW);
    gl.bindVertexArray(model.vao);
    gl.uniformMatrix4fv(u.model, false, transform);
    gl.uniformMatrix3fv(u.normalMatrix, false, normal);
    gl.uniform1i(u.prelit, Number(material.prelit));
    gl.uniform1i(u.additive, Number(Boolean(material.additive)));
    gl.uniform1i(u.projectShadow, Number(material.pass === "shadow"));
    gl.uniform1f(u.groundY, (car?.groundY ?? car?.transform?.[13] ?? 0) + 0.025);
    gl.uniform4f(u.colour, ...material.colour);
    gl.uniform3f(u.tint, ...(car?.paintTint ?? WHITE_RGB));
    gl.uniform3f(u.emissive, ...emissive);
    gl.uniform1f(u.shine, material.shine);
    gl.uniform1f(u.cutoff, material.pass === "cutout" ? 0.45 : 0);
    const base = material.textureIndex === null ? this.white : model.textures[material.textureIndex] ?? this.white;
    const detail = material.detailTextureIndex === null ? null : model.textures[material.detailTextureIndex];
    const dark = material.darkTextureIndex === undefined ? null : model.textures[material.darkTextureIndex];
    gl.uniform1i(u.hasDetail, Number(Boolean(detail)));
    gl.uniform1i(u.hasDark, Number(Boolean(dark)));
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, base);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, detail ?? this.white);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, dark ?? this.white);
    gl.drawElements(gl.TRIANGLES, batch.indexCount, gl.UNSIGNED_INT, batch.firstIndex * 4);
  }

  private drawContactShadow(car: CarInstance, viewProjection: Mat4): void {
    const gl = this.context.gl;
    const { min, max } = car.model.bounds;
    const model = multiply(car.transform ?? BASE_TRANSFORM, BASE_TRANSFORM);
    const center = transformPoint(model, [(min[0] + max[0]) / 2, 0, (min[2] + max[2]) / 2]);
    const halfWidth = (max[0] - min[0]) * 0.64;
    const halfLength = (max[2] - min[2]) * 0.59;
    model[0] = model[0]! * halfWidth;
    model[2] = model[2]! * halfWidth;
    model[5] = 1;
    model[8] = model[8]! * halfLength;
    model[10] = model[10]! * halfLength;
    model[1] = model[4] = model[6] = model[9] = 0;
    model[12] = center[0];
    model[13] = (car.groundY ?? car.transform?.[13] ?? 0) + 0.025;
    model[14] = center[2];
    gl.useProgram(this.shadow.program);
    gl.bindVertexArray(this.emptyVao);
    gl.uniformMatrix4fv(this.shadow.uniforms.model, false, model);
    gl.uniformMatrix4fv(this.shadow.uniforms.viewProjection, false, viewProjection);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Render the car within a normalized UI rectangle over the UI already in the framebuffer: only depth is cleared
   * in the viewport and no sky/colour pass runs, so the `CAR.PSD` background shows around the car and pixels
   * outside the rectangle stay intact. `clearColor` restores the old opaque sky-filled box.
   */
  renderCarTurntable(
    carModel: CompiledModel, angleRad: number, viewportRect: ViewportRect, canvasWidth: number, canvasHeight: number,
    clearColor = false,
  ): void {
    const rect = {
      x: viewportRect.x * canvasWidth, y: viewportRect.y * canvasHeight,
      width: viewportRect.width * canvasWidth, height: viewportRect.height * canvasHeight,
    };
    if (rect.width <= 0 || rect.height <= 0) return;
    const { min, max } = carModel.bounds;
    const center = centerOf(carModel.bounds);
    const radius = Math.max(0.1, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    const fov = 1.13446;
    const aspect = rect.width / rect.height;
    const halfAngle = Math.min(fov / 2, Math.atan(Math.tan(fov / 2) * aspect));
    const distance = radius * 1.1 / Math.sin(halfAngle);
    const view = lookAtLH(
      [center[0], center[1] + 0.29 * distance, center[2] - 0.957 * distance], center, [0, 1, 0],
    );
    const rotation = fromEulerYXZ(angleRad, 0, 0);
    const rotated = transformPoint(rotation, center);
    rotation[12] = center[0] - rotated[0];
    rotation[14] = center[2] - rotated[2];
    this.drawFrame(view, perspectiveLH(fov, aspect, 0.05, distance + radius * 4), null,
      [{ model: carModel, transform: rotation, groundY: min[1] }], DEFAULT_FOG, rect, canvasHeight, clearColor);
  }
}
