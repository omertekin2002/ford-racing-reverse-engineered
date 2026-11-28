export type UiWidgetType =
  | "UI_TYPE_UNKNOWN"
  | "UI_TYPE_AREA"
  | "UI_TYPE_BASIC"
  | "UI_TYPE_BUTTON"
  | "UI_TYPE_GRAPHIC"
  | "UI_TYPE_TEXT"
  | "UI_TYPE_SCREEN"
  | "UI_TYPE_LIST_BOX";

export type RgbaColor = [number, number, number, number];
export type Vec2 = [number, number];

export interface UiConnectionSpec {
  sourceId: string;
  up: string | null;
  down: string | null;
  left: string | null;
  right: string | null;
}

export interface UiResourceDecl {
  kind: "graphic" | "collection";
  path: string;
  arg0: number;
  arg1: number;
}

export interface UiNode {
  type: UiWidgetType;
  objectId: string;
  inheritedFrom: string | null;
  animationType: number;
  autosize: number;
  clear: number;
  drawable: number;
  stretchGraphic: number;
  wordWrap: number;
  flipGraphic: [number, number];
  font: number;
  highlightedFont: number;
  itemNumber: number;
  text: string | null;
  textJustify: number;
  textureEnum: string | null;
  colour: RgbaColor;
  colourStart: RgbaColor | null;
  colourEnd: RgbaColor | null;
  highlightedColour: RgbaColor;
  fontColour: RgbaColor;
  fontColourStart: RgbaColor | null;
  highlightedFontColour: RgbaColor;
  highlightedFontColourStart: RgbaColor | null;
  positionStart: Vec2;
  positionEnd: Vec2;
  size: Vec2;
  sizeStart: Vec2 | null;
  sizeEnd: Vec2 | null;
  justifyOffset: Vec2;
  timeLength: number;
  offsetTime: number;
  children: UiNode[];
}

export interface ParsedUiScript {
  roots: UiNode[];
  connections: UiConnectionSpec[];
  resources: UiResourceDecl[];
  diagnostics: string[];
  balancedBlocks: number;
}

export interface UiScriptLoaderOptions {
  /** Optional synchronous or preloaded file resolver for `:READ_SCRIPT_FILE`. */
  readFile?: (relativePath: string) => string | undefined;
  /** Optional common template registry (e.g. from `UI/COMOBJ/COMOBJ.UI` or `UI/STD_OBJS.UI`). */
  templates?: Map<string, UiNode>;
  maxDepth?: number;
}

const VALID_WIDGET_TYPES = new Set<UiWidgetType>([
  "UI_TYPE_UNKNOWN",
  "UI_TYPE_AREA",
  "UI_TYPE_BASIC",
  "UI_TYPE_BUTTON",
  "UI_TYPE_GRAPHIC",
  "UI_TYPE_TEXT",
  "UI_TYPE_SCREEN",
  "UI_TYPE_LIST_BOX",
]);

function snap4096(value: number): number {
  return Math.round(value * 4096) / 4096;
}

function createDefaultNode(type: UiWidgetType): UiNode {
  return {
    type,
    objectId: "",
    inheritedFrom: null,
    animationType: 0,
    autosize: 0,
    clear: 1,
    drawable: 1,
    stretchGraphic: 0,
    wordWrap: 0,
    flipGraphic: [0, 0],
    font: 0,
    highlightedFont: 0,
    itemNumber: -1,
    text: null,
    textJustify: 0,
    textureEnum: null,
    colour: [255, 255, 255, 255],
    colourStart: null,
    colourEnd: null,
    highlightedColour: [255, 255, 255, 255],
    fontColour: [255, 255, 255, 255],
    fontColourStart: null,
    highlightedFontColour: [255, 255, 255, 255],
    highlightedFontColourStart: null,
    positionStart: [0, 0],
    positionEnd: [0, 0],
    size: [1, 1],
    sizeStart: null,
    sizeEnd: null,
    justifyOffset: [0, 0],
    timeLength: 0,
    offsetTime: 0,
    children: [],
  };
}

