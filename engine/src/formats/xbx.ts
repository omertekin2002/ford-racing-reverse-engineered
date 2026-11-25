class Reader {
  private readonly view: DataView;
  offset = 0;

  constructor(private readonly bytes: Uint8Array, private readonly label: string) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private advance(length: number): number {
    const start = this.offset;
    if (length > this.bytes.length - start) {
      throw new Error(`Truncated ${this.label} at ${start} (need ${length} bytes)`);
    }
    this.offset += length;
    return start;
  }

  take(length: number): Uint8Array {
    const start = this.advance(length);
    return this.bytes.subarray(start, this.offset);
  }

  u8(): number { return this.view.getUint8(this.advance(1)); }
  u16(): number { return this.view.getUint16(this.advance(2), true); }
  u32(): number { return this.view.getUint32(this.advance(4), true); }

  u32s(count: number): Uint32Array {
    const start = this.advance(count * 4);
    return Uint32Array.from({ length: count }, (_, i) => this.view.getUint32(start + i * 4, true));
  }

  floats(count: number): Float32Array {
    const start = this.advance(count * 4);
    return Float32Array.from({ length: count }, (_, i) => this.view.getFloat32(start + i * 4, true));
  }

  uv(count: number): Float32Array {
    const start = this.advance(count * 4);
    return Float32Array.from({ length: count * 2 }, (_, i) => this.view.getInt16(start + i * 2, true) / 255);
  }

  records(count: number, stride: number): Uint8Array[] {
    const block = this.take(count * stride);
    return Array.from({ length: count }, (_, i) => block.subarray(i * stride, (i + 1) * stride));
  }

  end(): void {
    if (this.offset !== this.bytes.length) {
      throw new Error(`Trailing ${this.label} bytes at ${this.offset}`);
    }
  }
}

export interface MeshPart {
  f: number;
  g: number;
  primaryTexture: number | null;
  vertexCount: number;
  stripCount: number;
  word8: number;
  word12: number;
  /** Additional material words in their serialized order. */
  descriptorExtension: Uint32Array;
  strips: Uint16Array[];
  /** Consecutive triangle triples with indices local to this part. */
  indices: Uint16Array;
}

export interface MeshPartGeometry extends MeshPart {
  positions: Float32Array;
  packedAttributes: Uint32Array;
  normals: Float32Array;
  colors: Uint8Array;
  uv0?: Float32Array;
  /** Additional UV streams in file order (0x80 before 0x40). */
  uv1?: Float32Array;
  uv2?: Float32Array;
  vertexExtension?: [Uint8Array, Uint8Array];
}

export interface MeshSlot<Part = MeshPart> {
  id: number;
  radius: number;
  /** Serialized order is minX, maxX, minY, maxY, minZ, maxZ. */
  bounds: Float32Array;
  flags: number;
  group2Flags: number;
  offsetX: number;
  offsetZ: number;
  groups: [Part[], Part[]];
  rawHeader: Uint8Array;
}

function appendStripTriangles(strip: ArrayLike<number>, indices: number[]): void {
  for (let i = 2; i < strip.length; i++) {
    const a = strip[i - 2]!;
    const b = strip[i - 1]!;
    const c = strip[i]!;
    if (a === b || b === c || a === c) continue;
    if (i % 2 === 0) indices.push(a, b, c);
    else indices.push(a, c, b);
  }
}

export function expandTriangleStrip(strip: ArrayLike<number>): Uint16Array {
  const indices: number[] = [];
  appendStripTriangles(strip, indices);
  return Uint16Array.from(indices);
}

