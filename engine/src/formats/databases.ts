import type { VirtualFileSystem } from "../vfs/types";

export type Pair = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Quad = readonly [number, number, number, number];
/** Keys are normalized to lower case. Records retain their original identifiers. */
export type Database<T> = ReadonlyMap<string, T>;

export interface TextRow {
  readonly line: number;
  readonly tokens: readonly string[];
}

export interface TextDirective extends TextRow {
  readonly tag: string;
  readonly rows: readonly TextRow[];
}

/**
 * Read the shared text grammar. Exposed for supplemental databases whose
 * directives or numeric slots do not yet have an interpreted schema.
 */
export function readDatabaseText(text: string): {
  readonly preamble: readonly TextRow[];
  readonly directives: readonly TextDirective[];
} {
  const preamble: TextRow[] = [];
  const directives: (TextDirective & { rows: TextRow[] })[] = [];
  for (const [index, source] of text.split(/\r?\n/).entries()) {
    const line = index + 1;
    const raw = source.trim();
    if (!raw || raw.startsWith("//")) continue;
    let tag = /^:([A-Z_][A-Z0-9_]*)(?=\s|$)/i.exec(raw);
    tag ??= /^([A-Z_][A-Z0-9_]*):/i.exec(raw);
    const effectMarker = /^(BEGIN|END):EFFECT(?:\s*\/\/.*)?$/i.exec(raw);
    const name = effectMarker ? `${effectMarker[1]!.toUpperCase()}_EFFECT` : tag?.[1]?.toUpperCase();
    const payload = effectMarker ? "" : tag ? raw.slice(tag[0].length).trim() : raw;
    const tokens: string[] = [];
    const rawDescription = name === "TRACK_TOOL_SCENE_NAME" || name === "TRACK_TOOL_CREATION_DATE";
    if (rawDescription && payload && !payload.startsWith('"')) {
      const description = name === "TRACK_TOOL_SCENE_NAME" && payload.startsWith("//")
        ? payload : payload.split("//", 1)[0]!.trimEnd();
      if (description) tokens.push(description);
    } else {
      let cursor = 0;
      const token = /[\s,]+|"[^"]*"|[^\s,"]+/y;
      while (cursor < payload.length && !payload.startsWith("//", cursor)) {
        token.lastIndex = cursor;
        const match = token.exec(payload);
        if (!match) throw new Error(`Line ${line}: unterminated quoted value`);
        const value = match[0];
        cursor = token.lastIndex;
        if (!/^[\s,]/.test(value)) {
          const comment = value.startsWith('"') ? -1 : value.indexOf("//");
          tokens.push(comment < 0 ? value : value.slice(0, comment));
          if (comment >= 0) break;
        }
      }
    }
    if (name) directives.push({ tag: name, line, tokens, rows: [] });
    else if (tokens.length) (directives.at(-1)?.rows ?? preamble).push({ line, tokens });
  }
  return { preamble, directives };
}

function fail(row: TextRow, message: string): never {
  throw new Error(`Line ${row.line}: ${message}`);
}

class Directives {
  private index = 0;
  constructor(private readonly items: readonly TextDirective[]) {}

  peek() { return this.items[this.index]?.tag; }
  get done() { return this.index === this.items.length; }

  take(expected?: string): TextDirective {
    const item = this.items[this.index];
    if (!item) throw new Error(`Unexpected end of file${expected ? ` (expected :${expected})` : ""}`);
    if (expected && item.tag !== expected) fail(item, `expected :${expected}, got :${item.tag}`);
    this.index++;
    return item;
  }

  end(terminator = true): void {
    if (terminator) mark(this.take("END"));
    if (!this.done) fail(this.take(), "unexpected directive after terminator");
  }
}

function tagged(text: string): Directives {
  const { preamble, directives } = readDatabaseText(text);
  if (preamble[0]) fail(preamble[0], "expected a directive");
  return new Directives(directives);
}

function arity(row: TextRow, count: number): void {
  if ("rows" in row) inline(row as TextDirective);
  tokenArity(row, count);
}

function tokenArity(row: TextRow, count: number): void {
  if (row.tokens.length !== count) fail(row, `expected ${count} values, got ${row.tokens.length}`);
}

function inline(row: TextDirective): TextRow {
  if (row.rows[0]) fail(row.rows[0], `unexpected row after :${row.tag}`);
  return row;
}

function mark(row: TextDirective): void {
  arity(inline(row), 0);
}

function real(row: TextRow, index: number): number {
  const token = row.tokens[index] ?? "";
  const value = Number(token);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(token) || !Number.isFinite(value)) {
    fail(row, `invalid real number "${token}"`);
  }
  return value;
}

function integer(row: TextRow, index: number): number {
  const token = row.tokens[index] ?? "";
  const value = Number(token);
  if (!/^[+-]?\d+$/.test(token) || !Number.isSafeInteger(value)) fail(row, `invalid integer "${token}"`);
  return value;
}

function countValue(row: TextRow): number {
  tokenArity(row, 1);
  const count = integer(row, 0);
  if (count < 0) fail(row, "negative count");
  return count;
}

function identifier(row: TextRow, index: number): string {
  const value = row.tokens[index] ?? "";
  if (!/^[\w.-]+$/.test(value)) fail(row, `invalid identifier "${value}"`);
  return value;
}

function quoted(row: TextRow, index: number): string {
  const value = row.tokens[index];
  if (!value?.startsWith('"')) fail(row, "expected a quoted value");
  return value.slice(1, -1);
}

const scalar = (row: TextRow) => (arity(row, 1), real(row, 0));
const whole = (row: TextRow) => (arity(row, 1), integer(row, 0));
const id = (row: TextRow) => (arity(row, 1), identifier(row, 0));
const label = (row: TextRow) => (arity(row, 1), quoted(row, 0));

function flag(row: TextRow, index = 0): boolean {
  const value = integer(row, index);
  if (value !== 0 && value !== 1) fail(row, "expected flag 0 or 1");
  return value === 1;
}

const bool = (row: TextRow) => (arity(row, 1), flag(row));
const pair = (row: TextRow): Pair => (arity(row, 2), [real(row, 0), real(row, 1)]);
const vec3 = (row: TextRow): Vec3 => (arity(row, 3), [real(row, 0), real(row, 1), real(row, 2)]);
const quad = (row: TextRow): Quad => (arity(row, 4), [real(row, 0), real(row, 1), real(row, 2), real(row, 3)]);

function rows<T>(directive: TextDirective, count: number, parse: (row: TextRow) => T): T[] {
  if (directive.rows.length !== count) {
    fail(directive, `:${directive.tag} expected ${count} rows, got ${directive.rows.length}`);
  }
  return directive.rows.map(parse);
}

function flattened(directive: TextDirective): TextRow {
  return { line: directive.line, tokens: [...directive.tokens, ...directive.rows.flatMap(row => row.tokens)] };
}

type FieldSchema = Record<string, (row: TextDirective) => unknown>;
type Fields<S extends FieldSchema> = { [K in keyof S]: ReturnType<S[K]> };

function field<S extends FieldSchema>(target: Partial<Fields<S>>, schema: S, directive: TextDirective): void {
  const key = directive.tag as keyof S;
  if (!Object.hasOwn(schema, key)) fail(directive, `unexpected :${directive.tag}`);
  const decode = schema[key] as (row: TextDirective) => Fields<S>[typeof key];
  target[key] = decode(directive);
}

function fields<S extends FieldSchema>(input: Directives, schema: S, ...until: string[]): Fields<S>;
function fields<S extends FieldSchema, K extends keyof S & string>(
  input: Directives, schema: S, until: readonly string[], optional: readonly K[],
): Omit<Fields<S>, K> & Partial<Pick<Fields<S>, K>>;
function fields<S extends FieldSchema>(
  input: Directives, schema: S, ...boundaries: string[] | [readonly string[], readonly string[]]
): Partial<Fields<S>> {
  const until = typeof boundaries[0] === "string" ? boundaries as string[] : boundaries[0] ?? [];
  const optional = typeof boundaries[1] === "string" ? [] : boundaries[1] ?? [];
  const result: Partial<Fields<S>> = {};
  while (!input.done && !until.includes(input.peek()!)) {
    const directive = input.take();
    if (Object.hasOwn(result, directive.tag)) fail(directive, `duplicate :${directive.tag}`);
    field(result, schema, directive);
  }
  for (const key of Object.keys(schema)) {
    if (!optional.includes(key) && !Object.hasOwn(result, key)) throw new Error(`Missing :${key}`);
  }
  return result;
}

interface NamedRecord { readonly id: string }
interface InheritingRecord extends NamedRecord { readonly parentId?: string }

function records<T extends NamedRecord>(
  input: Directives, opener: string, parse: (name: string, previous: Database<T>) => T,
  nameReader = id,
): Database<T> {
  const result = new Map<string, T>();
  while (input.peek() !== "END") {
    const start = input.take(opener);
    const name = nameReader(inline(start));
    const key = name.toLowerCase();
    if (result.has(key)) fail(start, `duplicate record "${name}"`);
    result.set(key, parse(name, result));
  }
  input.end();
  return result;
}

