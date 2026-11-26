import type { Database, RacingLine, SurfaceRecord } from "../formats/databases";
import type { MeshPartGeometry, MeshSlot, SceneDatabase } from "../formats/xbx";
import { clamp, lerp, type Vec3 } from "../math/mat4";

export type XbxModel = readonly MeshSlot<MeshPartGeometry>[];

export interface WorldSphere {
  center: Readonly<Vec3>;
  radius: number;
}

export interface GroundHit {
  hit: boolean;
  height: number;
  normal: Vec3;
  surfaceName: string;
  surface: SurfaceRecord | undefined;
}

export interface TrackProgress {
  interpolant: number;
  segmentIndex: number;
  distanceAlongTrack: number;
  lateralOffset: number;
  halfWidth: number;
  point: Vec3;
  forward: Vec3;
  right: Vec3;
  curvatureRadius: number;
}

export interface BarrierContact {
  sphereIndex: number;
  point: Vec3;
  /** Points into the permitted side of the boundary. */
  normal: Vec3;
  penetration: number;
}

export interface TrackSpatialOptions {
  surfaces?: Database<SurfaceRecord>;
  defaultSurfaceName?: string;
  /** Optional material join for track bundles that carry an external slot-to-surface table. */
  surfaceNameForPart?: (part: MeshPartGeometry, slot: MeshSlot<MeshPartGeometry>) => string | undefined;
  cellSize?: number;
  /** parseXbx applies the serialized X/Z sector offsets by default. */
  slotOffsetsApplied?: boolean;
  /** Corridor width override, in world units added to either side. */
  corridorMargin?: number;
}

type Triangle = {
  a: Vec3; b: Vec3; c: Vec3; normal: Vec3; surfaceName: string; surface?: SurfaceRecord;
};
type Segment = { x: number; z: number; dx: number; dz: number; length: number; nx: number; nz: number };

class Grid<T> {
  private readonly cells = new Map<string, T[]>();
  private readonly oversized: T[] = [];

  constructor(private readonly size: number) {}

  insert(minX: number, minZ: number, maxX: number, maxZ: number, value: T): void {
    const [left, near, right, far] = [minX, minZ, maxX, maxZ].map(n => Math.floor(n / this.size)) as [number, number, number, number];
    if (![left, near, right, far].every(Number.isSafeInteger) || (right - left + 1) * (far - near + 1) > 1024) {
      this.oversized.push(value);
      return;
    }
    for (let x = left; x <= right; x++) {
      for (let z = near; z <= far; z++) {
        const key = `${x},${z}`;
        const cell = this.cells.get(key);
        if (cell) cell.push(value);
        else this.cells.set(key, [value]);
      }
    }
  }

  at(x: number, z: number): readonly T[] {
    const cell = this.cells.get(`${Math.floor(x / this.size)},${Math.floor(z / this.size)}`) ?? [];
    return this.oversized.length ? [...cell, ...this.oversized] : cell;
  }

  near(x: number, z: number, radius: number): Set<T> {
    const result = new Set(this.oversized);
    const left = Math.floor((x - radius) / this.size), right = Math.floor((x + radius) / this.size);
    const near = Math.floor((z - radius) / this.size), far = Math.floor((z + radius) / this.size);
    if (![left, near, right, far].every(Number.isSafeInteger) || (right - left + 1) * (far - near + 1) > 1024) {
      for (const values of this.cells.values()) for (const value of values) result.add(value);
      return result;
    }
    for (let cx = left; cx <= right; cx++) {
      for (let cz = near; cz <= far; cz++) {
        for (const value of this.cells.get(`${cx},${cz}`) ?? []) result.add(value);
      }
    }
    return result;
  }
}

const unit = (x: number, y: number, z: number): Vec3 => {
  const length = Math.hypot(x, y, z);
  return length > 1e-9 ? [x / length, y / length, z / length] : [0, 1, 0];
};
const wrap = (value: number, count: number) => ((value % count) + count) % count;

export class TrackSpatial {
  private readonly ground: Grid<Triangle>;
  private readonly barriers: Grid<Segment>;
  private readonly segments: Grid<number>;
  private readonly positions: readonly Vec3[];
  private readonly segmentCount: number;
  private readonly length: number;
  private readonly defaultSurfaceName: string;
  private readonly defaultSurface: SurfaceRecord | undefined;
  private readonly corridorMargin: number;
  private readonly cellSize: number;
  private hasSceneBarriers = false;

