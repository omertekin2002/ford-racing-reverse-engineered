import type { Vec3 } from "../math/mat4";
import type { BarrierContact, WorldSphere } from "./trackSpatial";

type Vector = Readonly<Vec3>;

export const add = (a: Vector, b: Vector): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vector, b: Vector): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (v: Vector, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
export const dot = (a: Vector, b: Vector): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vector, b: Vector): Vec3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
export function normalize(v: Vector, fallback: Vec3): Vec3 {
  const length = Math.hypot(...v);
  return length > 1e-9 ? scale(v, 1 / length) : fallback;
}

export interface CollisionBody {
  readonly inverseMass: number;
  readonly centerOfMassWorld: Vector;
  readonly linearVelocity: Vector;
  readonly angularVelocity: Vector;
  inverseInertiaWorld(vector: Vector): Vec3;
  getWorldSpheres(): readonly WorldSphere[];
  translate(offset: Vec3): void;
  applyImpulse(impulse: Vec3, point: Vector): void;
}

export function pointVelocity(body: CollisionBody, point: Vector): Vec3 {
  return add(body.linearVelocity, cross(body.angularVelocity, sub(point, body.centerOfMassWorld)));
}

function effectiveInverseMass(body: CollisionBody, point: Vector, direction: Vector): number {
  const r = sub(point, body.centerOfMassWorld);
  return body.inverseMass + dot(direction, cross(body.inverseInertiaWorld(cross(r, direction)), r));
}

export function saturateCollisionImpulse(raw: number): number {
  return -40000 * Math.expm1(-Math.abs(raw) / 40000);
}

export function resolveStaticContact(
  body: CollisionBody, point: Vector, normal: Vector, restitution: number, cap: number,
): number {
  const speed = dot(pointVelocity(body, point), normal);
  if (speed >= 0 || body.inverseMass <= 0) return 0;
  const denominator = effectiveInverseMass(body, point, normal);
  if (denominator <= 0) return 0;
  const j = Math.min(cap, -(1 + restitution) * speed / denominator);
  body.applyImpulse(scale(normal, j), point);
  return j;
}

/** Resolve a wall against a single point, capping friction so sliding cannot reverse. */
export function resolveBarrierContact(
  body: CollisionBody, { point, normal, penetration }: BarrierContact,
): number {
  if (penetration <= 0 || body.inverseMass <= 0) return 0;
  const j = resolveStaticContact(body, point, normal, 0.5, 50000);
  const tangent = [-normal[2], 0, normal[0]] as Vec3;
  const speed = dot(pointVelocity(body, point), tangent);
  if (j > 0 && Math.abs(speed) > 1e-6) {
    const denominator = effectiveInverseMass(body, point, tangent);
    const slidingImpulse = 40 + 960 * Math.min(1, Math.abs(speed) * 0.01);
    const friction = Math.min(Math.abs(speed) / denominator, slidingImpulse, 0.25 * j);
    body.applyImpulse(scale(tangent, -Math.sign(speed) * friction), point);
  }
  body.translate(scale(normal, penetration + 1e-5));
  return j;
}

interface SphereContact {
  point: Vec3;
  normal: Vec3;
  penetration: number;
}

function sphereContact(a: WorldSphere, b: WorldSphere, fallback: Vec3): SphereContact | undefined {
  const delta = sub(b.center, a.center);
  const distanceSq = dot(delta, delta);
  const radius = a.radius + b.radius;
  if (distanceSq > radius * radius) return undefined;
  const distance = Math.sqrt(distanceSq);
  const normal = distance > 1e-9 ? scale(delta, 1 / distance) : fallback;
  return { point: add(a.center, scale(normal, a.radius)), normal, penetration: radius - distance };
}

/** Resolve the deepest sphere contact once per pair per substep. */
export function resolveCarCollision(a: CollisionBody, b: CollisionBody): number {
  if (a === b) return 0;
  const inverseMass = a.inverseMass + b.inverseMass;
  if (inverseMass <= 0) return 0;
  const spheresA = a.getWorldSpheres();
  const spheresB = b.getWorldSpheres();
  const fallback = normalize(sub(a.linearVelocity, b.linearVelocity), [1, 0, 0]);
  let contact: SphereContact | undefined;
  for (const sphereA of spheresA) {
    for (const sphereB of spheresB) {
      const candidate = sphereContact(sphereA, sphereB, fallback);
      if (candidate && (!contact || candidate.penetration > contact.penetration)) contact = candidate;
    }
  }
  if (!contact) return 0;

  const { point, normal, penetration } = contact;
  const closing = dot(sub(pointVelocity(a, point), pointVelocity(b, point)), normal);
  let j = 0;
  if (closing > 0) {
    const denominator = effectiveInverseMass(a, point, normal) + effectiveInverseMass(b, point, normal);
    if (denominator > 0) {
      j = saturateCollisionImpulse(1.05 * closing / denominator);
      a.applyImpulse(scale(normal, -j), point);
      b.applyImpulse(scale(normal, j), point);
    }
  }

  if (penetration > 0) {
    a.translate(scale(normal, -penetration * a.inverseMass / inverseMass));
    b.translate(scale(normal, penetration * b.inverseMass / inverseMass));
  }
  return j;
}