function parent<T extends NamedRecord>(directive: TextDirective, previous: Database<T>): T {
  const name = id(inline(directive));
  const record = previous.get(name.toLowerCase());
  if (!record) fail(directive, `parent "${name}" must be declared earlier`);
  return record;
}

const engineSchema = {
  LOCATION_TYPE: id, ASPIRATION_TYPE: id, FUEL_CUTOFF: scalar, ENGINE_BRAKING: scalar,
  TORQUE_MODIFIER: scalar, ROUGHNESS: scalar, MAX_RPM: scalar, CAPACITY: scalar, TICKOVER_RPM: scalar,
  MAX_TURBO_PRESSURE: scalar, FLYWHEEL_MASS: scalar, FLYWHEEL_RADIUS: scalar, ACCELERATOR_SPEED: scalar,
  NUMBER_OF_TURBOS: whole, NUMBER_OF_CYLINDERS: whole, MAX_AIRFLOW: scalar, TURBO_MASS: scalar,
  MAX_FUELFLOW: scalar, MAX_DELTA_FUELFLOW: scalar,
};

export interface EngineRecord extends InheritingRecord {
  readonly fields: Readonly<Partial<Fields<typeof engineSchema>>>;
  readonly torqueCurve: readonly Pair[];
  /** Sequential torque samples in the loader's 18-slot table. */
  readonly torque: readonly number[];
  readonly peakPowerRpm: number;
  readonly inverseTurboMass: number;
}

const rpmScale = Math.fround(0.001);
const powerScale = Math.fround(0.00019040366169065237);

function readEngine(text: string): Directives {
  // This single colon-less inheritance is recognized by the demo loader.
  return tagged(text.replace(/^(\s*:TYPE[ \t]+INDIGO[ \t]*\r?\n(?:[ \t]*(?:\/\/[^\r\n]*)?\r?\n)*[ \t]*)INHERIT_TYPE(?=[ \t]+DEFAULT_TRACK\b)/m, "$1:INHERIT_TYPE"));
}

export function parseEngineDatabase(text: string): Database<EngineRecord> {
  const input = readEngine(text);
  return records<EngineRecord>(input, "TYPE", (name, previous) => {
    let parentId: string | undefined;
    let values: Partial<Fields<typeof engineSchema>> = {};
    let torqueCurve: readonly Pair[] = [];
    let torque: readonly number[] = Array<number>(18).fill(0);
    let peakPowerRpm = 0;
    let inverseTurboMass = 0;
    while (input.peek() !== "TYPE" && input.peek() !== "END") {
      const directive = input.take();
      switch (directive.tag) {
        case "INHERIT_TYPE": {
          const base = parent(directive, previous);
          parentId = base.id;
          values = { ...base.fields };
          torqueCurve = base.torqueCurve;
          torque = base.torque;
          peakPowerRpm = base.peakPowerRpm;
          inverseTurboMass = base.inverseTurboMass;
          break;
        }
        case "TORQUE_ARRAY": {
          tokenArity(directive, 0);
          const maxRpm = Math.fround(values.MAX_RPM ?? 0);
          const count = Math.trunc((maxRpm + 250) * rpmScale) + 1;
          if (maxRpm < 0 || !Number.isFinite(count) || count > 18) fail(directive, "MAX_RPM exceeds torque table bounds");
          torqueCurve = rows(directive, count, pair);
          const samples = Array<number>(18).fill(0);
          torqueCurve.forEach(([, value], index) => { samples[index] = Math.fround(value); });
          torque = samples;
          // Loader 0x0052291c uses a strict comparison and retains the old
          // derived field if no positive score displaces it.
          let bestScore = 0;
          for (let rpm = 0; rpm < maxRpm; rpm += 500) {
            const slot = Math.trunc((rpm + 5) * rpmScale);
            const score = Math.fround(rpm * (samples[slot] ?? 0) * powerScale);
            if (score > bestScore) {
              bestScore = score;
              peakPowerRpm = rpm;
            }
          }
          if (Math.abs(peakPowerRpm - maxRpm) < 1500) peakPowerRpm = Math.fround(maxRpm - 1500);
          break;
        }
        default:
          field(values, engineSchema, directive);
          if (directive.tag === "TURBO_MASS") {
            const mass = Math.fround(scalar(directive));
            inverseTurboMass = mass === 0 ? 1 : Math.fround(1 / mass);
          }
      }
    }
    return { id: name, parentId, fields: values, torqueCurve, torque, peakPowerRpm, inverseTurboMass };
  });
}

const gearboxSchema = {
  CLUTCH_SPEED: scalar, CLUTCH_MAX_POWER: scalar, TORQUE_SHIFT: scalar, DRIVE_SPLIT: scalar,
  TRANSMISSION_TYPE: id, DIFF_TYPE: id, DRIVE_TYPE: id,
  ANTI_WHEELSPIN: scalar, ANTI_WHEELSKID: scalar,
};

export interface GearboxRecord extends InheritingRecord {
  readonly fields: Readonly<Partial<Fields<typeof gearboxSchema>>>;
}

export function parseGearboxDatabase(text: string): Database<GearboxRecord> {
  const input = tagged(text);
  return records<GearboxRecord>(input, "TYPE", (name, previous) => {
    let parentId: string | undefined;
    let values: Partial<Fields<typeof gearboxSchema>> = {};
    while (input.peek() !== "TYPE" && input.peek() !== "END") {
      const directive = input.take();
      if (directive.tag === "INHERIT_TYPE") {
        const base = parent(directive, previous);
        parentId = base.id;
        values = { ...base.fields };
      } else {
        field(values, gearboxSchema, directive);
      }
    }
    return { id: name, parentId, fields: values };
  });
}

const tyreSchema = {
  ROAD_MAGIC_GRIP_NUMBER: scalar, OFFROAD_MAGIC_GRIP_NUMBER: scalar, WET_MAGIC_GRIP_PERCENTAGE: scalar,
  TYRE_GRIP_DEPTH: scalar, RADIUS: scalar, TYRE_PATCH_LENGTH: scalar, WIDTH: scalar, MASS: scalar,
  ROLLING_RESISTANCE: scalar,
};

export interface TyreSound {
  readonly type: string;
  readonly values: readonly Pair[];
  readonly startRpm: number;
}

export interface TyreRecord extends InheritingRecord {
  /** Authored scalars, with the loader's copy-at-declaration inheritance. */
  readonly fields: Readonly<Partial<Fields<typeof tyreSchema>>>;
  readonly longitudinalSlip?: readonly (readonly number[])[];
  readonly lateralSlip?: readonly (readonly number[])[];
  readonly verticalLoad?: readonly Pair[];
  readonly camberThrust?: readonly Pair[];
  readonly sounds: readonly TyreSound[];
}

function numericRow(row: TextRow, columns: number): readonly number[] {
  arity(row, columns);
  return row.tokens.map((_, index) => real(row, index));
}

export function parseTyreDatabase(text: string): Database<TyreRecord> {
  const input = tagged(text);
  return records<TyreRecord>(input, "TYPE", (name, previous) => {
    let base: TyreRecord | undefined;
    let values: Partial<Fields<typeof tyreSchema>> = {};
    let longitudinalSlip: TyreRecord["longitudinalSlip"];
    let lateralSlip: TyreRecord["lateralSlip"];
    let verticalLoad: TyreRecord["verticalLoad"];
    let camberThrust: TyreRecord["camberThrust"];
    const sounds: TyreSound[] = [];
    while (input.peek() !== "TYPE" && input.peek() !== "END") {
      const directive = input.take();
      switch (directive.tag) {
        case "INHERIT_TYPE":
          base = parent(directive, previous);
          values = { ...base.fields };
          break;
        case "LONGITUDINAL_COMBINED_VALUES":
          tokenArity(directive, 0);
          longitudinalSlip = rows(directive, 9, row => numericRow(row, 11));
          break;
        case "LATERAL_COMBINED_VALUES":
          tokenArity(directive, 0);
          lateralSlip = rows(directive, 10, row => numericRow(row, 21));
          break;
        case "VERTICAL_LOAD":
          tokenArity(directive, 0);
          verticalLoad = rows(directive, 10, pair);
          break;
        case "CAMBER_THRUST":
          tokenArity(directive, 0);
          camberThrust = rows(directive, 10, pair);
          break;
        case "SOUND_INFO": {
          mark(directive);
          const type = id(inline(input.take("TYPE")));
          const table = input.take("VALUE");
          const count = countValue(table);
          if (count === 0) fail(table, "tyre sound requires at least one value");
          const soundValues = rows(table, count, pair);
          sounds.push({ type, values: soundValues, startRpm: scalar(inline(input.take("START_RPM"))) });
          break;
        }
        default:
          field(values, tyreSchema, directive);
      }
    }
    // The five accessors walk the parent chain only if the local table is absent.
    return {
      id: name, parentId: base?.id, fields: values,
      longitudinalSlip: longitudinalSlip ?? base?.longitudinalSlip,
      lateralSlip: lateralSlip ?? base?.lateralSlip,
      verticalLoad: verticalLoad ?? base?.verticalLoad,
      camberThrust: camberThrust ?? base?.camberThrust,
      sounds: sounds.length ? sounds : base?.sounds ?? [],
    };
  });
}