  constructor(
    model: XbxModel,
    scene: SceneDatabase | undefined,
    readonly racingLine: RacingLine,
    options: TrackSpatialOptions = {},
  ) {
    // The authored sector spacing comes from the distinct X/Z offsets of the cut-up meshes.
    const spacing = (axis: "offsetX" | "offsetZ") => {
      const values = [...new Set(model.filter(slot => slot.flags & 0x80).map(slot => slot[axis]))].sort((a, b) => a - b);
      return values.slice(1).reduce((min, value, i) => Math.min(min, value - values[i]!), Infinity);
    };
    const authored = Math.min(spacing("offsetX"), spacing("offsetZ"));
    this.cellSize = options.cellSize ?? (Number.isFinite(authored) && authored >= 1 ? authored : 64);
    if (!Number.isFinite(this.cellSize) || this.cellSize <= 0) throw new RangeError("Invalid track cell size");
    this.ground = new Grid(this.cellSize);
    this.barriers = new Grid(this.cellSize);
    this.segments = new Grid(this.cellSize);
    this.corridorMargin = options.corridorMargin ?? 0;
    this.defaultSurfaceName = options.defaultSurfaceName ?? "";
    this.defaultSurface = options.surfaces?.get(this.defaultSurfaceName.toLowerCase());

    // Sector vertices from parseXbx are in world space. Other scene meshes are
    // local props and can overlap the track origin before scene placement.
    const sectorSlots = model.filter(slot => slot.flags & 0x80);
    const slots = sectorSlots.length ? sectorSlots : model;
    const taggedGround = slots.some(slot => slot.groups.some(group => group.some(part => part.g & 2)));
    for (const slot of slots) {
      const x = options.slotOffsetsApplied === false && (slot.flags & 0x80) ? slot.offsetX : 0;
      const z = options.slotOffsetsApplied === false && (slot.flags & 0x80) ? slot.offsetZ : 0;
      for (const group of slot.groups) {
        for (const part of group) {
          if (taggedGround && !(part.g & 2)) continue;
          const surfaceName = options.surfaceNameForPart?.(part, slot) ?? this.defaultSurfaceName;
          const surface = options.surfaces?.get(surfaceName.toLowerCase());
          const vertex = (i: number): Vec3 => [part.positions[i * 3]! + x, part.positions[i * 3 + 1]!, part.positions[i * 3 + 2]! + z];
          for (let i = 0; i + 2 < part.indices.length; i += 3) {
            const a = vertex(part.indices[i]!);
            const b = vertex(part.indices[i + 1]!);
            const c = vertex(part.indices[i + 2]!);
            const [abx, aby, abz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            const [acx, acy, acz] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            const ny = abz * acx - abx * acz;
            if (!(ny > 1e-8) || !Number.isFinite(aby + acy + ny)) continue;
            const normal = unit(aby * acz - abz * acy, ny, abx * acy - aby * acx);
            if (normal[1] < 0.05) continue;
            this.ground.insert(Math.min(a[0], b[0], c[0]), Math.min(a[2], b[2], c[2]),
              Math.max(a[0], b[0], c[0]), Math.max(a[2], b[2], c[2]), { a, b, c, normal, surfaceName, surface });
          }
        }
      }
    }

    this.positions = racingLine.points.map(({ position: [x, y, z] }) => [x, this.meshGround(x, y, z)?.height ?? y, z]);
    this.segmentCount = this.positions.length === 2 ? 1 : this.positions.length;
    let geometricLength = 0;
    for (let i = 0; i < this.segmentCount; i++) {
      const a = this.position(i);
      const b = this.position(i + 1);
      geometricLength += Math.hypot(b[0] - a[0], b[2] - a[2]);
      this.segments.insert(Math.min(a[0], b[0]), Math.min(a[2], b[2]), Math.max(a[0], b[0]), Math.max(a[2], b[2]), i);
    }
    this.length = racingLine.length > 0 ? racingLine.length : geometricLength;
    if (scene) this.addSceneBarriers(scene);
  }

  private position(index: number): Vec3 {
    return this.positions[wrap(index, this.positions.length)]!;
  }

  private meshGround(x: number, y: number, z: number): GroundHit | undefined {
    let closest: GroundHit | undefined;
    let distance = Infinity;
    for (const { a, b, c, normal, surfaceName, surface } of this.ground.at(x, z)) {
      const edge = (p: Vec3, q: Vec3) => (q[0] - p[0]) * (z - p[2]) - (q[2] - p[2]) * (x - p[0]);
      if (edge(a, b) > 1e-7 || edge(b, c) > 1e-7 || edge(c, a) > 1e-7) continue;
      const height = a[1] + ((a[0] - x) * normal[0] + (a[2] - z) * normal[2]) / normal[1];
      const gap = Math.abs(y - height);
      if (gap < distance || (gap === distance && height > (closest?.height ?? -Infinity))) {
        closest = { hit: true, height, normal: [...normal], surfaceName, surface };
        distance = gap;
      }
    }
    return closest;
  }

  queryGround(x: number, y: number, z: number): GroundHit {
    const mesh = this.meshGround(x, y, z);
    if (mesh) return mesh;
    const progress = this.queryProgress(x, z);
    const distance = Math.hypot(x - progress.point[0], z - progress.point[2]);
    const hit = this.positions.length > 0 && distance <= this.corridorHalfWidth(progress) + 2;
    const { forward, point } = progress;
    return {
      hit, height: hit ? point[1] : y, normal: hit ? unit(-forward[0] * forward[1], 1 - forward[1] ** 2, -forward[2] * forward[1]) : [0, 1, 0],
      surfaceName: hit ? this.defaultSurfaceName : "", surface: hit ? this.defaultSurface : undefined,
    };
  }

  private corridorHalfWidth(progress: TrackProgress): number {
    const edge = this.racingLine.edgeModifier > 0 ? this.racingLine.edgeModifier : 1;
    return Math.max(0, progress.halfWidth * edge + this.corridorMargin);
  }

  private curve(i: number, t: number): { point: Vec3; tangent: Vec3 } {
    const sample = (axis: 0 | 1 | 2) => {
      const a = this.position(i - 1)[axis], b = this.position(i)[axis];
      const c = this.position(i + 1)[axis], d = this.position(i + 2)[axis];
      const m1 = (c - a) / 2, m2 = (d - b) / 2;
      const q = 3 * (c - b) - 2 * m1 - m2;
      const r = 2 * (b - c) + m1 + m2;
      return [b + t * (m1 + t * (q + t * r)), m1 + t * (2 * q + t * 3 * r)];
    };
    const [x, dx] = sample(0), [y, dy] = sample(1), [z, dz] = sample(2);
    return { point: [x!, y!, z!], tangent: [dx!, dy!, dz!] };
  }

  queryProgress(x: number, z: number, hintIndex?: number): TrackProgress {
    const count = this.positions.length;
    const segmentCount = this.segmentCount;
    let segmentIndex = 0, t = 0, best = Infinity;
    const test = (i: number) => {
      const a = this.position(i), b = this.position(i + 1);
      const dx = b[0] - a[0], dz = b[2] - a[2];
      const lengthSq = dx * dx + dz * dz;
      const fraction = lengthSq > 0 ? clamp(((x - a[0]) * dx + (z - a[2]) * dz) / lengthSq, 0, 1) : 0;
      const distance = (x - a[0] - dx * fraction) ** 2 + (z - a[2] - dz * fraction) ** 2;
      if (distance < best) {
        best = distance;
        segmentIndex = i;
        t = fraction;
      }
    };
    if (count) {
      if (hintIndex !== undefined && Number.isFinite(hintIndex)) test(wrap(Math.trunc(hintIndex), segmentCount));
      for (const i of this.segments.near(x, z, this.cellSize)) test(i);
      if (best > this.cellSize ** 2) for (let i = 0; i < segmentCount; i++) test(i);
    }
    if (count >= 3) {
      // Compare the adjacent cubics too: the closest chord may sit on the
      // opposite side of a join from the closest spline point.
      const initialIndex = segmentIndex, initialT = t;
      best = Infinity;
      for (const [i, start] of [[initialIndex, initialT], [wrap(initialIndex - 1, count), 1],
        [wrap(initialIndex + 1, count), 0]] as const) {
        let fraction = start;
        for (let iteration = 0; iteration < 4; iteration++) {
          const { point, tangent: [dx, , dz] } = this.curve(i, fraction);
          const lengthSq = dx * dx + dz * dz;
          if (lengthSq < 1e-9) break;
          const next = clamp(fraction + ((x - point[0]) * dx + (z - point[2]) * dz) / lengthSq, 0, 1);
          if (Math.abs(next - fraction) < 1e-6) break;
          fraction = next;
        }
        const { point } = this.curve(i, fraction);
        const distance = (x - point[0]) ** 2 + (z - point[2]) ** 2;
        if (distance < best) {
          best = distance;
          segmentIndex = i;
          t = fraction;
        }
      }
    }
    if (count >= 3 && t >= 1) {
      segmentIndex = wrap(segmentIndex + 1, count);
      t = 0;
    }

    const a = this.racingLine.points[segmentIndex];
    const b = this.racingLine.points[wrap(segmentIndex + 1, count)];
    const start = count ? this.position(segmentIndex) : [x, 0, z] as Vec3;
    const end = count >= 3 ? this.position(segmentIndex + 1) : this.positions[1] ?? start;
    const curve = count >= 3 ? this.curve(segmentIndex, t) : {
      point: start.map((value, i) => lerp(value, end[i]!, t)) as Vec3,
      tangent: [end[0] - start[0], end[1] - start[1], end[2] - start[2]] as Vec3,
    };
    const { point } = curve;
    const [dx, dy, dz] = Math.hypot(curve.tangent[0], curve.tangent[2]) > 1e-9
      ? curve.tangent : a?.forward ?? [0, 0, 1];
    const forward = Math.hypot(dx, dz) > 1e-9 ? unit(dx, dy, dz) : [0, 0, 1] as Vec3;
    const right = unit(forward[2], 0, -forward[0]);
    const interpolant = segmentCount ? (segmentIndex + t) / segmentCount : 0;
    return {
      interpolant, segmentIndex, distanceAlongTrack: interpolant * this.length, point, forward, right,
      lateralOffset: (x - point[0]) * right[0] + (z - point[2]) * right[2],
      halfWidth: Math.max(0, lerp(a?.width ?? 0, b?.width ?? a?.width ?? 0, t) / 2),
      curvatureRadius: lerp(a?.curvatureRadius ?? 0, b?.curvatureRadius ?? a?.curvatureRadius ?? 0, t),
    };
  }

  private addSceneBarriers(scene: SceneDatabase): void {
    const seen = new Set<string>();
    const keyFor = (x: number, z: number, endX: number, endZ: number) =>
      `${Math.round(x * 100)},${Math.round(z * 100)}:${Math.round(endX * 100)},${Math.round(endZ * 100)}`;
    const add = (x: number, z: number, endX: number, endZ: number) => {
      const length = Math.hypot(endX - x, endZ - z);
      if (!Number.isFinite(length) || length < 1e-5) return;
      const key = keyFor(x, z, endX, endZ);
      if (seen.has(key)) return;
      seen.add(key);
      const dx = (endX - x) / length, dz = (endZ - z) / length;
      const nx = -dz, nz = dx;
      this.barriers.insert(Math.min(x, endX), Math.min(z, endZ), Math.max(x, endX), Math.max(z, endZ),
        { x, z, dx, dz, length, nx, nz });
      this.hasSceneBarriers = true;
    };
    // Only the 28-byte directed wall segments on scene roots are collision
    // barriers. scene.boundaryGroups holds planar sector/zone polygons tiling
    // the course whose outer edges cut straight across the road.
    for (const root of scene.roots) {
      for (const raw of [...root.boundaries, ...root.modeBoundaries]) {
        const data = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const x = data.getFloat32(4, true), z = data.getFloat32(8, true);
        const length = data.getFloat32(20, true);
        add(x, z, x + data.getFloat32(12, true) * length, z + data.getFloat32(16, true) * length);
      }
    }
  }

  queryBarrierContacts(spheres: readonly WorldSphere[]): BarrierContact[] {
    const contacts: BarrierContact[] = [];
    for (const [sphereIndex, { center: [x, y, z], radius }] of spheres.entries()) {
      if (!(radius > 0) || !Number.isFinite(x + y + z + radius)) continue;
      for (const s of this.barriers.near(x, z, radius)) {
        const deltaX = x - s.x, deltaZ = z - s.z;
        const along = deltaX * s.dx + deltaZ * s.dz;
        const signed = deltaX * s.nx + deltaZ * s.nz;
        if (along >= -1e-5 && along <= s.length + 1e-5) {
          if (signed > -radius && signed < radius) {
            contacts.push({
              sphereIndex, point: [x - signed * s.nx, y, z - signed * s.nz],
              penetration: radius - signed, normal: [s.nx, 0, s.nz],
            });
          }
        } else if (signed >= 0 && signed < radius) {
          const clamped = clamp(along, 0, s.length);
          const px = s.x + s.dx * clamped, pz = s.z + s.dz * clamped;
          const rx = x - px, rz = z - pz;
          const distSq = rx * rx + rz * rz;
          if (distSq < radius * radius) {
            const dist = Math.sqrt(distSq);
            const nx = dist > 1e-9 ? rx / dist : s.nx;
            const nz = dist > 1e-9 ? rz / dist : s.nz;
            contacts.push({
              sphereIndex, point: [px, y, pz],
              penetration: radius - dist, normal: [nx, 0, nz],
            });
          }
        }
      }

      if (this.hasSceneBarriers || !this.positions.length) continue;
      const progress = this.queryProgress(x, z);
      const { point, right, lateralOffset } = progress;
      const halfWidth = this.corridorHalfWidth(progress);
      const side = lateralOffset < 0 ? -1 : 1;
      const penetration = Math.abs(lateralOffset) + radius - halfWidth;
      if (penetration > 0 && halfWidth > 0) {
        contacts.push({
          sphereIndex, point: [point[0] + side * halfWidth * right[0], y, point[2] + side * halfWidth * right[2]],
          normal: [-side * right[0], 0, -side * right[2]], penetration,
        });
      }
    }
    return contacts;
  }
}
