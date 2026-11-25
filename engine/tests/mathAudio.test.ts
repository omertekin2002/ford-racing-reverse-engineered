import assert from "node:assert/strict";
import test from "node:test";
import { AudioEngine } from "../src/audio/audioEngine";
import {
  clamp, fromEulerYXZ, fromRotationTranslation, identity, invert, lerp, lerpAngle, lookAtLH,
  mat3NormalFromMat4, mat4FromQuatTranslation, multiply, perspectiveLH, quatFromAxisAngle,
  quatMultiply, quatSlerp, transformDirection, transformPoint, wrapAngle,
} from "../src/math/mat4";

function near(actual: number, expected: number, tolerance = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

function nearArray(actual: ArrayLike<number>, expected: ArrayLike<number>, tolerance?: number): void {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) near(actual[i]!, expected[i]!, tolerance);
}

test("perspectiveLH uses +Z depth and WebGL near/far clipping", () => {
  const projection = perspectiveLH(Math.PI / 2, 2, 0.1, 4000);
  nearArray(transformPoint(projection, [0, 0, 0.1]), [0, 0, -1]);
  nearArray(transformPoint(projection, [0, 0, 4000]), [0, 0, 1]);
  nearArray(transformPoint(projection, [6, 3, 3]).slice(0, 2), [1, 1]);
  assert.ok(transformPoint(projection, [0, 0, 0.05])[2] < -1);
  const infinite = perspectiveLH(Math.PI / 2, 1, 1, Infinity);
  near(transformPoint(infinite, [0, 0, 1])[2], -1);
  near(transformPoint(infinite, [0, 0, 1e8])[2], 1);
});

test("lookAtLH sends the eye to the origin and points along positive view depth", () => {
  const view = lookAtLH([3, 2, -1], [4, 2, -1], [0, 1, 0]);
  nearArray(transformPoint(view, [3, 2, -1]), [0, 0, 0]);
  nearArray(transformPoint(view, [4, 2, -1]), [0, 0, 1]);
  nearArray(transformPoint(view, [3, 3, -2]), [1, 1, 0]);
  nearArray(lookAtLH([0, 0, 0], [0, 0, 0], [0, 0, 0]), identity());
  const vertical = lookAtLH([0, 0, 0], [0, 5, 0], [0, 1, 0]);
  nearArray(transformPoint(vertical, [0, 5, 0]), [0, 0, 5]);
});

test("multiply composes local then parent and supports either input as the output", () => {
  const local = fromEulerYXZ(Math.PI / 2, 0, 0);
  const parent = fromRotationTranslation([1, 0, 0, 0, 1, 0, 0, 0, 1], [4, 5, 6]);
  const model = multiply(parent, local);
  assert.ok(model instanceof Float32Array);
  nearArray(transformPoint(model, [0, 0, 2]), [6, 5, 6]);
  nearArray(transformDirection(model, [0, 0, 2]), [2, 0, 0]);
  const a = parent.slice();
  const b = local.slice();
  assert.equal(multiply(a, local, a), a);
  assert.equal(multiply(parent, b, b), b);
  nearArray(a, model);
  nearArray(b, model);
});

test("invert round-trips view/projection transforms and handles a singular matrix", () => {
  const view = lookAtLH([3, 2, -4], [1, 0, 3], [0, 1, 0]);
  const combined = multiply(perspectiveLH(Math.PI / 3, 1.7, 0.5, 200), view);
  const inverse = invert(combined);
  assert.ok(inverse);
  const point: [number, number, number] = [2, 1, 9];
  transformPoint(combined, point, point);
  transformPoint(inverse, point, point);
  nearArray(point, [2, 1, 9], 1e-5);

  const inPlace = combined.slice();
  assert.equal(invert(inPlace, inPlace), inPlace);
  nearArray(multiply(combined, inPlace), identity(), 1e-6);

  const sentinel = identity();
  assert.equal(invert(new Float32Array(16), sentinel), null);
  nearArray(sentinel, identity());
});