const carSchema = {
  CAR_SETUP_TYPE: id, CAR_BODY_TYPE: id, CAR_ENGINE_TYPE: id, CAR_GEARBOX_TYPE: id,
  CAR_BRAKE_TYPE: id, CAR_FRONT_TYRE_TYPE: id, CAR_BACK_TYRE_TYPE: id, CAR_CONTROL_TYPE: id,
  CAR_OVERLAY_TYPE: id, CAR_GROUP_TYPE: id, TIME_CAR_GROUP_TYPE: id, CAR_SOUND_TYPE: id,
  ICON_FILENAME: id, INGAME_TEXT_ENUM: id, INGAME_SHORT_TEXT_ENUM: id, CAR_APPROVED: bool,
  CAR_MODEL_YEAR: whole, CAR_APPROXIMATE_TOP_SPEED: scalar, CAR_CAMERA_COLLISION_SPHERE_RADIUS: scalar,
  AI_LATERAL_GRIP_MODIFIER: scalar, SPEECH_TYPE: id, CHALLENGE_THEME_TYPE: id, TOKEN_TEXT_ENUM: id,
  CHALLENGE_FILENAME: id, TOKEN_FILENAME: id,
};

export interface CarRecord extends NamedRecord {
  readonly fields: Readonly<Partial<Fields<typeof carSchema>>>;
  readonly performance: readonly { readonly type: string; readonly value: number }[];
  readonly liveries: readonly { readonly type: string; readonly stem: string }[];
}

export function parseCarDatabase(text: string): Database<CarRecord> {
  const input = tagged(text);
  return records<CarRecord>(input, "CAR_TYPE", name => {
    const values: Partial<Fields<typeof carSchema>> = {};
    const performance: CarRecord["performance"][number][] = [];
    const liveries: CarRecord["liveries"][number][] = [];
    while (input.peek() !== "CAR_TYPE" && input.peek() !== "END") {
      const directive = input.take();
      if (directive.tag === "CAR_PERFORMANCE") {
        arity(inline(directive), 2);
        performance.push({ type: identifier(directive, 0), value: real(directive, 1) });
      } else if (directive.tag === "VALID_LIVERY") {
        arity(inline(directive), 2);
        liveries.push({ type: identifier(directive, 0), stem: identifier(directive, 1) });
      } else {
        field(values, carSchema, directive);
      }
    }
    return { id: name, fields: values, performance, liveries };
  });
}

export interface PointMass {
  readonly component: string;
  readonly mass: number;
  readonly position: Vec3;
}

function pointMass(row: TextRow): PointMass {
  arity(row, 5);
  return { component: identifier(row, 0), mass: real(row, 1), position: [real(row, 2), real(row, 3), real(row, 4)] };
}

const bodySchema = {
  GENERIC_BODY_FLAG: bool, OPEN_TOP: bool, DIMENSIONS: vec3, MODEL_CD_FACTOR: scalar,
  MODEL_DOWNFORCE_FACTOR: scalar, BUMPER_HEIGHT: pair, OBJECT_3D_SHAPE: id,
};

export interface BodyRecord extends InheritingRecord {
  readonly fields: Readonly<Partial<Fields<typeof bodySchema>>>;
  readonly masses: readonly PointMass[];
  readonly collisionSpheres: readonly { readonly position: Vec3; readonly radius: number }[];
  readonly aerofoils: readonly { readonly type: string; readonly vertices: readonly [Vec3, Vec3, Vec3, Vec3] }[];
}

export function parseBodyDatabase(text: string): Database<BodyRecord> {
  const input = tagged(text);
  return records<BodyRecord>(input, "TYPE", (name, previous) => {
    let parentId: string | undefined;
    const values: Partial<Fields<typeof bodySchema>> = {};
    const masses: PointMass[] = [];
    const collisionSpheres: BodyRecord["collisionSpheres"][number][] = [];
    const aerofoils: BodyRecord["aerofoils"][number][] = [];
    while (input.peek() !== "TYPE" && input.peek() !== "END") {
      const directive = input.take();
      switch (directive.tag) {
        case "INHERIT_TYPE": {
          const base = parent(directive, previous);
          parentId = base.id;
          // 0x520090 copies OPEN_TOP (+0x1c), dimensions and the
          // model coefficients. GENERIC_BODY_FLAG (+0x00) and
          // BUMPER_HEIGHT (+0x30/+0x34) are outside the copy.
          values.OPEN_TOP = base.fields.OPEN_TOP;
          values.DIMENSIONS = base.fields.DIMENSIONS;
          values.MODEL_CD_FACTOR = base.fields.MODEL_CD_FACTOR;
          values.MODEL_DOWNFORCE_FACTOR = base.fields.MODEL_DOWNFORCE_FACTOR;
          values.OBJECT_3D_SHAPE ||= base.fields.OBJECT_3D_SHAPE;
          if (aerofoils.length === 0) aerofoils.push(...base.aerofoils);
          break;
        }
        case "MASS":
          masses.push(pointMass(inline(directive)));
          break;
        case "COLLISION_SPHERE": {
          const [x, y, z, radius] = quad(inline(directive));
          collisionSpheres.push({ position: [x, y, z], radius });
          break;
        }
        case "AEROFOIL": {
          mark(directive);
          const type = id(inline(input.take("TYPE")));
          const position = () => vec3(inline(input.take("POSITION")));
          aerofoils.push({ type, vertices: [position(), position(), position(), position()] });
          break;
        }
        default:
          field(values, bodySchema, directive);
      }
    }
    return { id: name, parentId, fields: values, masses, collisionSpheres, aerofoils };
  });
}

const brakeSchema = { BRAKE_SPEED: scalar, BRAKE_RADIUS: pair, BRAKE_MAX_FORCE: pair, ADDITIONAL_BRAKING: scalar };
export type BrakeRecord = NamedRecord & Fields<typeof brakeSchema>;

export function parseBrakeDatabase(text: string): Database<BrakeRecord> {
  const input = tagged(text);
  return records(input, "TYPE", name => ({ id: name, ...fields(input, brakeSchema, "TYPE", "END") }));
}

const setupSchema = {
  RELAXATION_LENGTH: scalar, BRAKE_DISTRIBUTION: scalar, BRAKE_PAD_FRICTION: pair, AEROFOIL_ANGLES: pair,
  WHEEL_TOE_IN: pair, CAR_GROUND_CLEARANCE: pair, WHEEL_SPACING: pair, ANTI_ROLLBAR_STIFFNESS: pair,
  ANTI_DIVE_STIFFNESS: pair, SUSPENSION_MOE: pair, SUSPENSION_DAMPING: pair, SUSPENSION_NATURAL_LENGTH: pair,
  SUSPENSION_MIN_EXTENSION: pair, SUSPENSION_MAX_EXTENSION: pair, SUSPENSION_UPPER_TIE_LENGTH: pair,
  SUSPENSION_LOWER_TIE_LENGTH: pair, SUSPENSION_INNER_TIE_SPACING: pair, SUSPENSION_OUTER_TIE_SPACING: pair,
};

export interface SetupRecord extends InheritingRecord {
  readonly fields: Readonly<Partial<Fields<typeof setupSchema>>>;
  readonly gearRatios: readonly { readonly index: number; readonly ratio: number }[];
  readonly ballast?: PointMass;
}

export function parseSetupDatabase(text: string): Database<SetupRecord> {
  // The demo uses a single slash on this heading. Keep line numbers intact.
  const input = tagged(text.replace(/^[ \t]*\/[ \t]+F150 1998[ \t]*(?=\r?$)/m, ""));
  return records<SetupRecord>(input, "CAR_TYPE", (name, previous) => {
    let parentId: string | undefined;
    let values: Partial<Fields<typeof setupSchema>> = {};
    let gearRatios: SetupRecord["gearRatios"] = [];
    let ballast: PointMass | undefined;
    while (input.peek() !== "CAR_TYPE" && input.peek() !== "END") {
      const directive = input.take();
      switch (directive.tag) {
        case "INHERIT_TYPE": {
          const base = parent(directive, previous);
          parentId = base.id;
          values = { ...base.fields };
          gearRatios = base.gearRatios;
          ballast = base.ballast;
          break;
        }
        case "GEARING_ARRAY":
          gearRatios = rows(directive, countValue(directive), row => {
            arity(row, 2);
            return { index: integer(row, 0), ratio: real(row, 1) };
          });
          break;
        case "MASS":
          ballast = pointMass(inline(directive));
          break;
        default:
          field(values, setupSchema, directive);
      }
    }
    return { id: name, parentId, fields: values, gearRatios, ballast };
  });
}

const tenRowCurve = (directive: TextDirective): readonly Pair[] => {
  tokenArity(directive, 0);
  return rows(directive, 10, pair);
};

const controlSchema = {
  STEERING_ANGLE_MAX_SPEED: scalar, STEERING_SPEED_MAX_SPEED: scalar, STEERING_RETURN_SPEED: scalar,
};

