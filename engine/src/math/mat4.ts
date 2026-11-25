export type Vec3 = [x: number, y: number, z: number];
export type Quat = [x: number, y: number, z: number, w: number];

/** Column-major matrices for WebGL. The world is Y-up and view space looks down +Z. */
export type Mat4 = Float32Array;
export type Mat3 = Float32Array;

type Vec3Input = Readonly<Vec3>;
type QuatInput = Readonly<Quat>;

const TAU = 2 * Math.PI;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * t;
}

/** Wrap radians to [-π, π). */
export function wrapAngle(radians: number): number {
  const wrapped = radians % TAU;
  if (wrapped >= Math.PI) return wrapped - TAU;
  if (wrapped < -Math.PI) return wrapped + TAU;
  return wrapped === 0 ? 0 : wrapped;
}

/** Shortest-path interpolation of angles in radians. */
export function lerpAngle(start: number, end: number, t: number): number {
  return wrapAngle(start + wrapAngle(end - start) * t);
}

export function identity(out: Mat4 = new Float32Array(16)): Mat4 {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

/** Positive view depths map to WebGL NDC: near → -1 and far → +1. */
export function perspectiveLH(
  fovYRad: number, aspect: number, near: number, far: number,
  out: Mat4 = new Float32Array(16),
): Mat4 {
  const cotangent = 1 / Math.tan(fovYRad / 2);
  const depth = far - near;
  out.fill(0);
  out[0] = cotangent / aspect;
  out[5] = cotangent;
  out[10] = far === Infinity ? 1 : 1 + 2 * near / depth;
  out[11] = 1;
  out[14] = far === Infinity ? -2 * near : -2 * near * (far / depth);
  return out;
}

/** Build a view matrix with +X to the right and positive depth along target - eye. */
export function lookAtLH(
  eye: Vec3Input, target: Vec3Input, up: Vec3Input, out: Mat4 = new Float32Array(16),
): Mat4 {
  const [ex, ey, ez] = eye;
  let fx = target[0] - ex;
  let fy = target[1] - ey;
  let fz = target[2] - ez;
  const forwardLength = Math.hypot(fx, fy, fz);
  if (forwardLength === 0) {
    fz = 1;
  } else {
    fx /= forwardLength;
    fy /= forwardLength;
    fz /= forwardLength;
  }

  let [ux, uy, uz] = up;
  let rx = uy * fz - uz * fy;
  let ry = uz * fx - ux * fz;
  let rz = ux * fy - uy * fx;
  let rightLength = Math.hypot(rx, ry, rz);
  if (rightLength <= 1e-8 * Math.hypot(ux, uy, uz)) {
    // Use a world axis away from forward when up cannot define a right vector.
    const useY = Math.abs(fy) < 0.9;
    rx = useY ? fz : 0;
    ry = useY ? 0 : -fz;
    rz = useY ? -fx : fy;
    rightLength = Math.hypot(rx, ry, rz);
  }
  rx /= rightLength;
  ry /= rightLength;
  rz /= rightLength;

  ux = fy * rz - fz * ry;
  uy = fz * rx - fx * rz;
  uz = fx * ry - fy * rx;
  out[0] = rx;
  out[1] = ux;
  out[2] = fx;
  out[3] = 0;
  out[4] = ry;
  out[5] = uy;
  out[6] = fy;
  out[7] = 0;
  out[8] = rz;
  out[9] = uz;
  out[10] = fz;
  out[11] = 0;
  out[12] = -(rx * ex + ry * ey + rz * ez);
  out[13] = -(ux * ex + uy * ey + uz * ez);
  out[14] = -(fx * ex + fy * ey + fz * ez);
  out[15] = 1;
  return out;
}

/** Copy a column-major 3×3 rotation and a translation into a rigid transform. */
export function fromRotationTranslation(
  rotation: Readonly<ArrayLike<number>>, translation: Vec3Input, out: Mat4 = new Float32Array(16),
): Mat4 {
  // Copy backwards so rotation can occupy the first nine entries of out.
  for (let column = 2; column >= 0; column--) {
    const source = column * 3;
    const destination = column * 4;
    out[destination + 3] = 0;
    out[destination + 2] = rotation[source + 2]!;
    out[destination + 1] = rotation[source + 1]!;
    out[destination] = rotation[source]!;
  }
  out[12] = translation[0];
  out[13] = translation[1];
  out[14] = translation[2];
  out[15] = 1;
  return out;
}

/** Compose yaw (Y), pitch (X) and roll (Z) in radians as Ry · Rx · Rz. */
export function fromEulerYXZ(
  yaw: number, pitch: number, roll: number, out: Mat4 = new Float32Array(16),
): Mat4 {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cx = Math.cos(pitch), sx = Math.sin(pitch);
  const cz = Math.cos(roll), sz = Math.sin(roll);
  out[0] = cy * cz + sy * sx * sz;
  out[1] = cx * sz;
  out[2] = cy * sx * sz - sy * cz;
  out[3] = 0;
  out[4] = sy * sx * cz - cy * sz;
  out[5] = cx * cz;
  out[6] = sy * sz + cy * sx * cz;
  out[7] = 0;
  out[8] = sy * cx;
  out[9] = -sx;
  out[10] = cy * cx;
  out[11] = 0;
  out[12] = out[13] = out[14] = 0;
  out[15] = 1;
  return out;
}

/** Return a · b, applying b first to a column vector. out may be either input. */
export function multiply(a: Mat4, b: Mat4, out: Mat4 = new Float32Array(16)): Mat4 {
  const a00 = a[0]!, a01 = a[1]!, a02 = a[2]!, a03 = a[3]!;
  const a10 = a[4]!, a11 = a[5]!, a12 = a[6]!, a13 = a[7]!;
  const a20 = a[8]!, a21 = a[9]!, a22 = a[10]!, a23 = a[11]!;
  const a30 = a[12]!, a31 = a[13]!, a32 = a[14]!, a33 = a[15]!;
  for (let offset = 0; offset < 16; offset += 4) {
    const x = b[offset]!, y = b[offset + 1]!, z = b[offset + 2]!, w = b[offset + 3]!;
    out[offset] = a00 * x + a10 * y + a20 * z + a30 * w;
    out[offset + 1] = a01 * x + a11 * y + a21 * z + a31 * w;
    out[offset + 2] = a02 * x + a12 * y + a22 * z + a32 * w;
    out[offset + 3] = a03 * x + a13 * y + a23 * z + a33 * w;
  }
  return out;
}

/** Invert an affine or projective matrix. A singular matrix returns null and leaves out untouched. */
export function invert(a: Mat4, out?: Mat4): Mat4 | null {
  const a00 = a[0]!, a01 = a[1]!, a02 = a[2]!, a03 = a[3]!;
  const a10 = a[4]!, a11 = a[5]!, a12 = a[6]!, a13 = a[7]!;
  const a20 = a[8]!, a21 = a[9]!, a22 = a[10]!, a23 = a[11]!;
  const a30 = a[12]!, a31 = a[13]!, a32 = a[14]!, a33 = a[15]!;

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(det) || det === 0) return null;

  const scale = 1 / det;
  out ??= new Float32Array(16);
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * scale;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * scale;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * scale;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * scale;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * scale;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * scale;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * scale;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * scale;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * scale;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * scale;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * scale;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * scale;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * scale;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * scale;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * scale;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * scale;
  return out;
}

