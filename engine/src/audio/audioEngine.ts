import { clamp, lerp } from "../math/mat4";

export type AudioEngineState = "locked" | "running" | "suspended" | "unavailable" | "closed";
export type AudioBus = "master" | "sfx" | "engine" | "ui";
export type TyreSurface = "asphalt" | "wet" | "dirt" | "gravel" | "grass" | "sand" | "ice";
export type MenuSound = "navigate" | "confirm" | "back";
export type CountdownStep = 3 | 2 | 1 | "GO";
export type Effect = "boost" | "collision" | "gearShift" | `menu:${MenuSound}` | `countdown:${CountdownStep}`;

export interface SampleLoop {
  loopStartFrame: number;
  /** Inclusive end frame, as stored by a WAV smpl chunk. */
  loopEndFrame: number;
  /** Sample rate of the original WAV, before any decodeAudioData resampling. */
  sampleRate: number;
}

export interface AudioSample {
  buffer: AudioBuffer;
  loop?: SampleLoop;
}

export type EngineLayerRole =
  | "HIGH_LOADED" | "HIGH_UNLOADED" | "LOW_LOADED" | "LOW_UNLOADED"
  | "TICKOVER" | "SUPERCHARGER" | "TURBO" | "GEARBOX_WHINE";

export interface EngineLayer extends AudioSample {
  role: EngineLayerRole;
  /** RPM at which the sample plays at its recorded pitch. */
  referenceRpm: number;
  /** Linear gain in [0, 1], before the crossfade. */
  maxGain?: number;
}

export interface EngineBank {
  layers: readonly EngineLayer[];
  pitchMultiplier?: number;
}

export interface DrivingAudioState {
  rpm: number;
  idleRpm: number;
  redlineRpm: number;
  /** Throttle or engine load in [0, 1]. */
  throttle: number;
  speedMps: number;
  /** Magnitude of tyre slip mapped to [0, 1] by the vehicle simulation. */
  tyreSlip: number;
  surface: TyreSurface;
}

export interface AudioEngineOptions {
  createContext?: () => AudioContext;
  /** Defaults to window. Pass null to call resume() from a custom gesture handler. */
  unlockTarget?: EventTarget | null;
}

interface SampleVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

interface EngineVoice extends SampleVoice {
  layer: EngineLayer;
  weight: number;
}

interface NoiseVoice {
  filter: BiquadFilterNode;
  gain: GainNode;
}

interface AudioGraph {
  buses: Record<AudioBus, GainNode>;
  motorGain: GainNode;
  motorFilter: BiquadFilterNode;
  motor: OscillatorNode;
  motorHarmonic: OscillatorNode;
  wind: NoiseVoice;
  skid: NoiseVoice;
  skidNoiseGain: GainNode;
  noiseBuffer: AudioBuffer;
}

const SURFACES: Record<TyreSurface, { frequency: number; resonance: number; gain: number }> = {
  asphalt: { frequency: 2150, resonance: 5, gain: 1 },
  wet: { frequency: 1900, resonance: 3, gain: 0.82 },
  dirt: { frequency: 680, resonance: 0.9, gain: 0.76 },
  gravel: { frequency: 920, resonance: 1.1, gain: 1.1 },
  grass: { frequency: 460, resonance: 0.6, gain: 0.64 },
  sand: { frequency: 520, resonance: 0.7, gain: 0.72 },
  ice: { frequency: 1450, resonance: 2, gain: 0.4 },
};

function smoothstep(min: number, max: number, value: number): number {
  const t = clamp((value - min) / (max - min), 0, 1);
  return t * t * (3 - 2 * t);
}

function smooth(param: AudioParam, value: number, time: number): void {
  param.cancelScheduledValues(time);
  param.setTargetAtTime(value, time, 0.035);
}

function makeGain(ctx: AudioContext, destination: AudioNode, initial = 0): GainNode {
  const gain = ctx.createGain();
  gain.gain.value = initial;
  gain.connect(destination);
  return gain;
}

function makeNoiseVoice(
  ctx: AudioContext, source: AudioBufferSourceNode, destination: GainNode, type: BiquadFilterType,
): NoiseVoice {
  const gain = makeGain(ctx, destination);
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.connect(gain);
  source.connect(filter);
  return { filter, gain };
}