const controlCurves = {
  STEERING_ANGLE_ARRAY: tenRowCurve, STEERING_SPEED_ARRAY: tenRowCurve, DPAD_INPUT_ARRAY: tenRowCurve,
  JOYPAD_PC_INPUT_ARRAY: tenRowCurve, JOYPAD_PS2_INPUT_ARRAY: tenRowCurve, JOYPAD_XBOX_INPUT_ARRAY: tenRowCurve,
  WHEEL_ANGLE_ARRAY: tenRowCurve, WHEEL_INPUT_ARRAY: tenRowCurve,
};

export type ControlRecord = NamedRecord & Fields<typeof controlSchema> & Fields<typeof controlCurves>;

export function parseControlDatabase(text: string): Database<ControlRecord> {
  const input = tagged(text);
  return records<ControlRecord>(input, "TYPE", name => ({
    id: name,
    ...fields(input, { ...controlSchema, ...controlCurves }, "TYPE", "END"),
  }));
}

function rgb(row: TextRow): Vec3 {
  arity(row, 3);
  const values: Vec3 = [integer(row, 0), integer(row, 1), integer(row, 2)];
  if (values.some(value => value < 0 || value > 255)) fail(row, "RGB component out of range");
  return values;
}

const materialSchema = { MOVEABLE: bool, SPARKABLE: bool, MASS_SCALING_FACTOR: scalar, COLOUR: rgb };
export type MaterialRecord = NamedRecord & Fields<typeof materialSchema>;

export function parseMaterialDatabase(text: string): Database<MaterialRecord> {
  const input = tagged(text);
  return records(input, "TYPE", name => ({ id: name, ...fields(input, materialSchema, "TYPE", "END") }));
}

const overlaySchema = { SET: id, BEZEL: id, NEEDLE: id, FLAT_NEEDLE: id };
const placementSchema = { NEEDLE_CENTRE_X: scalar, NEEDLE_CENTRE_Y: scalar, NEEDLE_START: scalar, NEEDLE_ARC: scalar };
const gaugeKinds = ["ANALOG_SPEEDO_MPH", "ANALOG_SPEEDO_KPH", "REV_COUNTER_OUT_CAR", "REV_COUNTER_IN_CAR"] as const;
type GaugeKind = typeof gaugeKinds[number];
type GaugePlacement = Fields<typeof placementSchema>;

export interface Gauge {
  readonly kind: GaugeKind;
  readonly asset: string;
  readonly maximum: number;
  readonly placement: GaugePlacement;
}

export type OverlayRecord = NamedRecord & Omit<Fields<typeof overlaySchema>, "FLAT_NEEDLE"> & {
  readonly FLAT_NEEDLE?: string;
  readonly gauges: readonly Gauge[];
};

export function parseOverlayDatabase(text: string): Database<OverlayRecord> {
  const input = tagged(text);
  return records<OverlayRecord>(input, "TYPE", name => {
    const boundaries = [...gaugeKinds, "TYPE", "END"];
    const options = fields(input, overlaySchema, boundaries, ["FLAT_NEEDLE"]);
    const readGauge = (kind: GaugeKind) => ({
      kind,
      asset: id(inline(input.take(kind))),
      maximum: scalar(inline(input.take("MAX"))),
    });
    const mph = readGauge("ANALOG_SPEEDO_MPH");
    const kph = readGauge("ANALOG_SPEEDO_KPH");
    const placement = fields(input, placementSchema, ...boundaries);
    const gauges: Gauge[] = [{ ...mph, placement }, { ...kph, placement }];
    const seen = new Set<GaugeKind>();
    let kind = input.peek();
    while (kind === "REV_COUNTER_IN_CAR" || kind === "REV_COUNTER_OUT_CAR") {
      if (seen.has(kind)) throw new Error(`Overlay "${name}" has two :${kind} gauges`);
      seen.add(kind);
      gauges.push({ ...readGauge(kind), placement: fields(input, placementSchema, ...boundaries) });
      kind = input.peek();
    }
    if (!seen.has("REV_COUNTER_OUT_CAR")) throw new Error(`Overlay "${name}" is missing :REV_COUNTER_OUT_CAR`);
    return { id: name, ...options, gauges };
  });
}

export interface VehicleDatabases {
  readonly cars: Database<CarRecord>;
  readonly bodies: Database<BodyRecord>;
  readonly engines: Database<EngineRecord>;
  readonly gearboxes: Database<GearboxRecord>;
  readonly tyres: Database<TyreRecord>;
  readonly brakes: Database<BrakeRecord>;
  readonly setups: Database<SetupRecord>;
  readonly controls: Database<ControlRecord>;
  readonly materials: Database<MaterialRecord>;
  readonly overlays: Database<OverlayRecord>;
}

const vehicleFiles = {
  cars: ["CARDATA.DAT", parseCarDatabase],
  bodies: ["BODYDATA.DAT", parseBodyDatabase],
  engines: ["ENGDATA.DAT", parseEngineDatabase],
  gearboxes: ["GEARDATA.DAT", parseGearboxDatabase],
  tyres: ["TYREDATA.DAT", parseTyreDatabase],
  brakes: ["BRAKDATA.DAT", parseBrakeDatabase],
  setups: ["CARSETUP.DAT", parseSetupDatabase],
  controls: ["CTRLDATA.DAT", parseControlDatabase],
  materials: ["MATDATA.DAT", parseMaterialDatabase],
  overlays: ["OVERDATA.DAT", parseOverlayDatabase],
} as const;

export async function loadVehicleDatabases(vfs: Pick<VirtualFileSystem, "readText">): Promise<VehicleDatabases> {
  async function load<T>([file, parse]: readonly [string, (text: string) => Database<T>]) {
    const path = `DATA/ASCII/CARS/${file}`;
    try {
      return parse(await vfs.readText(path));
    } catch (cause) {
      throw new Error(`Failed to load ${path}`, { cause });
    }
  }
  const [cars, bodies, engines, gearboxes, tyres, brakes, setups, controls, materials, overlays] = await Promise.all([
    load(vehicleFiles.cars), load(vehicleFiles.bodies), load(vehicleFiles.engines), load(vehicleFiles.gearboxes),
    load(vehicleFiles.tyres), load(vehicleFiles.brakes), load(vehicleFiles.setups), load(vehicleFiles.controls),
    load(vehicleFiles.materials), load(vehicleFiles.overlays),
  ]);
  return { cars, bodies, engines, gearboxes, tyres, brakes, setups, controls, materials, overlays };
}

export interface ResolvedCarConfig {
  readonly car: CarRecord;
  readonly body: BodyRecord;
  readonly shapeFolder: string;
  readonly engine: EngineRecord;
  readonly gearbox: GearboxRecord;
  readonly frontTyre: TyreRecord;
  readonly rearTyre: TyreRecord;
  readonly brakes: BrakeRecord;
  readonly setup: SetupRecord;
  readonly control: ControlRecord;
  readonly overlay?: OverlayRecord;
}

export function resolveCarConfig(db: VehicleDatabases, carId: string): ResolvedCarConfig {
  const car = db.cars.get(carId.toLowerCase());
  if (!car) throw new Error(`Unknown car "${carId}"`);
  const values = car.fields;
  const carName = car.id;
  function resolve<T>(table: Database<T>, tag: keyof typeof carSchema): T {
    const reference = values[tag];
    if (typeof reference !== "string") throw new Error(`${carName} is missing :${tag}`);
    const record = table.get(reference.toLowerCase());
    if (!record) throw new Error(`${carName} :${tag} references unknown record "${reference}"`);
    return record;
  }
  const rawBody = resolve(db.bodies, "CAR_BODY_TYPE");
  let masses = rawBody.masses;
  let collisionSpheres = rawBody.collisionSpheres;
  let cursor: BodyRecord | undefined = rawBody;
  const seenBodies = new Set<string>();
  while ((masses.length === 0 || collisionSpheres.length === 0) && cursor?.parentId) {
    const parentKey = cursor.parentId.toLowerCase();
    if (seenBodies.has(parentKey)) break;
    seenBodies.add(parentKey);
    const parent = db.bodies.get(parentKey);
    if (!parent) break;
    if (masses.length === 0 && parent.masses.length > 0) masses = parent.masses;
    if (collisionSpheres.length === 0 && parent.collisionSpheres.length > 0) collisionSpheres = parent.collisionSpheres;
    cursor = parent;
  }
  const body: BodyRecord = masses === rawBody.masses && collisionSpheres === rawBody.collisionSpheres
    ? rawBody
    : { ...rawBody, masses, collisionSpheres };
  const stem = body.fields.OBJECT_3D_SHAPE;
  if (!stem || stem === "." || stem === "..") throw new Error(`Body "${body.id}" requires a model directory stem`);
  return {
    car, body, shapeFolder: `3DDATA/CARS/${stem}`,
    engine: resolve(db.engines, "CAR_ENGINE_TYPE"),
    gearbox: resolve(db.gearboxes, "CAR_GEARBOX_TYPE"),
    frontTyre: resolve(db.tyres, "CAR_FRONT_TYRE_TYPE"),
    rearTyre: resolve(db.tyres, "CAR_BACK_TYRE_TYPE"),
    brakes: resolve(db.brakes, "CAR_BRAKE_TYPE"),
    setup: resolve(db.setups, "CAR_SETUP_TYPE"),
    control: resolve(db.controls, "CAR_CONTROL_TYPE"),
    overlay: values.CAR_OVERLAY_TYPE ? resolve(db.overlays, "CAR_OVERLAY_TYPE") : undefined,
  };
}