function readPart(reader: Reader): MeshPart {
  const f = reader.u8();
  const g = reader.u8();
  const selector = reader.u16();
  const primaryTexture = selector === 0xffff ? null : selector;
  const vertexCount = reader.u16();
  const stripCount = reader.u16();
  const word8 = reader.u32();
  const word12 = reader.u32();
  let extensionWords = 0;
  if (g & 0x08) extensionWords += 5;
  if (g & 0x01) extensionWords++;
  if (primaryTexture === null || f & 0x06) extensionWords++;
  for (const flag of [0x08, 0x10, 0x40, 0x80]) {
    if (f & flag) extensionWords++;
  }
  const descriptorExtension = reader.u32s(extensionWords);
  return {
    f, g, primaryTexture, vertexCount, stripCount, word8, word12, descriptorExtension,
    strips: [], indices: new Uint16Array(),
  };
}

export function parse3dObjsXbx(bytes: Uint8Array): MeshSlot[] {
  const reader = new Reader(bytes, "3dobjs.XBX");
  const headers = reader.records(reader.u32(), 88);
  const slots = headers.map((rawHeader, id): MeshSlot => {
    const header = new Reader(rawHeader, "XBX mesh slot");
    header.take(12);
    const radius = header.floats(1)[0]!;
    const bounds = header.floats(6);
    const firstCount = header.u16();
    const flags = header.u16();
    header.take(12);
    const secondCount = header.u16();
    const group2Flags = header.u16();
    header.take(20);
    const [offsetX, offsetZ] = header.floats(2);
    return {
      id, radius, bounds, flags, group2Flags, offsetX: offsetX!, offsetZ: offsetZ!, rawHeader,
      groups: [
        Array.from({ length: firstCount }, () => readPart(reader)),
        Array.from({ length: secondCount }, () => readPart(reader)),
      ],
    };
  });

  for (const slot of slots) {
    for (const group of slot.groups) {
      for (const part of group) {
        const expanded: number[] = [];
        for (let i = 0; i < part.stripCount; i++) {
          const count = reader.u16();
          const raw = reader.take(count * 2);
          const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
          const strip = Uint16Array.from({ length: count }, (_, j) => {
            const index = view.getUint16(j * 2, true);
            if (index >= part.vertexCount) throw new Error(`XBX index ${index} exceeds vertex count in slot ${slot.id}`);
            return index;
          });
          part.strips.push(strip);
          appendStripTriangles(strip, expanded);
        }
        part.indices = Uint16Array.from(expanded);
      }
    }
  }
  reader.end();
  return slots;
}

export interface XbxVertexOptions {
  /** Apply the on-disk X/Z offsets on slots with flag 0x80. Defaults to true. */
  applySlotOffsets?: boolean;
}

function readVertices(reader: Reader, part: MeshPart, offsetX: number, offsetZ: number): MeshPartGeometry {
  const count = part.vertexCount;
  const positions = reader.floats(count * 3);
  if (offsetX || offsetZ) {
    for (let i = 0; i < positions.length; i += 3) {
      positions[i] = positions[i]! + offsetX;
      positions[i + 2] = positions[i + 2]! + offsetZ;
    }
  }
  const vertexExtension: MeshPartGeometry["vertexExtension"] = part.g & 0x08
    ? [reader.take(count * 4), reader.take(count * 16)]
    : undefined;
  const packedAttributes = reader.u32s(count);
  const normals = new Float32Array(count * 3);
  const colors = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    const packed = packedAttributes[i]!;
    const x = (packed << 24) >> 24;
    const y = (packed << 16) >> 24;
    const z = (packed << 8) >> 24;
    const length = Math.hypot(x, y, z);
    if (length !== 0) {
      normals[i * 3] = x / length;
      normals[i * 3 + 1] = y / length;
      normals[i * 3 + 2] = z / length;
    }
    colors[i * 4] = (packed >>> 16) & 255;
    colors[i * 4 + 1] = (packed >>> 8) & 255;
    colors[i * 4 + 2] = packed & 255;
    colors[i * 4 + 3] = packed >>> 24;
  }

  const uv0 = part.primaryTexture === null ? undefined : reader.uv(count);
  const uv80 = part.f & 0x80 ? reader.uv(count) : undefined;
  const uv40 = part.f & 0x40 ? reader.uv(count) : undefined;
  return {
    ...part, positions, packedAttributes, normals, colors, uv0,
    uv1: uv80 ?? uv40, uv2: uv80 ? uv40 : undefined, vertexExtension,
  };
}