test("axis-angle quaternions and Euler YXZ produce the same composed rotation", () => {
  const yaw = quatFromAxisAngle([0, 10, 0], Math.PI / 2);
  nearArray(yaw, [0, Math.SQRT1_2, 0, Math.SQRT1_2]);
  nearArray(quatFromAxisAngle([0, 0, 0], 3), [0, 0, 0, 1]);
  const model = mat4FromQuatTranslation(yaw, [5, 3, -2]);
  nearArray(transformPoint(model, [0, 0, 2]), [7, 3, -2]);

  const pitch = quatFromAxisAngle([1, 0, 0], 0.72);
  const roll = quatFromAxisAngle([0, 0, 1], -0.35);
  const rotation = quatMultiply(yaw, pitch);
  quatMultiply(rotation, roll, rotation);
  nearArray(mat4FromQuatTranslation(rotation, [0, 0, 0]), fromEulerYXZ(Math.PI / 2, 0.72, -0.35));
});

test("quatSlerp takes the shortest arc and remains normalized", () => {
  const start = quatFromAxisAngle([0, 1, 0], 0);
  const end = quatFromAxisAngle([0, 1, 0], 3 * Math.PI / 2);
  const midpoint = quatSlerp(start, end, 0.5);
  nearArray(midpoint, quatFromAxisAngle([0, 1, 0], -Math.PI / 4));
  near(Math.hypot(...midpoint), 1);
  nearArray(quatSlerp(midpoint, midpoint, 0.5, midpoint), quatFromAxisAngle([0, 1, 0], -Math.PI / 4));
});

test("normal matrices compensate for nonuniform scale and shear", () => {
  const model = fromRotationTranslation([2, 0, 0, 1, 3, 0, 0, 0, 4], [7, -2, 1]);
  const normal = mat3NormalFromMat4(model);
  assert.ok(normal);
  nearArray(normal, [0.5, -1 / 6, 0, 0, 1 / 3, 0, 0, 0, 0.25]);
  const tangent = transformDirection(model, [0, 1, 0]);
  near(normal[0]! * tangent[0] + normal[1]! * tangent[1] + normal[2]! * tangent[2], 0);
  assert.equal(mat3NormalFromMat4(new Float32Array(16)), null);
});

test("angle helpers wrap across pi", () => {
  assert.equal(clamp(-1, 0, 1), 0);
  assert.equal(lerp(3, 9, 0.25), 4.5);
  near(wrapAngle(5 * Math.PI), -Math.PI);
  near(wrapAngle(-3 * Math.PI / 2), Math.PI / 2);
  near(lerpAngle(0.9 * Math.PI, -0.9 * Math.PI, 0.5), -Math.PI);
});

test("AudioEngine works with window and AudioContext absent", async () => {
  const audio = new AudioEngine();
  assert.equal(audio.state, "unavailable");
  assert.equal(await audio.resume(), false);

  audio.setVolume("master", 1.4);
  audio.setVolume("sfx", -1);
  audio.setVolume("engine", 0.45);
  audio.setVolume("ui", 0.35);
  audio.setVolume("ui", NaN);
  assert.equal(audio.getVolume("master"), 1);
  assert.equal(audio.getVolume("sfx"), 0);
  assert.equal(audio.getVolume("engine"), 0.45);
  assert.equal(audio.getVolume("ui"), 0.35);
  audio.setMuted(true);
  assert.equal(audio.muted, true);
  audio.setMuted(false);
  assert.equal(audio.muted, false);

  audio.update({ rpm: 5200, throttle: 1, speedMps: 55, tyreSlip: 0.8, surface: "gravel" });
  audio.setEngineBank({ layers: [] });
  audio.setSkidSample();
  audio.setEffectSample("boost");
  audio.playBoost();
  audio.playCollision(600);
  audio.playGearShift();
  audio.playCountdown(3);
  audio.playCountdown(2);
  audio.playCountdown(1);
  audio.playCountdown("GO");
  audio.playMenu("navigate");
  audio.playMenu("confirm");
  audio.playMenu("back");

  await audio.dispose();
  await audio.dispose();
  assert.equal(audio.state, "closed");
  assert.equal(await audio.resume(), false);
});

class MockParam {
  constructor(public value = 0) {}
  cancelScheduledValues(): void {}
  setTargetAtTime(value: number): void { this.value = value; }
  setValueAtTime(value: number): void { this.value = value; }
  exponentialRampToValueAtTime(value: number): void { this.value = value; }
  linearRampToValueAtTime(value: number): void { this.value = value; }
}

class MockNode {
  readonly outputs: MockNode[] = [];

  connect(destination: MockNode): MockNode {
    this.outputs.push(destination);
    return destination;
  }

  disconnect(): void {
    this.outputs.length = 0;
  }
}

class MockGain extends MockNode {
  readonly gain = new MockParam(1);
}