export interface RacingLinePoint {
  readonly position: Vec3;
  readonly lateral: Vec3;
  readonly forward: Vec3;
  readonly width: number;
  readonly offset: number;
  readonly curvatureRadius: number;
}

export interface TrackPath {
  readonly length: number;
  readonly points: readonly Vec3[];
}

const racingMetadata = {
  TRACK_TOOL_FLYING_LAP_START_INTERPOLANT: scalar,
  TRACK_TOOL_AI_PIT_START_INTERPOLANT: scalar,
  TRACK_TOOL_AI_PIT_END_INTERPOLANT: scalar,
  TRACK_TOOL_AI_QUERY_INTERPOLANT: scalar,
  TRACK_TOOL_PLAYER_PIT_END_INTERPOLANT: scalar,
  TRACK_TOOL_SPEED_LIMIT_ZONE_INTERPOLANT: scalar,
  TRACK_TOOL_GARAGE_START_INTERPOLANT: scalar,
  TRACK_TOOL_GARAGE_END_INTERPOLANT: scalar,
  TRACK_TOOL_GARAGE_STOP_INTERPOLANT: scalar,
  TRACK_TOOL_PIT_SPEED_LIMIT: scalar,
  TRACK_TOOL_GARAGE_WIDTH: scalar,
  TRACK_TOOL_PIT_SPHERE_POSITION: vec3,
  TRACK_TOOL_PIT_SPHERE_RADIUS: scalar,
};

export interface RacingLine {
  readonly version: number;
  readonly creationDate: string;
  readonly timestamp: number;
  readonly sceneName: string;
  readonly tolerance: number;
  readonly reverse: boolean;
  readonly length: number;
  readonly edgeModifier: number;
  readonly points: readonly RacingLinePoint[];
  readonly pitLane?: TrackPath;
  readonly garageLine?: TrackPath;
  readonly flyingLapStartInterpolant: number;
  readonly metadata: Readonly<Partial<Fields<typeof racingMetadata>>>;
}

export function parseRacingLine(text: string): RacingLine {
  const input = tagged(text);
  const tool = (name: string) => input.take(`TRACK_TOOL_${name}`);
  const value = (name: string) => inline(tool(name));
  const description = (name: string) => {
    const row = value(name);
    if (!row.tokens.length) fail(row, "expected a description");
    return row.tokens.length === 1 && row.tokens[0]?.startsWith('"') ? label(row) : row.tokens.join(" ");
  };

  mark(tool("HEADER"));
  const version = whole(value("VERSION_NUMBER"));
  const creationDate = description("CREATION_DATE");
  const timestamp = whole(value("TIMESTAMP"));
  const sceneName = description("SCENE_NAME");
  const tolerance = scalar(value("TOLERANCE"));
  const reverse = bool(value("REVERSE_FLAG"));
  mark(tool("DATA"));
  const count = countValue(value("NUM_RACING_LINE_POINTS"));
  const length = scalar(value("RACING_LINE_LENGTH"));
  const edgeModifier = scalar(value("TRACK_EDGE_MODIFIER"));
  const pointBlock = tool("RACING_LINE_POINTS_START");
  tokenArity(pointBlock, 0);
  const data = flattened(pointBlock);
  arity(data, count * 12);
  const points: RacingLinePoint[] = [];
  for (let index = 0; index < data.tokens.length; index += 12) {
    points.push({
      position: [real(data, index), real(data, index + 1), real(data, index + 2)],
      lateral: [real(data, index + 3), real(data, index + 4), real(data, index + 5)],
      forward: [real(data, index + 6), real(data, index + 7), real(data, index + 8)],
      width: real(data, index + 9),
      offset: real(data, index + 10),
      curvatureRadius: real(data, index + 11),
    });
  }
  mark(tool("RACING_LINE_POINTS_END"));

  function path(name: string): TrackPath | undefined {
    if (input.peek() !== `TRACK_TOOL_NUM_${name}_POINTS`) return undefined;
    const count = countValue(value(`NUM_${name}_POINTS`));
    const length = scalar(value(`${name}_LENGTH`));
    const block = tool(`${name}_POINTS_START`);
    tokenArity(block, 0);
    const points = rows(block, count, vec3);
    mark(tool(`${name}_POINTS_END`));
    return { length, points };
  }

  const pitLane = path("PITLANE");
  const garageLine = path("GARAGE_LINE");
  const metadata: Partial<Fields<typeof racingMetadata>> = {};
  while (input.peek() !== "END") field(metadata, racingMetadata, input.take());
  input.end();
  const flyingLapStartInterpolant = metadata.TRACK_TOOL_FLYING_LAP_START_INTERPOLANT;
  if (flyingLapStartInterpolant === undefined) throw new Error("Missing :TRACK_TOOL_FLYING_LAP_START_INTERPOLANT");
  return {
    version, creationDate, timestamp, sceneName, tolerance, reverse, length, edgeModifier,
    points, pitLane, garageLine, flyingLapStartInterpolant, metadata,
  };
}

const difficultyLevels = ["EASY", "MEDIUM", "HARD"] as const;
export type DifficultyLevel = typeof difficultyLevels[number];

function difficultyId(row: TextRow): DifficultyLevel {
  const level = id(row);
  for (const known of difficultyLevels) if (level === known) return known;
  return fail(row, `unknown difficulty "${level}"`);
}

const trackSchema = {
  TRACK_GROUP_TYPE: id, ICON_FILENAME: id, INGAME_TEXT_ENUM: id, TRACK_TERRAIN_TYPE: id,
  UNLOCKED: bool, REVERSE: bool, CAR_HEADLIGHTS_REQUIRED_FLAG: bool, DEFAULT_TRACK_SURFACE: id,
};

export type TrackRecord = NamedRecord & Fields<typeof trackSchema> & {
  readonly difficulty: Readonly<Record<DifficultyLevel, Vec3>>;
};

export function parseTrackDatabase(text: string): Database<TrackRecord> {
  const input = tagged(text);
  return records<TrackRecord>(input, "TRACK", name => {
    const options = fields(input, trackSchema, "DIFFICULTY_DATA");
    mark(input.take("DIFFICULTY_DATA"));
    function difficulty(expected: DifficultyLevel): Vec3 {
      const row = input.take("DIFFICULTY_LEVEL");
      if (difficultyId({ line: row.line, tokens: row.tokens }) !== expected) fail(row, `expected ${expected} difficulty`);
      const values = rows(row, 3, scalar);
      return [values[0]!, values[1]!, values[2]!];
    }
    return { id: name, ...options, difficulty: { EASY: difficulty("EASY"), MEDIUM: difficulty("MEDIUM"), HARD: difficulty("HARD") } };
  }, label);
}

const gateSchema = { TYPE: id, INTERPOLANT: scalar, OFFSET: scalar, RADIUS: scalar };
export type TrackGate = Fields<typeof gateSchema>;

export function parseTrackGates(text: string): readonly TrackGate[] {
  const input = tagged(text);
  const gates: TrackGate[] = [];
  while (input.peek() !== "END") {
    mark(input.take("TRIGGER"));
    const gate = fields(input, gateSchema, "TRIGGER", "END");
    if (gate.TYPE !== "GATE_MAIN") throw new Error(`Unexpected main gate type "${gate.TYPE}"`);
    gates.push(gate);
  }
  input.end();
  return gates;
}

function fog(row: TextRow): { readonly density: number; readonly colour: Vec3 } {
  arity(row, 4);
  return { density: real(row, 0), colour: rgb({ line: row.line, tokens: row.tokens.slice(1) }) };
}

const trackConfigSchema = {
  FOG: fog, CAR_HEADLIGHT_STRENGTH: scalar, TRACK_WETNESS: scalar, SUN_FLARE_SIZE: scalar, HEAT_HAZE_STRENGTH: scalar,
};

export type TrackConfig = Fields<typeof trackConfigSchema>;

export function parseTrackConfig(text: string): TrackConfig {
  return fields(tagged(text), trackConfigSchema);
}

const surfaceSchema = {
  EFFECT_TYPE: id, RUMBLE: id, FRICTION: scalar, DRAG: scalar, SURFACE_AI_GRIP_MODIFIER: scalar,
  SURFACE_SINK_FACTOR: scalar, BUMP_AMPLITUDE: scalar, BUMP_FREQUENCY: scalar, SURFACE_SCALE_BUMPS: bool,
  VALID_RACING_SURFACE: bool,
};

export type SurfaceRecord = NamedRecord & Omit<Fields<typeof surfaceSchema>, "RUMBLE"> & { readonly RUMBLE?: string };