export function parse3dObjspXbx(
  bytes: Uint8Array,
  slots: readonly MeshSlot[],
  { applySlotOffsets = true }: XbxVertexOptions = {},
): MeshSlot<MeshPartGeometry>[] {
  const reader = new Reader(bytes, "3dobjsp.XBX");
  const meshes = slots.map((slot): MeshSlot<MeshPartGeometry> => {
    const apply = applySlotOffsets && (slot.flags & 0x80) !== 0;
    const x = apply ? slot.offsetX : 0;
    const z = apply ? slot.offsetZ : 0;
    const [first, second] = slot.groups;
    return {
      ...slot,
      groups: [
        first.map(part => readVertices(reader, part, x, z)),
        second.map(part => readVertices(reader, part, x, z)),
      ],
    };
  });
  reader.end();
  return meshes;
}

export function parseXbx(
  meshes: Uint8Array,
  vertices: Uint8Array,
  options?: XbxVertexOptions,
): MeshSlot<MeshPartGeometry>[] {
  return parse3dObjspXbx(vertices, parse3dObjsXbx(meshes), options);
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const binInfoTableNames = [
  "shapes", "subObjects", "cameras", "textureLiveries", "skeletalAnimations", "sceneLinkTypes",
  "lights", "boundaryTypes", "textureTransformSets", "unknown", "textureNames",
] as const;

export type BinInfo = Record<typeof binInfoTableNames[number], string[]>;

export function parseBinInfo(bytes: Uint8Array): BinInfo {
  const reader = new Reader(bytes, "bininfo.BIN");
  if (reader.u32() !== bytes.length) throw new Error("bininfo.BIN length does not match its header");
  const tables = binInfoTableNames.map(name => [name, reader.u32s(reader.u32())] as const);
  const entries = tables.map(([name, offsets]) => {
    const strings = Array.from(offsets, offset => {
      if (offset !== reader.offset) throw new Error(`Invalid bininfo.BIN string offset ${offset}`);
      const end = bytes.indexOf(0, offset);
      if (end === -1) throw new Error(`Unterminated bininfo.BIN string at ${offset}`);
      const raw = reader.take(end - offset + 1);
      return decoder.decode(raw.subarray(0, -1));
    });
    return [name, strings] as const;
  });
  reader.end();
  return Object.fromEntries(entries) as BinInfo;
}

type WordPair = [number, number];

export interface SceneChild {
  meshSlotId: number;
  flags: number;
  transform: Float32Array;
  pairs: WordPair[];
  children: SceneChild[];
}

export interface SceneCamera {
  raw: Uint8Array;
  children: SceneCamera[];
}

export interface SceneTransform {
  first: Float32Array;
  second: Float32Array;
  words: Uint32Array;
}

export interface SceneRoot {
  shapeId: number;
  transforms: SceneTransform[];
  boundaries: Uint8Array[];
  points: Float32Array;
  references: WordPair[];
  secondaryRecords: Uint8Array[];
  mode: number;
  modeBoundaries: Uint8Array[];
  cameraControl?: number;
  cameras: SceneCamera[];
  modePairs: WordPair[];
  lodValues: Float32Array;
  declaredInlineChildren: number;
  declaredChildPairs: number;
  preMeshWords: Uint32Array;
  meshSlotId: number;
  controlWords: WordPair;
  meshPairs: WordPair[];
  children: { kind: "inline"; nodes: SceneChild[] } | { kind: "indirect"; references: Uint32Array };
}

export interface SceneRange {
  values: Float32Array;
  trailingWords: WordPair;
}

export interface SceneRangeBand {
  option0: number;
  option1: number;
  ranges: SceneRange[];
}

export interface SceneNamedRecord {
  identifier: number;
  flags: number;
  name: string;
  nameBytes: Uint8Array;
  fields: Uint8Array;
}

export interface ScenePlanarBoundary {
  /** Three pairs of floats under the planar triangle interpretation. */
  points: Float32Array;
  /** Preserve the last serialized word, which the loader copies as a word. */
  lastWord: number;
}

export interface SceneDatabase {
  version: 18;
  header: Uint32Array;
  roots: SceneRoot[];
  animationGroups: SceneRangeBand[][];
  boundaryGroups: ScenePlanarBoundary[][];
  namedRecords: SceneNamedRecord[];
}

function readPairs(reader: Reader, count: number): WordPair[] {
  const words = reader.u32s(count * 2);
  return Array.from({ length: count }, (_, i) => [words[i * 2]!, words[i * 2 + 1]!]);
}

function readChild(reader: Reader): SceneChild {
  const meshSlotId = reader.u32();
  const flags = reader.u32();
  const transform = reader.floats(6);
  const pairs = readPairs(reader, reader.u32());
  const children = Array.from({ length: reader.u32() & 0xff }, () => readChild(reader));
  return { meshSlotId, flags, transform, pairs, children };
}

function readCamera(reader: Reader): SceneCamera {
  const raw = reader.take(108);
  const count = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(12, true);
  // Read incrementally so an out-of-bounds count cannot cause a large preallocation.
  const children: SceneCamera[] = [];
  for (let i = 0; i < count; i++) children.push(readCamera(reader));
  return { raw, children };
}

function readRoot(reader: Reader, index: number): SceneRoot {
  if (reader.u32s(4).some(word => word !== 0xffffffff) || reader.u32() !== index) {
    throw new Error(`Invalid 3dobjdb.BIN shape header for root ${index}`);
  }
  const transforms = Array.from({ length: reader.u32() & 0x3f }, () => ({
    first: reader.floats(3),
    second: reader.floats(3),
    words: reader.u32s(15),
  }));
  const boundaries = reader.records(reader.u32(), 28);
  const points = reader.floats(reader.u32() * 3);
  const references = readPairs(reader, reader.u32() & 0xff);
  const secondaryRecords = reader.records(reader.u32() & 0xffff, 32);
  const mode = reader.u32();
  const modeBoundaries = mode & 4 ? reader.records(reader.u32(), 28) : [];
  let cameraControl: number | undefined;
  let cameras: SceneCamera[] = [];
  if (mode & 2) {
    cameraControl = reader.u32();
    cameras = Array.from({ length: reader.u32() & 0xff }, () => readCamera(reader));
  }
  const modePairs = mode & 8 ? readPairs(reader, reader.u32() & 0xff) : [];
  const lodValues = reader.floats(reader.u32() & 0xff);
  const declaredInlineChildren = reader.u32();
  const declaredChildPairs = reader.u32();
  const preMeshWords = reader.u32s(reader.u32() & 0xff);
  const meshSlotId = reader.u32();
  const controlWords: WordPair = [reader.u32(), reader.u32()];
  const meshPairs = readPairs(reader, reader.u32() & 0xff);
  const childCount = reader.u32() & 0xff;
  const children: SceneRoot["children"] = mode & 1
    ? { kind: "indirect", references: reader.u32s(childCount) }
    : { kind: "inline", nodes: Array.from({ length: childCount }, () => readChild(reader)) };
  return {
    shapeId: index, transforms, boundaries, points, references, secondaryRecords, mode,
    modeBoundaries, cameraControl, cameras, modePairs, lodValues, declaredInlineChildren,
    declaredChildPairs, preMeshWords, meshSlotId, controlWords, meshPairs, children,
  };
}

function readAnimationGroups(reader: Reader, groupCount: number): SceneRangeBand[][] {
  if (groupCount === 0) return [];
  const bandCount = reader.u32();
  const rangeCount = reader.u32();
  const groupSizes = reader.u32s(groupCount);
  if (groupSizes.reduce((total, count) => total + count, 0) !== bandCount) {
    throw new Error("3dobjdb.BIN animation band total does not match");
  }
  const packedBands = reader.records(bandCount, 4);
  let bandIndex = 0;
  let rangesRead = 0;
  const groups = Array.from(groupSizes, size => Array.from({ length: size }, (): SceneRangeBand => {
    const packed = packedBands[bandIndex++]!;
    const count = packed[0]! + packed[1]! * 256;
    rangesRead += count;
    const ranges = Array.from({ length: count }, (): SceneRange => ({
      values: reader.floats(4),
      trailingWords: [reader.u32(), reader.u32()],
    }));
    return { option0: packed[2]!, option1: packed[3]!, ranges };
  }));
  if (rangesRead !== rangeCount) throw new Error("3dobjdb.BIN animation range total does not match");
  return groups;
}

export function parse3dObjDb(bytes: Uint8Array, binInfo?: BinInfo): SceneDatabase {
  const reader = new Reader(bytes, "3dobjdb.BIN");
  const header = reader.u32s(18);
  const version = header[0];
  if (version !== 18) throw new Error(`Unsupported 3dobjdb.BIN version ${version}`);
  const rootCount = header[1]!;
  if (binInfo && rootCount !== binInfo.shapes.length) {
    throw new Error("3dobjdb.BIN root count does not match bininfo.BIN");
  }

  const roots: SceneRoot[] = [];
  const countedWords = [2, 3, 4, 6, 9, 10, 11, 12, 13];
  const totals = new Array<number>(18).fill(0);
  for (let i = 0; i < rootCount; i++) {
    const root = readRoot(reader, i);
    roots.push(root);
    const counts = [
      [2, root.references.length],
      [3, root.secondaryRecords.length],
      [4, root.transforms.length],
      [6, root.boundaries.length],
      [9, root.declaredInlineChildren],
      [10, root.declaredChildPairs],
      [11, root.children.kind === "indirect" ? root.children.references.length : 0],
      [12, root.preMeshWords.length],
      [13, root.lodValues.length],
    ] as const;
    for (const [word, count] of counts) totals[word] = totals[word]! + count;
  }
  for (const word of countedWords) {
    if (totals[word] !== header[word]) throw new Error(`3dobjdb.BIN root total does not match header word ${word}`);
  }

  const animationGroups = readAnimationGroups(reader, header[15]!);
  const boundaryGroupCount = reader.u32();
  const boundaryEntryCount = reader.u32();
  const boundaryGroups: ScenePlanarBoundary[][] = [];
  let boundaryEntriesRead = 0;
  for (let i = 0; i < boundaryGroupCount; i++) {
    const count = reader.u32();
    const entries = reader.records(count, 24).map(raw => ({
      points: new Reader(raw, "planar boundary").floats(6),
      lastWord: new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(20, true),
    }));
    boundaryGroups.push(entries);
    boundaryEntriesRead += count;
  }
  if (boundaryEntriesRead !== boundaryEntryCount) {
    throw new Error("3dobjdb.BIN planar boundary entry total does not match");
  }

  const namedRecordCount = reader.u32();
  const nameByteCount = reader.u32();
  const namedRecords: SceneNamedRecord[] = [];
  let nameBytesRead = 0;
  for (let i = 0; i < namedRecordCount; i++) {
    const identifier = reader.u32();
    const flags = reader.u32();
    const nameBytes = reader.take(reader.u32());
    const end = nameBytes.indexOf(0);
    const name = decoder.decode(end === -1 ? nameBytes : nameBytes.subarray(0, end));
    const fields = reader.take(88);
    namedRecords.push({ identifier, flags, name, nameBytes, fields });
    nameBytesRead += nameBytes.length;
  }
  if (nameBytesRead !== nameByteCount) throw new Error("3dobjdb.BIN named record byte total does not match");
  reader.end();
  return { version, header, roots, animationGroups, boundaryGroups, namedRecords };
}