function makeLoop(
  ctx: AudioContext, destination: AudioNode, { buffer, loop }: AudioSample,
): SampleVoice {
  const gain = makeGain(ctx, destination);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;

  if (loop && Number.isFinite(loop.sampleRate) && loop.sampleRate > 0 &&
      Number.isInteger(loop.loopStartFrame) && Number.isInteger(loop.loopEndFrame) &&
      loop.loopStartFrame >= 0 && loop.loopEndFrame >= loop.loopStartFrame) {
    const start = loop.loopStartFrame / loop.sampleRate;
    const end = Math.min((loop.loopEndFrame + 1) / loop.sampleRate, buffer.duration);
    if (end > start) {
      source.loopStart = start;
      source.loopEnd = end;
    }
  }

  source.connect(gain);
  source.onended = () => {
    source.disconnect();
    gain.disconnect();
  };
  source.start();
  return { source, gain };
}

function retireLoop(voice: SampleVoice, now: number): void {
  smooth(voice.gain.gain, 0, now);
  voice.source.stop(now + 0.18);
}

function isPrimaryLayer(role: EngineLayerRole): boolean {
  return role !== "SUPERCHARGER" && role !== "TURBO" && role !== "GEARBOX_WHINE";
}

function layerWeight(role: EngineLayerRole, revs: number, high: number, load: number): number {
  // A small floor lets a partial bank cover the full driving range.
  switch (role) {
    case "HIGH_LOADED": return 0.02 + high * load;
    case "HIGH_UNLOADED": return 0.02 + high * (1 - load);
    case "LOW_LOADED": return 0.02 + (1 - high) * load;
    case "LOW_UNLOADED": return 0.02 + (1 - high) * (1 - load);
    case "TICKOVER": return 0.02 + 2 * (1 - smoothstep(0, 0.23, revs));
    case "SUPERCHARGER": return load * smoothstep(0.18, 0.8, revs) * 0.2;
    case "TURBO": return load * smoothstep(0.3, 0.75, revs) * 0.2;
    case "GEARBOX_WHINE": return smoothstep(0.08, 0.85, revs) * 0.12;
  }
}

/** Browser-only playback with state and mix controls that also work headlessly. */
export class AudioEngine {
  private readonly createContext?: () => AudioContext;
  private unlockTarget?: EventTarget;
  private context?: AudioContext;
  private graph?: AudioGraph;
  private disposed = false;

  private readonly volumes: Record<AudioBus, number> = { master: 1, sfx: 1, engine: 1, ui: 1 };
  private isMuted = false;
  private readonly driving: DrivingAudioState = {
    rpm: 0, idleRpm: 850, redlineRpm: 7000, throttle: 0, speedMps: 0, tyreSlip: 0, surface: "asphalt",
  };

  private bank?: EngineBank;
  private engineVoices: EngineVoice[] = [];
  private skidSample?: AudioSample;
  private skidVoice?: SampleVoice;
  private windSample?: AudioSample;
  private windVoice?: SampleVoice;
  private readonly effects = new Map<Effect, AudioBuffer>();

  private readonly unlock = (): void => {
    void this.resume();
  };

  constructor(options: AudioEngineOptions = {}) {
    const browser = typeof window === "undefined" ? undefined : window;
    const Context = browser?.AudioContext;
    this.createContext = options.createContext ?? (Context && (() => new Context()));
    const target = options.unlockTarget === undefined ? browser : options.unlockTarget;
    if (target && this.createContext) {
      this.unlockTarget = target;
      target.addEventListener("pointerup", this.unlock, { passive: true });
      target.addEventListener("keydown", this.unlock);
    }
  }

  get state(): AudioEngineState {
    if (this.disposed || this.context?.state === "closed") return "closed";
    if (!this.createContext) return "unavailable";
    if (!this.graph) return "locked";
    return this.context?.state === "running" ? "running" : "suspended";
  }

  get muted(): boolean {
    return this.isMuted;
  }

  /** Call from a user gesture when the browser requires audio unlock. */
  async resume(): Promise<boolean> {
    if (!this.createContext || this.state === "closed") return false;
    try {
      const ctx = this.context ??= this.createContext();
      if (ctx.state !== "running") await ctx.resume();
      if (this.disposed || ctx.state !== "running") return false;
      if (!this.graph) {
        this.graph = this.createGraph(ctx);
        this.replaceEngineVoices();
        this.replaceSkidVoice();
        this.replaceWindVoice();
        this.applyDrivingState();
      }
      this.removeUnlockListeners();
      return true;
    } catch {
      // The gesture listeners remain attached so a blocked attempt can be retried.
      return false;
    }
  }

  private removeUnlockListeners(): void {
    this.unlockTarget?.removeEventListener("pointerup", this.unlock);
    this.unlockTarget?.removeEventListener("keydown", this.unlock);
    this.unlockTarget = undefined;
  }

  setMuted(muted: boolean): void {
    this.isMuted = muted;
    this.applyVolume("master");
  }