export function parseSurfaceDatabase(text: string): Database<SurfaceRecord> {
  const input = tagged(text);
  mark(input.take("START"));
  return records(input, "TYPE", name => ({
    id: name, ...fields(input, surfaceSchema, ["TYPE", "END"], ["RUMBLE"]),
  }));
}

function specificNumbers(row: TextRow, allowed: readonly number[]): readonly number[] {
  if (!allowed.includes(row.tokens.length)) fail(row, `expected ${allowed.join(", ")} values`);
  return numericRow(row, row.tokens.length);
}

const cameraSchema = {
  CAMERA_SYSTEM_CAMERA_FOV: scalar, CAMERA_SYSTEM_CAMERA_TIME: scalar, CAMERA_SYSTEM_CAMERA_OFFSET: vec3,
  CAMERA_SYSTEM_CAMERA_VIEWPORT_OFFSETS: quad, CAMERA_SYSTEM_CAMERA_SUBJECT_VISIBLE: bool,
  CAMERA_SYSTEM_CAMERA_INITIALISE_BASE_ATTRIBS_ON_SUBJECT_CHANGE: bool,
  CAMERA_SYSTEM_CAMERA_INITIALISE_SPECIFIC_ATTRIBS_ON_SUBJECT_CHANGE: bool,
  CAMERA_SYSTEM_CAMERA_SECONDARY: id,
  CAMERA_SYSTEM_CAMERA_TYPE_SPECIFIC: (row: TextRow) => specificNumbers(row, [1, 2]),
};

export type MountingSpecific =
  | { readonly kind: "parameters"; readonly values: readonly number[] }
  | { readonly kind: "subjectBinding"; readonly binding: string; readonly values: Vec3 };

function mountingSpecific(row: TextRow): MountingSpecific {
  if (row.tokens[0]?.startsWith("MOUNTING_SUBJECT_BINDING_TYPE_")) {
    arity(row, 4);
    return { kind: "subjectBinding", binding: identifier(row, 0), values: [integer(row, 1), integer(row, 2), integer(row, 3)] };
  }
  return { kind: "parameters", values: specificNumbers(row, [1, 2, 3, 5]) };
}

const mountingSchema = {
  CAMERA_SYSTEM_MOUNTING_OFFSET: vec3,
  CAMERA_SYSTEM_MOUNTING_TYPE_SPECIFIC: mountingSpecific,
  CAMERA_SYSTEM_MOUNTING_SHAKE: (row: TextRow): { readonly enabled: boolean; readonly values: Quad } => {
    arity(row, 5);
    return { enabled: flag(row), values: [real(row, 1), real(row, 2), real(row, 3), real(row, 4)] };
  },
};

export interface CameraDefinition {
  readonly subtype: string;
  readonly group: string;
  readonly label: string;
  readonly level: string;
  readonly fields: Readonly<Partial<Fields<typeof cameraSchema>>>;
  readonly mounting: Readonly<Partial<Fields<typeof mountingSchema>>>;
  readonly subjectScales: readonly { readonly subjectId: string; readonly scale: number }[];
}

export function parseCameraDatabase(text: string): readonly CameraDefinition[] {
  const input = tagged(text);
  const cameras: CameraDefinition[] = [];
  while (!input.done) {
    const start = flattened(input.take("CAMERA_SYSTEM_CAMERA"));
    arity(start, 4);
    const camera: Partial<Fields<typeof cameraSchema>> = {};
    while (input.peek() !== "CAMERA_SYSTEM_CAMERA_CREATE") {
      const directive = input.take();
      field(camera, cameraSchema, { ...flattened(directive), tag: directive.tag, rows: [] });
    }
    mark(input.take("CAMERA_SYSTEM_CAMERA_CREATE"));

    const mounting: Partial<Fields<typeof mountingSchema>> = {};
    const subjectScales: CameraDefinition["subjectScales"][number][] = [];
    while (input.peek() !== "CAMERA_SYSTEM_MOUNTING_CREATE") {
      const directive = input.take();
      if (directive.tag === "CAMERA_SYSTEM_MOUNTING_SUBJECT_SCALE_VALUE") {
        subjectScales.push(...rows(directive, countValue(directive), row => {
          arity(row, 2);
          return { subjectId: quoted(row, 0), scale: real(row, 1) };
        }));
      } else {
        field(mounting, mountingSchema, { ...flattened(directive), tag: directive.tag, rows: [] });
      }
    }
    mark(input.take("CAMERA_SYSTEM_MOUNTING_CREATE"));
    cameras.push({
      subtype: identifier(start, 0), group: identifier(start, 1), label: quoted(start, 2), level: identifier(start, 3),
      fields: camera, mounting, subjectScales,
    });
  }
  return cameras;
}

export interface ViewportConfiguration {
  readonly type: string;
  readonly aspects: readonly {
    readonly aspectRatio: string;
    readonly single: Quad;
    readonly split: readonly [Quad, Quad];
  }[];
}

export function parseCameraViewports(text: string): readonly ViewportConfiguration[] {
  const input = tagged(text);
  const configurations: ViewportConfiguration[] = [];
  while (!input.done) {
    const block = input.take("CAMERA_SYSTEM_DIRECTOR_VIEWPORT");
    tokenArity(block, 0);
    const [type, aspect1, single1, split1a, split1b, aspect2, single2, split2a, split2b] = block.rows;
    if (block.rows.length !== 9 || !type || !aspect1 || !single1 || !split1a || !split1b ||
        !aspect2 || !single2 || !split2a || !split2b) fail(block, "expected a viewport type and two aspect-ratio groups");
    configurations.push({
      type: id(type),
      aspects: [
        { aspectRatio: id(aspect1), single: quad(single1), split: [quad(split1a), quad(split1b)] },
        { aspectRatio: id(aspect2), single: quad(single2), split: [quad(split2a), quad(split2b)] },
      ],
    });
  }
  return configurations;
}

function suffixedReal(row: TextRow, index: number): number {
  const value = row.tokens[index]?.replace(/f$/i, "") ?? "";
  return real({ line: row.line, tokens: [value] }, 0);
}

export function parseCameraOverride(text: string): { readonly subtype: string; readonly fov: number; readonly sourceToken: string } {
  const { preamble, directives } = readDatabaseText(text);
  const subtype = preamble[0];
  if (preamble.length !== 1 || !subtype) throw new Error("Expected one camera override subtype");
  const input = new Directives(directives);
  const fov = inline(input.take("CAMERA_SYSTEM_CAMERA_FOV"));
  arity(fov, 1);
  input.end(false);
  return { subtype: id(subtype), fov: suffixedReal(fov, 0), sourceToken: fov.tokens[0]! };
}

const gameSchema = {
  MULTIPLAYER_CATCHUP_LEADER_POWER_ADJUSTMENT: scalar, MULTIPLAYER_CATCHUP_LOSER_POWER_ADJUSTMENT: scalar,
  MULTIPLAYER_CATCHUP_MIN_RANGE: scalar, MULTIPLAYER_CATCHUP_MAX_RANGE: scalar,
};

const aiSchema = {
  DIFFICULTY_LINE_VARIATION: scalar, DIFFICULTY_OVERTAKE_CLEARANCE: scalar,
  CATCHUP_ADDITIONAL_START_POWER: scalar, CATCHUP_SUBTRACTIVE_START_POWER: scalar,
  CATCHUP_ADDITIONAL_POWER: scalar, CATCHUP_SUBTRACTIVE_POWER: scalar,
  AI_OVERTAKE_POWER_MODIFIER: scalar, AI_DRAFTING_POWER_MODIFIER: scalar, AI_RACELINE_POWER_BOOST: scalar,
  CATCHUP_RANGE_AHEAD: scalar, CATCHUP_RANGE_BEHIND: scalar, CATCHUP_START_FADEOUT: scalar,
  CATCHUP_STOP_FADEOUT: scalar, CATCHUP_PACK_SPREAD: scalar, CATCHUP_PACK_SHIFT: scalar,
  CATCHUP_PACK_RATE_OF_CHANGE_PER_LAP: scalar, CAR_BASE_DIFFICULTY_LEVEL: scalar, CAR_DIFFICULTY_LEVEL_SPREAD: scalar,
};

export interface GameSettings {
  readonly global: Fields<typeof gameSchema>;
  readonly difficulty: Readonly<Record<DifficultyLevel, Fields<typeof aiSchema>>>;
}

export function parseGameData(text: string): GameSettings {
  const input = tagged(text);
  const global = fields(input, gameSchema, "DIFFICULTY_LEVEL");
  function difficulty(expected: DifficultyLevel) {
    const row = inline(input.take("DIFFICULTY_LEVEL"));
    if (difficultyId(row) !== expected) fail(row, `expected ${expected} difficulty`);
    return fields(input, aiSchema, "DIFFICULTY_LEVEL", "END");
  }
  const settings = { global, difficulty: { EASY: difficulty("EASY"), MEDIUM: difficulty("MEDIUM"), HARD: difficulty("HARD") } };
  input.end();
  return settings;
}

const multiplierColumns = { SECONDS: 2, SKILLS: 3, TIMEATTA: 1 } as const;
export type DifficultyMultiplierKind = keyof typeof multiplierColumns;