/** Transform a point (w=1) and divide by the resulting homogeneous w. */
export function transformPoint(m: Mat4, point: Vec3Input, out: Vec3 = [0, 0, 0]): Vec3 {
  const [x, y, z] = point;
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  out[0] = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w;
  out[1] = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
  out[2] = (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w;
  return out;
}

/** Apply the linear part of a transform (w=0). */
export function transformDirection(m: Mat4, direction: Vec3Input, out: Vec3 = [0, 0, 0]): Vec3 {
  const [x, y, z] = direction;
  out[0] = m[0]! * x + m[4]! * y + m[8]! * z;
  out[1] = m[1]! * x + m[5]! * y + m[9]! * z;
  out[2] = m[2]! * x + m[6]! * y + m[10]! * z;
  return out;
}

export function quatFromAxisAngle(axis: Vec3Input, radians: number, out: Quat = [0, 0, 0, 1]): Quat {
  const [x, y, z] = axis;
  const length = Math.hypot(x, y, z);
  const half = radians / 2;
  const scale = length === 0 ? 0 : Math.sin(half) / length;
  out[0] = x * scale;
  out[1] = y * scale;
  out[2] = z * scale;
  out[3] = length === 0 ? 1 : Math.cos(half);
  return out;
}

/** Return a · b, applying rotation b first. */
export function quatMultiply(a: QuatInput, b: QuatInput, out: Quat = [0, 0, 0, 1]): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/** Interpolate unit quaternions along the shortest rotation. */
export function quatSlerp(a: QuatInput, b: QuatInput, t: number, out: Quat = [0, 0, 0, 1]): Quat {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const cosine = Math.min(1, Math.abs(dot));
  let left = 1 - t;
  let right = dot < 0 ? -t : t;
  if (cosine < 0.9995) {
    const angle = Math.acos(cosine);
    const sine = Math.sin(angle);
    left = Math.sin(left * angle) / sine;
    right = Math.sin(right * angle) / sine;
  }
  const x = left * a[0] + right * b[0];
  const y = left * a[1] + right * b[1];
  const z = left * a[2] + right * b[2];
  const w = left * a[3] + right * b[3];
  const length = Math.hypot(x, y, z, w);
  out[0] = x / length;
  out[1] = y / length;
  out[2] = z / length;
  out[3] = w / length;
  return out;
}

/** Build a rigid transform from a unit quaternion and a translation. */
export function mat4FromQuatTranslation(
  rotation: QuatInput, translation: Vec3Input, out: Mat4 = new Float32Array(16),
): Mat4 {
  const [x, y, z, w] = rotation;
  const xx = 2 * x * x, xy = 2 * x * y, xz = 2 * x * z;
  const yy = 2 * y * y, yz = 2 * y * z, zz = 2 * z * z;
  const wx = 2 * w * x, wy = 2 * w * y, wz = 2 * w * z;
  out[0] = 1 - yy - zz;
  out[1] = xy + wz;
  out[2] = xz - wy;
  out[3] = 0;
  out[4] = xy - wz;
  out[5] = 1 - xx - zz;
  out[6] = yz + wx;
  out[7] = 0;
  out[8] = xz + wy;
  out[9] = yz - wx;
  out[10] = 1 - xx - yy;
  out[11] = 0;
  out[12] = translation[0];
  out[13] = translation[1];
  out[14] = translation[2];
  out[15] = 1;
  return out;
}

/** Inverse-transpose of the linear 3×3 part of an affine transform. */
export function mat3NormalFromMat4(m: Mat4, out?: Mat3): Mat3 | null {
  const ax = m[0]!, ay = m[1]!, az = m[2]!;
  const bx = m[4]!, by = m[5]!, bz = m[6]!;
  const cx = m[8]!, cy = m[9]!, cz = m[10]!;
  const nx = by * cz - bz * cy;
  const ny = bz * cx - bx * cz;
  const nz = bx * cy - by * cx;
  const det = ax * nx + ay * ny + az * nz;
  if (!Number.isFinite(det) || det === 0) return null;

  const scale = 1 / det;
  out ??= new Float32Array(9);
  out[0] = nx * scale;
  out[1] = ny * scale;
  out[2] = nz * scale;
  out[3] = (cy * az - cz * ay) * scale;
  out[4] = (cz * ax - cx * az) * scale;
  out[5] = (cx * ay - cy * ax) * scale;
  out[6] = (ay * bz - az * by) * scale;
  out[7] = (az * bx - ax * bz) * scale;
  out[8] = (ax * by - ay * bx) * scale;
  return out;
}