  getVolume(bus: AudioBus): number {
    return this.volumes[bus];
  }

  setVolume(bus: AudioBus, value: number): void {
    if (!Number.isFinite(value)) return;
    this.volumes[bus] = clamp(value, 0, 1);
    this.applyVolume(bus);
  }

  private applyVolume(bus: AudioBus): void {
    if (!this.graph || !this.context) return;
    const volume = bus === "master" && this.isMuted ? 0 : this.volumes[bus];
    smooth(this.graph.buses[bus].gain, volume, this.context.currentTime);
  }

  /** The caller selects the decoded samples and supplies pitch and mix parameters. */
  setEngineBank(bank?: EngineBank): void {
    if (this.disposed) return;
    this.bank = bank;
    this.replaceEngineVoices();
    this.applyDrivingState();
  }

  setSkidSample(sample?: AudioSample): void {
    if (this.disposed) return;
    this.skidSample = sample;
    this.replaceSkidVoice();
    this.applyDrivingState();
  }

  /**
   * Looped wind sample (e.g. `ENGINE_SAMPLE_TYPE_WIND` from SND/GEN_ENG.SPC). When present it replaces the
   * procedural filtered-noise wind; omit it to fall back to the noise voice.
   */
  setWindSample(sample?: AudioSample): void {
    if (this.disposed) return;
    this.windSample = sample;
    this.replaceWindVoice();
    this.applyDrivingState();
  }

  get hasWindSample(): boolean {
    return this.windSample !== undefined;
  }

  setEffectSample(effect: Effect, buffer?: AudioBuffer): void {
    if (this.disposed) return;
    if (buffer) this.effects.set(effect, buffer);
    else this.effects.delete(effect);
  }

  /** Decode a RIFF/WAVE byte buffer using the active AudioContext (returns null if locked/unavailable). */
  async decodeWave(bytes: Uint8Array): Promise<AudioBuffer | null> {
    if (!this.context || this.disposed) return null;
    try {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return await this.context.decodeAudioData(copy.buffer);
    } catch {
      return null;
    }
  }

  /** Update continuous voices. An omitted field keeps its previous value. Zero RPM is off. */
  update(state: Partial<DrivingAudioState>): void {
    const driving = this.driving;
    if (Number.isFinite(state.rpm)) driving.rpm = Math.max(0, state.rpm!);
    if (Number.isFinite(state.idleRpm)) driving.idleRpm = Math.max(1, state.idleRpm!);
    if (Number.isFinite(state.redlineRpm)) driving.redlineRpm = Math.max(2, state.redlineRpm!);
    if (Number.isFinite(state.throttle)) driving.throttle = clamp(state.throttle!, 0, 1);
    if (Number.isFinite(state.speedMps)) driving.speedMps = Math.abs(state.speedMps!);
    if (Number.isFinite(state.tyreSlip)) driving.tyreSlip = clamp(state.tyreSlip!, 0, 1);
    if (state.surface !== undefined) driving.surface = state.surface;
    this.applyDrivingState();
  }

  playBoost(): void {
    if (this.playSample("boost", "sfx", 0.42, 1)) return;
    this.playNoise("highpass", 260, 1550, 0.38, 0.32, 0.035);
  }

  /** Scale impact loudness and pitch by collision impulse in N·s. */
  playCollision(impulse: number): void {
    if (!Number.isFinite(impulse) || impulse <= 0) return;
    const strength = 1 - Math.exp(-impulse / 2000);
    if (this.playSample("collision", "sfx", 0.8 * strength, lerp(1.22, 0.8, strength))) return;
    this.playNoise("lowpass", lerp(650, 2800, strength), 130, 0.22, 0.64 * strength, 0.006);
    this.playTone("sfx", "sine", lerp(95, 65, strength), 36, 0.18, 0.23 * strength);
  }

  playGearShift(): void {
    if (this.playSample("gearShift", "sfx", 0.28, 1)) return;
    this.playTone("sfx", "triangle", 230, 100, 0.09, 0.13);
    this.playNoise("bandpass", 900, 380, 0.055, 0.12, 0.004);
  }

  playCountdown(step: CountdownStep): void {
    if (this.playSample(`countdown:${step}`, "ui", 0.52, 1)) return;
    if (step === "GO") {
      this.playTone("ui", "triangle", 659, 659, 0.12, 0.18);
      this.playTone("ui", "triangle", 988, 988, 0.24, 0.2, 0.09);
    } else {
      const pitch = step === 1 ? 587 : step === 2 ? 523 : 440;
      this.playTone("ui", "triangle", pitch, pitch, 0.15, 0.18);
    }
  }