export function parseDifficultyMultipliers(
  text: string, kind: DifficultyMultiplierKind,
): Readonly<Record<DifficultyLevel, readonly number[]>> {
  const { preamble, directives } = readDatabaseText(text);
  const [easy, medium, hard] = preamble;
  if (directives.length || preamble.length !== 3 || !easy || !medium || !hard) {
    throw new Error("Expected three untagged difficulty multiplier rows");
  }
  const columns = multiplierColumns[kind];
  return { EASY: numericRow(easy, columns), MEDIUM: numericRow(medium, columns), HARD: numericRow(hard, columns) };
}

const rulesSchema = {
  ICON_FILENAME: id, INGAME_TEXT_ENUM: id, CUP_TEXT: id, HELP: id, HOWTO: id, DESCRIPTION_TEXT: id,
  SPEECH_TYPE: id, MIN_CARS: whole, MAX_CARS: whole, MAX_LAPS: whole, MULTIPLAYER: bool, UNLOCKED: bool,
};

export type RaceRule = NamedRecord & Fields<typeof rulesSchema>;

export function parseRulesDatabase(text: string): Database<RaceRule> {
  const input = tagged(text);
  return records(input, "TYPE", name => ({ id: name, ...fields(input, rulesSchema, "TYPE", "END") }));
}

const raceSchema = { TRACK: id, GAMEPLAY: id, NUMBER_OF_LAPS: whole };
const participantSchema = { CAR: id, CONTROL: id, PLAYER_INDEX: id, TEAM: whole };

export interface RaceParticipant {
  readonly carId: string;
  readonly control: string;
  readonly playerIndex?: string;
  readonly team?: number;
}

export interface RaceDefinition {
  readonly trackId: string;
  readonly gameplayId: string;
  readonly laps?: number;
  readonly participants: readonly RaceParticipant[];
}

export function parseRaceDefinition(text: string): RaceDefinition {
  const input = tagged(text);
  const race = fields(input, raceSchema, ["PARTICIPANT", "END"], ["NUMBER_OF_LAPS"]);
  const participants: RaceParticipant[] = [];
  while (input.peek() !== "END") {
    mark(input.take("PARTICIPANT"));
    const { CAR, CONTROL, PLAYER_INDEX, TEAM } = fields(
      input, participantSchema, ["PARTICIPANT", "END"], ["PLAYER_INDEX", "TEAM"],
    );
    participants.push({ carId: CAR, control: CONTROL, playerIndex: PLAYER_INDEX, team: TEAM });
  }
  input.end();
  return { trackId: race.TRACK, gameplayId: race.GAMEPLAY, laps: race.NUMBER_OF_LAPS, participants };
}

export function parseQuickRace(text: string): RaceDefinition & { readonly laps: number } {
  const race = parseRaceDefinition(text);
  if (race.laps === undefined) throw new Error("Missing :NUMBER_OF_LAPS");
  return { ...race, laps: race.laps };
}

const engineSoundSchema = { BANK: id, ENGINE_PITCH_MODIFIER: scalar };
const editPoints = (directive: TextDirective): Quad => quad(flattened(directive));
const soundSampleSchema = {
  START_RPM: scalar, RPM_TO_HZ: scalar, SOUND_SAMPLE_MAX_VOLUME: scalar, SOUND_SAMPLE_EDIT_POINTS: editPoints,
};

export interface EngineSoundSample {
  readonly type: string;
  readonly startRpm: number;
  readonly rpmToHz: number;
  readonly maxVolume: number;
  readonly editPoints?: Quad;
}

export interface EngineSoundRecord extends NamedRecord {
  readonly bank: string;
  readonly pitchModifier: number;
  readonly samples: readonly EngineSoundSample[];
  readonly crossfades: readonly { readonly type: string; readonly values: Quad }[];
}

export function parseEngineSoundDatabase(text: string): Database<EngineSoundRecord> {
  const input = tagged(text);
  return records<EngineSoundRecord>(input, "NAME", name => {
    const boundaries = ["NAME", "END", "SOUND_INFO", "CROSSFADE_INFO"];
    const { BANK, ENGINE_PITCH_MODIFIER } = fields(input, engineSoundSchema, ...boundaries);
    const samples: EngineSoundSample[] = [];
    const crossfades: EngineSoundRecord["crossfades"][number][] = [];
    while (input.peek() === "SOUND_INFO" || input.peek() === "CROSSFADE_INFO") {
      const block = input.take();
      mark(block);
      const typeRow = input.take("TYPE");
      if (block.tag === "CROSSFADE_INFO") {
        tokenArity(typeRow, 1);
        crossfades.push({
          type: identifier(typeRow, 0),
          values: quad({ line: typeRow.line, tokens: typeRow.rows.flatMap(row => row.tokens) }),
        });
      } else {
        const type = id(inline(typeRow));
        const values = fields(input, soundSampleSchema, boundaries, ["SOUND_SAMPLE_EDIT_POINTS"]);
        samples.push({
          type, startRpm: values.START_RPM, rpmToHz: values.RPM_TO_HZ,
          maxVolume: values.SOUND_SAMPLE_MAX_VOLUME, editPoints: values.SOUND_SAMPLE_EDIT_POINTS,
        });
      }
    }
    return { id: name, bank: BANK, pitchModifier: ENGINE_PITCH_MODIFIER, samples, crossfades };
  });
}

export interface VolumeMode extends NamedRecord {
  readonly levels: ReadonlyMap<string, number>;
}

export function parseVolumeDatabase(text: string): Database<VolumeMode> {
  const input = tagged(text);
  const result = new Map<string, VolumeMode>();
  while (input.peek() !== "END") {
    const block = input.take("TYPE");
    tokenArity(block, 1);
    const name = identifier(block, 0);
    const key = name.toLowerCase();
    if (result.has(key)) fail(block, `duplicate volume mode "${name}"`);
    const levels = new Map<string, number>();
    for (const row of block.rows) {
      arity(row, 2);
      const type = identifier(row, 0);
      if (levels.has(type)) fail(row, `duplicate volume type "${type}"`);
      levels.set(type, real(row, 1));
    }
    result.set(key, { id: name, levels });
  }
  input.end();
  return result;
}

export function parseSoundTracks(text: string): readonly string[] {
  const { preamble, directives } = readDatabaseText(text);
  const [count, ...tracks] = preamble;
  if (directives.length || !count || countValue(count) !== tracks.length) throw new Error("Invalid sound track list");
  return tracks.map(id);
}

export interface StaticSound {
  readonly sampleId: string;
  readonly sampleIndex: number;
  readonly position: Vec3;
  readonly parameters: Quad;
  readonly flag: number;
  readonly value: number;
  readonly extra?: number;
}

export interface AnimatedSound {
  readonly animationType: string;
  readonly sampleId: string;
  readonly parameters: Vec3;
}

function soundEffects<T>(text: string, parse: (row: TextRow) => T): readonly T[] {
  const input = tagged(text);
  const effects: T[] = [];
  while (!input.done) effects.push(parse(inline(input.take("SOUND_EFFECT"))));
  return effects;
}

export function parseStaticSounds(text: string): readonly StaticSound[] {
  return soundEffects(text, row => {
    if (row.tokens.length !== 11 && row.tokens.length !== 12) fail(row, "expected 11 or 12 static sound values");
    return {
      sampleId: quoted(row, 0), sampleIndex: integer(row, 1),
      position: [real(row, 2), real(row, 3), real(row, 4)],
      parameters: [real(row, 5), real(row, 6), real(row, 7), real(row, 8)],
      flag: integer(row, 9), value: integer(row, 10),
      extra: row.tokens.length === 12 ? integer(row, 11) : undefined,
    };
  });
}

export function parseAnimatedSounds(text: string): readonly AnimatedSound[] {
  return soundEffects(text, row => {
    arity(row, 5);
    return {
      animationType: identifier(row, 0), sampleId: quoted(row, 1),
      parameters: [real(row, 2), real(row, 3), real(row, 4)],
    };
  });
}

export function parseReverbSounds(text: string): readonly Quad[] {
  return soundEffects(text, quad);
}

const particleSchema = { EFFECT_NAME: label, MAYA_NAME: label, VELOCITY_MAGNITUDE: scalar };
export type TrackParticle = Fields<typeof particleSchema>;

export function parseTrackParticles(text: string): readonly TrackParticle[] {
  const input = tagged(text);
  const particles: TrackParticle[] = [];
  while (!input.done) {
    mark(input.take("BEGIN_EFFECT"));
    particles.push(fields(input, particleSchema, "END_EFFECT"));
    mark(input.take("END_EFFECT"));
  }
  return particles;
}

const bonusSchema = { TYPE: id, INTERPOLANT: scalar, OFFSET: scalar };
export type TrackBonus = Fields<typeof bonusSchema>;

export function parseTrackBonuses(text: string): readonly TrackBonus[] {
  const input = tagged(text);
  const bonuses: TrackBonus[] = [];
  while (input.peek() === "BONUS") {
    mark(input.take("BONUS"));
    bonuses.push(fields(input, bonusSchema, "BONUS", "END_SUB_SCRIPT"));
  }
  mark(input.take("END_SUB_SCRIPT"));
  input.end(false);
  return bonuses;
}