class MockFilter extends MockNode {
  type: BiquadFilterType = "lowpass";
  readonly frequency = new MockParam();
  readonly Q = new MockParam();
}

class MockSource extends MockNode {
  onended?: () => void;
  started = false;
  stopTime?: number;
  start(): void { this.started = true; }
  stop(time: number): void { this.stopTime = time; }
}

class MockOscillator extends MockSource {
  readonly frequency = new MockParam();
}

class MockBufferSource extends MockSource {
  buffer?: MockBuffer;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate = new MockParam(1);
}

class MockBuffer {
  readonly duration: number;
  private readonly channelData: Float32Array;

  constructor(length: number, rate: number) {
    this.duration = length / rate;
    this.channelData = new Float32Array(length);
  }

  getChannelData(): Float32Array { return this.channelData; }
}

class MockContext {
  state: AudioContextState = "suspended";
  rejectResume = false;
  resumeCalls = 0;
  closeCalls = 0;
  readonly currentTime = 5;
  readonly sampleRate = 48000;
  readonly destination = new MockNode();
  readonly oscillators: MockOscillator[] = [];
  readonly sources: MockBufferSource[] = [];
  readonly filters: MockFilter[] = [];
  readonly gains: MockGain[] = [];

  async resume(): Promise<void> {
    this.resumeCalls++;
    if (this.rejectResume) throw new Error("Awaiting activation");
    this.state = "running";
  }

  async close(): Promise<void> {
    this.closeCalls++;
    this.state = "closed";
  }