  playMenu(sound: MenuSound): void {
    if (this.playSample(`menu:${sound}`, "ui", 0.4, 1)) return;
    switch (sound) {
      case "navigate":
        this.playTone("ui", "triangle", 880, 1050, 0.05, 0.12);
        break;
      case "confirm":
        this.playTone("ui", "triangle", 659, 784, 0.08, 0.16);
        this.playTone("ui", "triangle", 988, 1175, 0.10, 0.15, 0.045);
        break;
      case "back":
        this.playTone("ui", "triangle", 520, 300, 0.1, 0.15);
        break;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.removeUnlockListeners();
    const ctx = this.context;
    this.context = undefined;
    this.graph = undefined;
    this.engineVoices = [];
    this.bank = undefined;
    this.skidVoice = undefined;
    this.skidSample = undefined;
    this.windVoice = undefined;
    this.windSample = undefined;
    this.effects.clear();
    if (ctx && ctx.state !== "closed") {
      await ctx.close().catch(() => undefined);
    }
  }

  private createGraph(ctx: AudioContext): AudioGraph {
    const master = makeGain(ctx, ctx.destination, this.isMuted ? 0 : this.volumes.master);
    const engine = makeGain(ctx, master, this.volumes.engine);
    const sfx = makeGain(ctx, master, this.volumes.sfx);
    const ui = makeGain(ctx, master, this.volumes.ui);

    const motorGain = makeGain(ctx, engine);
    const motorFilter = ctx.createBiquadFilter();
    motorFilter.type = "lowpass";
    motorFilter.Q.value = 0.8;
    motorFilter.connect(motorGain);

    const motor = ctx.createOscillator();
    motor.type = "sawtooth";
    motor.connect(motorFilter);
    motor.start();

    const motorHarmonic = ctx.createOscillator();
    motorHarmonic.type = "triangle";
    motorHarmonic.connect(makeGain(ctx, motorFilter, 0.45));
    motorHarmonic.start();

    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    noise.loop = true;
    const wind = makeNoiseVoice(ctx, noise, sfx, "lowpass");
    wind.filter.Q.value = 0.65;
    const skidGain = makeGain(ctx, sfx);
    const skidFilter = ctx.createBiquadFilter();
    skidFilter.type = "bandpass";
    skidFilter.connect(skidGain);
    const skidNoiseGain = makeGain(ctx, skidFilter, 1);
    noise.connect(skidNoiseGain);
    noise.start();

    return {
      buses: { master, sfx, engine, ui },
      motorGain, motorFilter, motor, motorHarmonic, wind,
      skid: { filter: skidFilter, gain: skidGain },
      skidNoiseGain, noiseBuffer,
    };
  }

  private replaceEngineVoices(): void {
    const ctx = this.context;
    const graph = this.graph;
    if (!ctx || !graph || ctx.state === "closed") return;
    for (const voice of this.engineVoices) retireLoop(voice, ctx.currentTime);
    this.engineVoices = this.bank?.layers.map((layer) => ({
      ...makeLoop(ctx, graph.buses.engine, layer),
      layer,
      weight: 0,
    })) ?? [];
  }

  private replaceSkidVoice(): void {
    const ctx = this.context;
    const graph = this.graph;
    if (!ctx || !graph || ctx.state === "closed") return;
    if (this.skidVoice) retireLoop(this.skidVoice, ctx.currentTime);
    this.skidVoice = this.skidSample && makeLoop(ctx, graph.skid.filter, this.skidSample);
  }

  private replaceWindVoice(): void {
    const ctx = this.context;
    const graph = this.graph;
    if (!ctx || !graph || ctx.state === "closed") return;
    if (this.windVoice) retireLoop(this.windVoice, ctx.currentTime);
    this.windVoice = this.windSample && makeLoop(ctx, graph.buses.sfx, this.windSample);
  }

  private applyDrivingState(): void {
    const ctx = this.context;
    const graph = this.graph;
    if (!ctx || !graph || ctx.state === "closed") return;

    const now = ctx.currentTime;
    const { rpm, idleRpm, redlineRpm, throttle, speedMps, tyreSlip, surface } = this.driving;
    const revs = clamp((rpm - idleRpm) / Math.max(1, redlineRpm - idleRpm), 0, 1);
    const running = smoothstep(0, idleRpm * 0.65, rpm);
    const high = smoothstep(0.25, 0.78, revs);
    const load = smoothstep(0.05, 0.92, throttle);
    const bankPitch = this.bank?.pitchMultiplier ?? 1;
    const pitch = Number.isFinite(bankPitch) && bankPitch > 0 ? bankPitch : 1;

    let primaryWeight = 0;
    for (const voice of this.engineVoices) {
      voice.weight = layerWeight(voice.layer.role, revs, high, load);
      if (isPrimaryLayer(voice.layer.role)) primaryWeight += voice.weight;
    }
    for (const { source, gain, layer, weight } of this.engineVoices) {
      const reference = Number.isFinite(layer.referenceRpm) && layer.referenceRpm > 0
        ? layer.referenceRpm : idleRpm;
      const rate = clamp((rpm / reference) * pitch, 0.3, 3);
      const maxGain = layer.maxGain !== undefined && Number.isFinite(layer.maxGain)
        ? clamp(layer.maxGain, 0, 1) : 1;
      const mix = isPrimaryLayer(layer.role) ? weight / primaryWeight : weight;
      smooth(source.playbackRate, rate, now);
      smooth(gain.gain, mix * maxGain * running * 0.56, now);
    }

    const firingHz = clamp(rpm / 30, 21, 370);
    smooth(graph.motor.frequency, firingHz, now);
    smooth(graph.motorHarmonic.frequency, firingHz * 2, now);
    smooth(graph.motorFilter.frequency, 145 + 1100 * revs + 900 * load, now);
    smooth(graph.motorGain.gain, primaryWeight > 0 ? 0 : running * (0.1 + 0.14 * load), now);

    const wind = smoothstep(12, 75, speedMps);
    smooth(graph.wind.filter.frequency, lerp(320, 3400, wind), now);
    smooth(graph.wind.gain.gain, this.windVoice ? 0 : 0.23 * wind, now);
    if (this.windVoice) {
      smooth(this.windVoice.source.playbackRate, lerp(0.85, 1.25, wind), now);
      smooth(this.windVoice.gain.gain, 0.3 * wind, now);
    }

    const tyre = SURFACES[surface];
    const slip = smoothstep(0.11, 0.92, tyreSlip);
    smooth(graph.skid.filter.frequency, tyre.frequency * lerp(0.8, 1.22, tyreSlip), now);
    smooth(graph.skid.filter.Q, tyre.resonance, now);
    smooth(graph.skid.gain.gain, slip * tyre.gain * 0.42, now);
    smooth(graph.skidNoiseGain.gain, this.skidVoice ? 0 : 1, now);
    if (this.skidVoice) {
      smooth(this.skidVoice.source.playbackRate, lerp(0.76, 1.28, tyreSlip), now);
      smooth(this.skidVoice.gain.gain, 1, now);
    }
  }

  private playSample(effect: Effect, bus: AudioBus, level: number, rate: number): boolean {
    const ctx = this.context;
    const graph = this.graph;
    const buffer = this.effects.get(effect);
    if (ctx?.state !== "running" || !graph || !buffer) return false;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const gain = makeGain(ctx, graph.buses[bus], level);
    source.connect(gain);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
    };
    source.start();
    return true;
  }