export function cloneUiNode(node: UiNode): UiNode {
  return {
    ...node,
    flipGraphic: [node.flipGraphic[0], node.flipGraphic[1]],
    colour: [...node.colour] as RgbaColor,
    colourStart: node.colourStart ? ([...node.colourStart] as RgbaColor) : null,
    colourEnd: node.colourEnd ? ([...node.colourEnd] as RgbaColor) : null,
    highlightedColour: [...node.highlightedColour] as RgbaColor,
    fontColour: [...node.fontColour] as RgbaColor,
    fontColourStart: node.fontColourStart ? ([...node.fontColourStart] as RgbaColor) : null,
    highlightedFontColour: [...node.highlightedFontColour] as RgbaColor,
    highlightedFontColourStart: node.highlightedFontColourStart
      ? ([...node.highlightedFontColourStart] as RgbaColor)
      : null,
    positionStart: [node.positionStart[0], node.positionStart[1]],
    positionEnd: [node.positionEnd[0], node.positionEnd[1]],
    size: [node.size[0], node.size[1]],
    sizeStart: node.sizeStart ? [node.sizeStart[0], node.sizeStart[1]] : null,
    sizeEnd: node.sizeEnd ? [node.sizeEnd[0], node.sizeEnd[1]] : null,
    justifyOffset: [node.justifyOffset[0], node.justifyOffset[1]],
    children: node.children.map(cloneUiNode),
  };
}

/** Tokenize a `.UI` file while stripping `//` line comments outside double quotes. */
function tokenizeUi(source: string): string[] {
  const tokens: string[] = [];
  const len = source.length;
  let i = 0;

  while (i < len) {
    const ch = source[i]!;
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === ",") {
      i++;
      continue;
    }
    if (ch === "/" && i + 1 < len && source[i + 1] === "/") {
      i += 2;
      while (i < len && source[i] !== "\n" && source[i] !== "\r") i++;
      continue;
    }
    if (ch === '"') {
      const start = ++i;
      while (i < len && source[i] !== '"') i++;
      tokens.push(source.slice(start, i));
      if (i < len && source[i] === '"') i++;
      continue;
    }
    const start = i;
    while (i < len) {
      const c = source[i]!;
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === ",") break;
      if (c === "/" && i + 1 < len && source[i + 1] === "/") break;
      i++;
    }
    tokens.push(source.slice(start, i));
  }
  return tokens;
}

function parseIntTolerant(token: string, diagnostics: string[]): number {
  if (token.toUpperCase() === "TEXT_JUSTIFY_CENTRE") return 0;
  const m = /^[+-]?\d+/.exec(token);
  if (!m) {
    diagnostics.push(`Non-integer token "${token}" defaulted to 0`);
    return 0;
  }
  if (m[0] !== token) {
    diagnostics.push(`Recovered malformed integer token "${token}" -> ${m[0]}`);
  }
  return Number.parseInt(m[0], 10);
}

function parseFloatTolerant(token: string, snap: boolean, diagnostics: string[]): number {
  const m = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(token);
  if (!m) {
    diagnostics.push(`Non-float token "${token}" defaulted to 0`);
    return 0;
  }
  if (m[0] !== token) {
    diagnostics.push(`Recovered malformed float token "${token}" -> ${m[0]}`);
  }
  const value = Number.parseFloat(m[0]);
  return snap ? snap4096(value) : value;
}

function parseByte(token: string, diagnostics: string[]): number {
  return parseIntTolerant(token, diagnostics) & 0xff;
}

export function indexUiTemplates(nodes: UiNode[], map = new Map<string, UiNode>()): Map<string, UiNode> {
  // Index sibling templates before recursing into children so top-level definitions (e.g. COMOBJ.UI's
  // horizontal MENUBAR) are never overwritten by nested child nodes that reuse the same OBJECT_ID
  // (e.g. VERTICAL_BOTTOM_BAR's child MENUBAR).
  for (const node of nodes) {
    if (node.objectId) {
      const key = node.objectId.toLowerCase();
      if (!map.has(key)) map.set(key, node);
    }
  }
  for (const node of nodes) {
    indexUiTemplates(node.children, map);
  }
  return map;
}