  createOscillator(): MockOscillator {
    const oscillator = new MockOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createBufferSource(): MockBufferSource {
    const source = new MockBufferSource();
    this.sources.push(source);
    return source;
  }

  createGain(): MockGain {
    const gain = new MockGain();
    this.gains.push(gain);
    return gain;
  }

  createBiquadFilter(): MockFilter {
    const filter = new MockFilter();
    this.filters.push(filter);
    return filter;
  }

  createBuffer(_channels: number, frames: number, sampleRate: number): MockBuffer {
    return new MockBuffer(frames, sampleRate);
  }
}

test("AudioEngine lazily unlocks, retries after a failed resume, and closes once", async () => {
  const ctx = new MockContext();
  const target = new EventTarget();
  let contextCreations = 0;
  const audio = new AudioEngine({
    unlockTarget: target,
    createContext: () => {
      contextCreations++;
      return ctx as unknown as AudioContext;
    },
  });
  assert.equal(audio.state, "locked");
  assert.equal(contextCreations, 0);
  ctx.rejectResume = true;
  assert.equal(await audio.resume(), false);
  assert.equal(audio.state, "locked");
  assert.equal(ctx.gains.length, 0);

  audio.setMuted(true);
  audio.setVolume("master", 0.7);
  audio.setVolume("engine", 0.4);
  ctx.rejectResume = false;
  target.dispatchEvent(new Event("keydown"));
  await Promise.resolve();
  assert.equal(audio.state, "running");
  assert.equal(contextCreations, 1);
  assert.equal(ctx.resumeCalls, 2);
  assert.equal(ctx.gains[0]!.gain.value, 0);
  near(ctx.gains[1]!.gain.value, 0.4);
  audio.setMuted(false);
  near(ctx.gains[0]!.gain.value, 0.7);
  const gainCount = ctx.gains.length;

  ctx.state = "suspended";
  assert.equal(audio.state, "suspended");
  target.dispatchEvent(new Event("keydown"));
  assert.equal(ctx.resumeCalls, 2);
  assert.equal(await audio.resume(), true);
  assert.equal(ctx.gains.length, gainCount);
  await audio.dispose();
  await audio.dispose();
  assert.equal(ctx.closeCalls, 1);
  assert.equal(audio.state, "closed");
});

test("loaded engine voices crossfade by throttle and RPM and honor WAV loop frames", async () => {
  const ctx = new MockContext();
  const audio = new AudioEngine({ createContext: () => ctx as unknown as AudioContext });
  const buffer = ctx.createBuffer(1, 48000, 48000) as unknown as AudioBuffer;
  await audio.resume();

  audio.update({ rpm: 2000, throttle: 0 });
  const motorFilter = ctx.oscillators[0]!.outputs[0]!;
  const motorGain = motorFilter.outputs[0] as MockGain;
  assert.ok(motorGain.gain.value > 0);

  audio.setEngineBank({
    pitchMultiplier: 1.1,
    layers: [
      { role: "LOW_UNLOADED", referenceRpm: 2000, buffer },
      { role: "LOW_LOADED", referenceRpm: 2000, buffer },
      {
        role: "HIGH_LOADED", referenceRpm: 5000, buffer,
        loop: { loopStartFrame: 5512, loopEndFrame: 16536, sampleRate: 22050 },
      },
    ],
  });

  const [, unloaded, loaded, high] = ctx.sources;
  assert.ok(unloaded?.started && loaded?.started && high?.started);
  assert.equal(high.loop, true);
  near(high.loopStart, 5512 / 22050);
  near(high.loopEnd, 16537 / 22050);
  near(unloaded.playbackRate.value, 1.1);
  assert.equal(motorGain.gain.value, 0);
  const gainOf = (source: MockBufferSource) => (source.outputs[0] as MockGain).gain.value;
  assert.ok(gainOf(unloaded) > gainOf(loaded));
  audio.update({ throttle: 1 });
  assert.ok(gainOf(loaded) > gainOf(unloaded));
  assert.ok(gainOf(loaded) > gainOf(high));
  audio.update({ rpm: 6000 });
  assert.ok(gainOf(high) > gainOf(loaded));
  near(high.playbackRate.value, 1.32);
  audio.update({ rpm: 0 });
  near(gainOf(high), 0);

  audio.setEngineBank();
  audio.update({ rpm: 1800 });
  assert.ok(motorGain.gain.value > 0);
  assert.ok(high.stopTime! > ctx.currentTime);
  await audio.dispose();
});

test("skid and wind respond to driving, and one-shots route to their mix buses", async () => {
  const ctx = new MockContext();
  const audio = new AudioEngine({ createContext: () => ctx as unknown as AudioContext });
  const buffer = ctx.createBuffer(1, 48000, 48000) as unknown as AudioBuffer;
  audio.setSkidSample({ buffer });
  audio.setEffectSample("collision", buffer);
  await audio.resume();

  const [noise, skidSample] = ctx.sources;
  assert.ok(noise?.loop && skidSample?.loop);
  const skidSampleGain = skidSample.outputs[0] as MockGain;
  const skidFilter = skidSampleGain.outputs[0] as MockFilter;
  const skidGain = skidFilter.outputs[0] as MockGain;
  const windFilter = noise.outputs[0] as MockFilter;
  const windGain = windFilter.outputs[0] as MockGain;
  const skidNoiseGain = noise.outputs[1] as MockGain;

  assert.equal(skidNoiseGain.gain.value, 0);
  assert.equal(skidSampleGain.gain.value, 1);
  assert.equal(skidGain.gain.value, 0);
  assert.equal(windGain.gain.value, 0);
  audio.update({ tyreSlip: 0.8 });
  assert.ok(skidGain.gain.value > 0);
  assert.equal(windGain.gain.value, 0);
  audio.update({ speedMps: 68 });
  assert.ok(windGain.gain.value > 0);
  const asphaltHz = skidFilter.frequency.value;
  audio.update({ surface: "grass" });
  assert.ok(skidFilter.frequency.value < asphaltHz);
  audio.setSkidSample();
  assert.equal(skidNoiseGain.gain.value, 1);

  audio.playCollision(0);
  assert.equal(ctx.sources.length, 2);
  audio.playCollision(200);
  audio.playCollision(4000);
  const [, , light, heavy] = ctx.sources;
  assert.ok(light && heavy);
  const lightGain = light.outputs[0] as MockGain;
  const heavyGain = heavy.outputs[0] as MockGain;
  assert.ok(heavyGain.gain.value > lightGain.gain.value);
  assert.equal(heavyGain.outputs[0], ctx.gains[2]);
  heavy.onended?.();
  assert.equal(heavy.outputs.length, 0);

  audio.playBoost();
  audio.playGearShift();
  audio.playCountdown(3);
  audio.playCountdown(2);
  audio.playCountdown(1);
  audio.playCountdown("GO");
  audio.playMenu("navigate");
  audio.playMenu("confirm");
  audio.playMenu("back");
  const menu = ctx.oscillators.at(-1);
  assert.ok(menu?.started && menu.stopTime! > ctx.currentTime);
  assert.equal(menu.outputs[0]!.outputs[0], ctx.gains[3]);
  assert.equal(ctx.sources.length, 6);
  assert.equal(ctx.oscillators.length, 12);
  await audio.dispose();
});