  private playTone(
    bus: AudioBus, type: OscillatorType, startHz: number, endHz: number,
    duration: number, level: number, delay = 0,
  ): void {
    const ctx = this.context;
    const graph = this.graph;
    if (ctx?.state !== "running" || !graph || level <= 0) return;
    const start = ctx.currentTime + delay;
    const oscillator = ctx.createOscillator();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(startHz, start);
    oscillator.frequency.exponentialRampToValueAtTime(endHz, start + duration);
    this.playEnvelope(oscillator, graph.buses[bus], start, duration, level, 0.006);
  }

  private playNoise(
    type: BiquadFilterType, startHz: number, endHz: number, duration: number, level: number, attack: number,
  ): void {
    const ctx = this.context;
    const graph = this.graph;
    if (ctx?.state !== "running" || !graph || level <= 0) return;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = graph.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(startHz, now);
    filter.frequency.exponentialRampToValueAtTime(endHz, now + duration);
    this.playEnvelope(source, graph.buses.sfx, now, duration, level, attack, filter);
  }

  private playEnvelope(
    source: AudioScheduledSourceNode, destination: GainNode, start: number,
    duration: number, level: number, attack: number, filter?: BiquadFilterNode,
  ): void {
    // A context always exists when a voice has been created.
    const gain = makeGain(this.context!, destination);
    const end = start + duration;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(level, start + attack);
    gain.gain.exponentialRampToValueAtTime(Math.min(level, 0.0001), end);
    source.connect(filter ?? gain);
    filter?.connect(gain);
    source.onended = () => {
      source.disconnect();
      filter?.disconnect();
      gain.disconnect();
    };
    source.start(start);
    source.stop(end);
  }
}