export function parseUiScript(source: string, options: UiScriptLoaderOptions = {}): ParsedUiScript {
  const maxDepth = options.maxDepth ?? 20;
  const templates = options.templates ?? new Map<string, UiNode>();
  const localIndex = new Map<string, UiNode>();
  const roots: UiNode[] = [];
  const connections: UiConnectionSpec[] = [];
  const resources: UiResourceDecl[] = [];
  const diagnostics: string[] = [];
  const includeStack = new Set<string>();
  let balancedBlocks = 0;

  function findTemplate(id: string): UiNode | undefined {
    const key = id.toLowerCase();
    return templates.get(key) ?? localIndex.get(key);
  }

  function parseTokens(tokens: string[], parentStack: (UiNode | null)[], depth: number): UiNode | null {
    let current: UiNode | null = null;
    let idx = 0;

    const next = (): string => (idx < tokens.length ? tokens[idx++]! : "");

    const attachNode = (node: UiNode): void => {
      const parent = parentStack.length > 0 ? parentStack[parentStack.length - 1]! : null;
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
      current = node;
    };

    while (idx < tokens.length) {
      const rawTok = tokens[idx++]!;
      if (!rawTok.startsWith(":")) {
        diagnostics.push(`Ignored non-tag token "${rawTok}"`);
        continue;
      }
      // Recover doubled leading colon (e.g. `::OBJECT_ID` in 3DDEBUG/CAMDISP.UI).
      const tag = rawTok.replace(/^:+/, "").toUpperCase();

      switch (tag) {
        case "S{*****>>>": {
          if (parentStack.length >= maxDepth) {
            throw new Error(`UI nesting depth exceeded ${maxDepth}`);
          }
          parentStack.push(current);
          break;
        }
        case "E}*****<<<": {
          if (parentStack.length === 0) {
            diagnostics.push("Unmatched closing block :E}*****<<<");
          } else {
            current = parentStack.pop() ?? null;
            balancedBlocks++;
          }
          break;
        }
        case "TYPE": {
          const typeTok = next().toUpperCase() as UiWidgetType;
          const widgetType: UiWidgetType = VALID_WIDGET_TYPES.has(typeTok) ? typeTok : "UI_TYPE_UNKNOWN";
          attachNode(createDefaultNode(widgetType));
          break;
        }
        case "INHERIT": {
          const targetId = next();
          const tpl = findTemplate(targetId);
          const cloned = tpl ? cloneUiNode(tpl) : createDefaultNode("UI_TYPE_BASIC");
          cloned.inheritedFrom = targetId;
          attachNode(cloned);
          break;
        }
        case "READ_SCRIPT_FILE": {
          const relPath = next();
          const normPath = relPath.replace(/\\/g, "/").toLowerCase();
          if (options.readFile) {
            if (includeStack.has(normPath)) {
              throw new Error(`Cyclic :READ_SCRIPT_FILE include: ${relPath}`);
            }
            if (depth >= maxDepth) {
              throw new Error(`:READ_SCRIPT_FILE depth exceeded ${maxDepth}`);
            }
            const includedText = options.readFile(relPath);
            if (includedText === undefined) {
              diagnostics.push(`Missing included UI script: ${relPath}`);
            } else {
              includeStack.add(normPath);
              const includedResult = parseTokens(tokenizeUi(includedText), parentStack, depth + 1);
              includeStack.delete(normPath);
              if (includedResult) {
                current = includedResult;
              }
            }
          }
          break;
        }
        case "CONNECTION": {
          const src = next();
          const up = next();
          const down = next();
          const left = next();
          const right = next();
          const norm = (s: string): string | null => (!s || s.toLowerCase() === "none" ? null : s);
          connections.push({
            sourceId: src,
            up: norm(up),
            down: norm(down),
            left: norm(left),
            right: norm(right),
          });
          break;
        }
        case "CREATE_TEXTURE_GRAPHIC":
        case "CREATE_TEXTURE_GRAPHIC_COLLECTION": {
          const path = next();
          const arg0 = parseIntTolerant(next(), diagnostics);
          const arg1 = parseIntTolerant(next(), diagnostics);
          resources.push({
            kind: tag === "CREATE_TEXTURE_GRAPHIC" ? "graphic" : "collection",
            path,
            arg0,
            arg1,
          });
          break;
        }
        case "OBJECT_ID": {
          const id = next();
          if (current) {
            current.objectId = id;
            if (id) localIndex.set(id.toLowerCase(), current);
          }
          break;
        }
        case "ANIMATION_TYPE":
          if (current) current.animationType = parseIntTolerant(next(), diagnostics);
          else next();
          break;
        case "AUTOSIZE":
          if (current) current.autosize = parseIntTolerant(next(), diagnostics);
          else next();
          break;
        case "CLEAR":
          if (current) current.clear = parseIntTolerant(next(), diagnostics);
          else next();
          break;
        case "DRAWABLE":
          if (current) current.drawable = parseIntTolerant(next(), diagnostics);
          else next();
          break;
        case "STRETCH_GRAPHIC":
          if (current) current.stretchGraphic = parseIntTolerant(next(), diagnostics);
          else next();
          break;
        case "WORD_WRAP":
          if (current) current.wordWrap = Math.trunc(parseFloatTolerant(next(), false, diagnostics));
          else next();
          break;
        case "FLIP_GRAPHIC": {
          const fx = parseIntTolerant(next(), diagnostics);
          const fy = parseIntTolerant(next(), diagnostics);
          if (current) current.flipGraphic = [fx, fy];
          break;
        }
        case "FONT":
          if (current) current.font = parseIntTolerant(next(), diagnostics);
          else next();
          break;
        case "HIGHLIGHTED_FONT":
          if (current) current.highlightedFont = parseIntTolerant(next(), diagnostics);
          else next();
          break;
        case "ITEM_NUMBER":
          if (current) current.itemNumber = parseIntTolerant(next(), diagnostics);
          else next();
          break;
        case "TEXT": {
          const val = next();
          if (current) current.text = val === "0" ? null : val;
          break;
        }
        case "TEXT_JUSTIFY":
          if (current) current.textJustify = parseIntTolerant(next(), diagnostics);
          else next();
          break;
        case "TEXTURE_ENUM": {
          const val = next();
          if (current) current.textureEnum = !val || val.toLowerCase() === "none" ? null : val;
          break;
        }
        case "COLOUR": {
          const c: RgbaColor = [
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
          ];
          if (current) current.colour = c;
          break;
        }
        case "COLOUR_START": {
          const c: RgbaColor = [
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
          ];
          if (current) current.colourStart = c;
          break;
        }
        case "COLOUR_END": {
          const c: RgbaColor = [
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
          ];
          if (current) current.colourEnd = c;
          break;
        }
        case "HIGHLIGHTED_COLOUR": {
          const c: RgbaColor = [
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
          ];
          if (current) current.highlightedColour = c;
          break;
        }
        case "FONT_COLOUR": {
          const c: RgbaColor = [
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
          ];
          if (current) current.fontColour = c;
          break;
        }
        case "FONT_COLOUR_START": {
          const c: RgbaColor = [
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
          ];
          if (current) current.fontColourStart = c;
          break;
        }
        case "HIGHLIGHTED_FONT_COLOUR": {
          const c: RgbaColor = [
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
          ];
          if (current) current.highlightedFontColour = c;
          break;
        }
        case "HIGHLIGHTED_FONT_COLOUR_START": {
          const c: RgbaColor = [
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
            parseByte(next(), diagnostics),
          ];
          if (current) current.highlightedFontColourStart = c;
          break;
        }
        case "POSITION_START": {
          const v: Vec2 = [
            parseFloatTolerant(next(), true, diagnostics),
            parseFloatTolerant(next(), true, diagnostics),
          ];
          if (current) current.positionStart = v;
          break;
        }
        case "POSITION_END": {
          const v: Vec2 = [
            parseFloatTolerant(next(), true, diagnostics),
            parseFloatTolerant(next(), true, diagnostics),
          ];
          if (current) current.positionEnd = v;
          break;
        }
        case "SIZE": {
          const v: Vec2 = [
            parseFloatTolerant(next(), true, diagnostics),
            parseFloatTolerant(next(), true, diagnostics),
          ];
          if (current) current.size = v;
          break;
        }
        case "SIZE_START": {
          const v: Vec2 = [
            parseFloatTolerant(next(), true, diagnostics),
            parseFloatTolerant(next(), true, diagnostics),
          ];
          if (current) current.sizeStart = v;
          break;
        }
        case "SIZE_END": {
          const v: Vec2 = [
            parseFloatTolerant(next(), true, diagnostics),
            parseFloatTolerant(next(), true, diagnostics),
          ];
          if (current) current.sizeEnd = v;
          break;
        }
        case "JUSTIFY_OFFSET": {
          const v: Vec2 = [
            parseFloatTolerant(next(), true, diagnostics),
            parseFloatTolerant(next(), true, diagnostics),
          ];
          if (current) current.justifyOffset = v;
          break;
        }
        case "TIME_LENGTH":
          if (current) current.timeLength = parseFloatTolerant(next(), true, diagnostics);
          else next();
          break;
        case "OFFSET_TIME":
          if (current) current.offsetTime = parseFloatTolerant(next(), true, diagnostics);
          else next();
          break;
        case "HIGHLIGHTED_POSITION":
        case "HIGHLIGHTED_POSITION_START":
        case "HIGHLIGHTED_SIZE":
        case "HIGHLIGHTED_SIZE_START":
        case "UNKNOWN":
          // Registered no-op tags consuming zero arguments in the PC loader.
          break;
        default:
          diagnostics.push(`Unknown UI tag :${tag}`);
          break;
      }
    }
    return current;
  }

  const stack: (UiNode | null)[] = [];
  parseTokens(tokenizeUi(source), stack, 0);
  if (stack.length !== 0) {
    diagnostics.push(`Unclosed UI blocks remaining: ${stack.length}`);
  }
  return { roots, connections, resources, diagnostics, balancedBlocks };
}

export function collectUiNodes(roots: UiNode[]): UiNode[] {
  const out: UiNode[] = [];
  const walk = (nodes: UiNode[]): void => {
    for (const node of nodes) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(roots);
  return out;
}