function positionWithSuffix(row: TextRow): Vec3 {
  arity(row, 3);
  return [suffixedReal(row, 0), suffixedReal(row, 1), suffixedReal(row, 2)];
}

export type TrackCone =
  | { readonly kind: "cone"; readonly interpolant: number; readonly position: Vec3 }
  | { readonly kind: "trigger"; readonly type: string; readonly position: Vec3 };

export function parseTrackCones(text: string): readonly TrackCone[] {
  const input = tagged(text);
  const cones: TrackCone[] = [];
  while (input.peek() !== "END") {
    const block = input.take();
    mark(block);
    if (block.tag === "CONE") {
      const interpolant = scalar(inline(input.take("INTERPOLANT")));
      cones.push({ kind: "cone", interpolant, position: positionWithSuffix(input.take("POSITION")) });
    } else if (block.tag === "TRIGGER") {
      const type = id(inline(input.take("TYPE")));
      cones.push({ kind: "trigger", type, position: positionWithSuffix(input.take("POSITION")) });
    } else {
      fail(block, "expected :CONE or :TRIGGER");
    }
  }
  input.end();
  return cones;
}

export interface TrackGroupValues extends NamedRecord {
  readonly carGroups: ReadonlyMap<string, Vec3>;
}

/** TIME and TUNING tables share the same three value slots per track and car group. */
export function parseTrackGroupValues(text: string): Database<TrackGroupValues> {
  const input = tagged(text);
  const tracks = new Map<string, TrackGroupValues>();
  while (input.peek() === "TRACK") {
    const start = input.take("TRACK");
    const idValue = id(inline(start));
    const key = idValue.toLowerCase();
    if (tracks.has(key)) fail(start, `duplicate track "${idValue}"`);
    const carGroups = new Map<string, Vec3>();
    while (input.peek() === "CAR_GROUP_TYPE") {
      const group = inline(input.take("CAR_GROUP_TYPE"));
      arity(group, 4);
      const name = identifier(group, 0);
      if (carGroups.has(name)) fail(group, `duplicate car group "${name}"`);
      carGroups.set(name, [suffixedReal(group, 1), suffixedReal(group, 2), suffixedReal(group, 3)]);
    }
    tracks.set(key, { id: idValue, carGroups });
  }
  input.end(input.peek() === "END");
  return tracks;
}

export interface SpeechGroup extends NamedRecord {
  readonly samples: readonly string[];
}

export function parseSpeechDatabase(text: string): Database<SpeechGroup> {
  const input = tagged(text);
  return records(input, "TYPE", name => {
    const samples: string[] = [];
    while (input.peek() === "SOUND_SAMPLE") samples.push(id(inline(input.take("SOUND_SAMPLE"))));
    return { id: name, samples };
  });
}

export interface WorldRatings {
  readonly ratingScores: ReadonlyMap<string, number>;
  readonly difficultyPoints: ReadonlyMap<DifficultyLevel, number>;
}

export function parseWorldRatings(text: string): WorldRatings {
  const input = tagged(text);
  const ratingScores = new Map<string, number>();
  const difficultyPoints = new Map<DifficultyLevel, number>();
  mark(input.take("DRIVER_RATING_SCORES"));
  while (input.peek() === "DRIVER_RATING") {
    const row = inline(input.take("DRIVER_RATING"));
    arity(row, 2);
    ratingScores.set(identifier(row, 0), integer(row, 1));
  }
  mark(input.take("DRIVER_RATING_DIFFICULTY_LEVEL_POINTS"));
  while (input.peek() === "DIFFICULTY_LEVEL") {
    const row = inline(input.take("DIFFICULTY_LEVEL"));
    arity(row, 2);
    const level = difficultyId({ line: row.line, tokens: row.tokens.slice(0, 1) });
    difficultyPoints.set(level, integer(row, 1));
  }
  input.end();
  return { ratingScores, difficultyPoints };
}

const competitionSchema = {
  ICON_FILENAME: id, CUP_FILENAME: id, TYPE: id, SPEECH_TYPE: id, DIFFICULTY_LEVEL: difficultyId, CAR_TYPE: id,
};

export type Competition = NamedRecord & Fields<typeof competitionSchema> & {
  readonly cars: readonly string[];
  readonly rounds: readonly { readonly trackId: string; readonly laps: number; readonly gameplayId: string }[];
};

export function parseCompetitions(text: string): Database<Competition> {
  const input = tagged(text);
  return records(input, "NAME", name => {
    const options = fields(input, competitionSchema, "CAR", "TRACK", "NAME", "END");
    const cars: string[] = [];
    const rounds: Competition["rounds"][number][] = [];
    while (input.peek() === "CAR") cars.push(id(inline(input.take("CAR"))));
    while (input.peek() === "TRACK") {
      const trackId = id(inline(input.take("TRACK")));
      const laps = whole(inline(input.take("NUMBER_OF_LAPS")));
      const gameplayId = id(inline(input.take("GAMEPLAY_TYPE")));
      rounds.push({ trackId, laps, gameplayId });
    }
    return { id: name, ...options, cars, rounds };
  });
}

const goalSchema = { NAME: id, DIFFICULTY_LEVEL: difficultyId };
export type RewardGoal = Partial<Fields<typeof goalSchema>> & {
  readonly type: string;
  readonly values: readonly (number | string)[];
  readonly rewardGroups: readonly (readonly { readonly type: string; readonly target: string }[])[];
};
export interface RewardObjective extends NamedRecord {
  readonly goals: readonly RewardGoal[];
}

export function parseRewardObjectives(text: string): Database<RewardObjective> {
  // A single reward row in the demo omits its leading colon.
  const input = tagged(text.replace(/^(\s*)TYPE(?=[ \t]+CHALLENGE[ \t]+MACH1_SIXTY\b)/m, "$1:TYPE"));
  return records(input, "OBJECTIVE", name => {
    const goals: RewardGoal[] = [];
    while (input.peek() === "GOAL") {
      mark(input.take("GOAL"));
      const type = id(inline(input.take("TYPE")));
      const values: (number | string)[] = [];
      while (input.peek() === "VALUE") {
        const row = inline(input.take("VALUE"));
        arity(row, 1);
        values.push(/^[+-]?\d+$/.test(row.tokens[0]!) ? integer(row, 0) : identifier(row, 0));
      }
      const goal = fields(input, goalSchema, ["REWARD", "GOAL", "OBJECTIVE", "END"], ["NAME", "DIFFICULTY_LEVEL"]);
      const rewardGroups: { readonly type: string; readonly target: string }[][] = [];
      while (input.peek() === "REWARD") {
        mark(input.take("REWARD"));
        const rewards: { readonly type: string; readonly target: string }[] = [];
        while (input.peek() === "TYPE") {
          const row = inline(input.take("TYPE"));
          arity(row, 2);
          rewards.push({ type: identifier(row, 0), target: identifier(row, 1) });
        }
        mark(input.take("REWARD_END"));
        rewardGroups.push(rewards);
      }
      goals.push({ ...goal, type, values, rewardGroups });
    }
    return { id: name, goals };
  });
}

export interface CollectionUnlock {
  readonly collectionTotal: number;
  readonly driverRating?: string;
  readonly choice: boolean;
  readonly challenges: readonly string[];
}

export function parseCollectionUnlocks(text: string): readonly CollectionUnlock[] {
  const input = tagged(text);
  const unlocks: CollectionUnlock[] = [];
  while (input.peek() !== "END") {
    const collectionTotal = whole(inline(input.take("COLLECTION_TOTAL")));
    const driverRating = input.peek() === "DRIVER_RATING" ? id(inline(input.take("DRIVER_RATING"))) : undefined;
    const choice = input.peek() === "CHOICE";
    if (choice) mark(input.take("CHOICE"));
    const challenges: string[] = [];
    while (input.peek() === "CHALLENGE_TYPE") challenges.push(id(inline(input.take("CHALLENGE_TYPE"))));
    if (input.peek() !== "END") mark(input.take("END_OF_RECORD"));
    unlocks.push({ collectionTotal, driverRating, choice, challenges });
  }
  input.end();
  return unlocks;
}

export interface VibrationPattern extends NamedRecord {
  readonly steps: readonly { readonly index: number; readonly parameters: Vec3 }[];
}

export function parseVibrationPatterns(text: string): Database<VibrationPattern> {
  const input = tagged(text);
  return records(input, "BEGIN_VIBRATION", name => {
    const steps: VibrationPattern["steps"][number][] = [];
    while (input.peek() === "STEP") {
      const row = inline(input.take("STEP"));
      arity(row, 4);
      steps.push({ index: integer(row, 0), parameters: [real(row, 1), real(row, 2), real(row, 3)] });
    }
    // The demo's PS2 SKID closes at the start of the next pattern.
    if (input.peek() !== "BEGIN_VIBRATION") mark(input.take("END_VIBRATION"));
    return { id: name, steps };
  });
}
