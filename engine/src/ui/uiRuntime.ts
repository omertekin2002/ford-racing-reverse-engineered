import { resolveUiTextureRef, type UiTextureTarget } from "../formats/pcg";
import { lookupTranslation, type TranslationTable } from "../formats/tlate";
import {
  cloneUiNode, indexUiTemplates, parseUiScript, type ParsedUiScript,
  type RgbaColor, type UiNode, type UiScriptLoaderOptions, type Vec2,
} from "../formats/uiScript";

export interface UiRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ResolvedUiDrawItem {
  id: string;
  rect: UiRect;
  textureRef: UiTextureTarget | null;
  color: RgbaColor;
  flip: readonly [boolean, boolean];
  stretch: boolean;
  text: string | null;
  font: number;
  textColor: RgbaColor;
  textJustify: number;
  wordWrap: boolean;
  justifyOffset: Vec2;
  highlighted: boolean;
  enabled: boolean;
  buttonId: string | null;
}

const directions = ["up", "down", "left", "right"] as const;
export type UiDirection = typeof directions[number];

export interface UiScreenOptions extends UiScriptLoaderOptions {
  translation?: TranslationTable;
  commonPaths?: readonly string[];
  /** Pixel dimensions for absolute coordinates and intrinsic graphic sizing. */
  viewport?: { width: number; height: number };
  intrinsicSize?: (texture: UiTextureTarget) => { width: number; height: number } | undefined;
  isAbsolute?: (node: Readonly<UiNode>) => boolean;
}

interface RuntimeNode {
  source: UiNode;
  parent?: RuntimeNode;
  links: Partial<Record<UiDirection, RuntimeNode>>;
  enabled: boolean;
  visible?: boolean;
  rawText?: string;
  clock: number;
  backwards: boolean;
}

const unitRect: UiRect = { x: 0, y: 0, width: 1, height: 1 };
const normalizeId = (id: string) => id.toLowerCase();
const blend = (start: number, end: number, t: number) => start + (end - start) * t;

function blendColor(start: RgbaColor, end: RgbaColor, t: number): RgbaColor {
  return [
    blend(start[0], end[0], t), blend(start[1], end[1], t),
    blend(start[2], end[2], t), blend(start[3], end[3], t),
  ];
}

function endTime(node: UiNode): number {
  return Math.max(0, node.offsetTime + Math.max(node.timeLength, 0));
}

export class UiScreenInstance {
  readonly id: string;
  readonly resources: ParsedUiScript["resources"];
  readonly diagnostics: readonly string[];
  private readonly nodes: RuntimeNode[] = [];
  private readonly ids = new Map<string, RuntimeNode[]>();
  private focus: RuntimeNode | undefined;
  private exiting = false;
  private translation?: TranslationTable;

  static load(path: string, options: UiScreenOptions): UiScreenInstance {
    const source = options.readFile?.(path);
    if (source === undefined) throw new Error(`Missing UI script: ${path}`);
    return new UiScreenInstance(source, options, path);
  }

  constructor(
    script: string | ParsedUiScript,
    private readonly options: UiScreenOptions = {},
    readonly path?: string,
  ) {
    const parsed = typeof script === "string" ? this.parse(script) : script;
    this.id = parsed.roots[0]?.objectId ?? "";
    this.resources = [...parsed.resources];
    this.diagnostics = [...parsed.diagnostics];
    this.translation = options.translation;

    const add = (source: UiNode, parent?: RuntimeNode) => {
      const backwards = source.animationType === 1 || source.animationType === 4;
      const node: RuntimeNode = {
        source, parent, links: {}, enabled: true,
        clock: backwards ? endTime(source) : 0, backwards,
      };
      this.nodes.push(node);
      if (source.objectId) {
        const id = normalizeId(source.objectId);
        const matches = this.ids.get(id) ?? [];
        matches.push(node);
        this.ids.set(id, matches);
      }
      source.children.forEach(child => add(child, node));
    };
    parsed.roots.forEach(root => add(cloneUiNode(root)));

    for (const spec of parsed.connections) {
      for (const node of this.ids.get(normalizeId(spec.sourceId)) ?? []) {
        for (const direction of directions) {
          const id = spec[direction];
          if (!id) {
            delete node.links[direction];
            continue;
          }
          const candidates = this.ids.get(normalizeId(id)) ?? [];
          const target = candidates.find(candidate => candidate.parent === node.parent)
            ?? (candidates.length === 1 ? candidates[0] : undefined);
          if (target) node.links[direction] = target;
          else delete node.links[direction];
        }
      }
    }
    this.repairFocus();
  }

  private parse(source: string): ParsedUiScript {
    const templates = new Map(this.options.templates);
    const resources: ParsedUiScript["resources"] = [];
    const diagnostics: string[] = [];
    for (const path of this.options.commonPaths ?? ["UI/COMOBJ/COMOBJ.UI", "UI/STD_OBJS.UI"]) {
      const common = this.options.readFile?.(path);
      if (common === undefined) continue;
      const parsed = parseUiScript(common, { ...this.options, templates });
      indexUiTemplates(parsed.roots, templates);
      resources.push(...parsed.resources);
      diagnostics.push(...parsed.diagnostics);
    }
    const parsed = parseUiScript(source, { ...this.options, templates });
    parsed.resources.unshift(...resources);
    parsed.diagnostics.unshift(...diagnostics);
    return parsed;
  }

  update(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return;
    const dt = deltaSeconds > 0.5 ? 0.05 : deltaSeconds;
    for (const node of this.nodes) {
      if (this.exiting) {
        node.clock = Math.max(0, node.clock - dt);
        continue;
      }
      const end = endTime(node.source);
      if (end <= 0) continue;
      const pingPong = node.source.animationType === 3 || node.source.animationType === 4;
      node.clock += node.backwards ? -dt : dt;
      if (node.clock > end) {
        node.clock = end;
        if (pingPong) node.backwards = true;
      } else if (node.clock < 0) {
        node.clock = 0;
        if (pingPong) node.backwards = false;
      }
    }
  }

  startExit(): void {
    if (this.exiting) return;
    this.exiting = true;
    for (const node of this.nodes) {
      if (node.source.timeLength <= 0) node.clock = 0;
    }
  }

  isExitComplete(): boolean {
    return this.exiting && this.nodes.every(node => node.clock <= 0);
  }

  setTranslation(table?: TranslationTable): void {
    this.translation = table;
  }

  setNodeText(id: string, key: string | null): boolean {
    const node = this.find(id);
    if (!node) return false;
    node.source.text = key === "0" ? null : key;
    node.rawText = undefined;
    return true;
  }

  setNodeTextRaw(id: string, text: string | null): boolean {
    const node = this.find(id);
    if (!node) return false;
    node.source.text = null;
    node.rawText = text ?? undefined;
    return true;
  }

  setNodeTexture(id: string, texture: string | null): boolean {
    const node = this.find(id);
    if (!node) return false;
    node.source.textureEnum = texture;
    return true;
  }

  setNodeVisible(id: string, visible: boolean): boolean {
    const node = this.find(id);
    if (!node) return false;
    node.visible = visible;
    this.repairFocus();
    return true;
  }

  setNodeEnabled(id: string, enabled: boolean): boolean {
    const node = this.find(id);
    if (!node) return false;
    node.enabled = enabled;
    this.repairFocus();
    return true;
  }

  setFocus(id: string | null): boolean {
    if (id === null) {
      this.focus = undefined;
      return true;
    }
    const node = this.ids.get(normalizeId(id))?.find(candidate => this.canFocus(candidate));
    if (!node) return false;
    this.focus = node;
    return true;
  }

  getFocusedId(): string | null {
    return this.focus?.source.objectId ?? null;
  }

  moveFocus(direction: UiDirection): string | null {
    if (this.exiting) return this.getFocusedId();
    const origin = this.focus;
    if (!origin) {
      this.repairFocus();
      return this.getFocusedId();
    }

    let candidate = origin.links[direction];
    if (candidate) {
      const visited = new Set([origin]);
      while (candidate && !visited.has(candidate)) {
        if (this.canFocus(candidate)) {
          this.focus = candidate;
          break;
        }
        visited.add(candidate);
        candidate = candidate.links[direction];
      }
      return this.getFocusedId();
    }

    const rects = this.resolveRects();
    const from = rects.get(origin)!;
    let nearest = Infinity;
    for (const node of this.nodes) {
      if (node === origin || !this.canFocus(node)) continue;
      const to = rects.get(node)!;
      const dx = to.x - from.x + (to.width - from.width) / 2;
      const dy = to.y - from.y + (to.height - from.height) / 2;
      const ahead = { up: -dy, down: dy, left: -dx, right: dx }[direction];
      if (ahead <= 0) continue;
      const distance = Math.hypot(dx, dy);
      if (distance < nearest) {
        nearest = distance;
        this.focus = node;
      }
    }
    return this.getFocusedId();
  }

  hitTest(x: number, y: number): string | null {
    return this.buttonAt(x, y)?.source.objectId ?? null;
  }

  pointerMove(x: number, y: number): string | null {
    const hit = this.buttonAt(x, y);
    if (hit) this.focus = hit;
    return hit?.source.objectId ?? null;
  }

  pointerClick(x: number, y: number): string | null {
    return this.pointerMove(x, y);
  }

  private buttonAt(x: number, y: number): RuntimeNode | undefined {
    if (this.exiting || !(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return;
    const rects = this.resolveRects();
    // Paint order is preorder, so the last eligible item receives the click.
    for (let index = this.nodes.length - 1; index >= 0; index--) {
      const node = this.nodes[index]!;
      if (!this.canFocus(node)) continue;
      const rect = rects.get(node)!;
      if (rect.width > 0 && rect.height > 0 && x >= rect.x && x <= rect.x + rect.width
        && y >= rect.y && y <= rect.y + rect.height) return node;
    }
  }

  getDrawItems(): ResolvedUiDrawItem[] {
    const rects = this.resolveRects();
    const items: ResolvedUiDrawItem[] = [];
    for (const node of this.nodes) {
      if (!this.isVisible(node)) continue;
      const source = node.source;
      const textureRef = this.texture(node);
      const key = source.text;
      const text = node.rawText ?? (key && this.translation ? lookupTranslation(this.translation, key) ?? key : key);
      const buttonId = this.canFocus(node) && !this.exiting ? source.objectId : null;
      if (!textureRef && text === null && !buttonId) continue;

      const highlighted = node === this.focus || (this.focus !== undefined && this.focus === node.parent);
      const progress = this.progress(node);
      const textColor = highlighted ? source.highlightedFontColour : source.fontColour;
      const textColorStart = highlighted ? source.highlightedFontColourStart : source.fontColourStart;
      const color = highlighted ? [...source.highlightedColour] as RgbaColor
        : blendColor(source.colourStart ?? source.colour, source.colourEnd ?? source.colour, progress);
      items.push({
        id: source.objectId, rect: rects.get(node)!, textureRef, color,
        flip: [Boolean(source.flipGraphic[0]), Boolean(source.flipGraphic[1])],
        stretch: Boolean(source.stretchGraphic), text,
        font: highlighted ? source.highlightedFont : source.font,
        textColor: blendColor(textColorStart ?? textColor, textColor, progress),
        textJustify: source.textJustify, wordWrap: Boolean(source.wordWrap),
        justifyOffset: [...source.justifyOffset], highlighted, enabled: node.enabled, buttonId,
      });
    }
    return items;
  }

  getNodeRect(id: string): UiRect | undefined {
    const node = this.find(id);
    return node && this.resolveRects().get(node);
  }

  private find(id: string): RuntimeNode | undefined {
    return this.ids.get(normalizeId(id))?.[0];
  }

  private isVisible(node: RuntimeNode): boolean {
    return node.visible ?? Boolean(node.source.drawable);
  }

  private canFocus(node: RuntimeNode): boolean {
    return node.source.type === "UI_TYPE_BUTTON" && !!node.source.objectId
      && node.enabled && this.isVisible(node);
  }

  private repairFocus(): void {
    if (!this.focus || !this.canFocus(this.focus)) {
      this.focus = this.nodes.find(node => this.canFocus(node));
    }
  }

  private texture(node: RuntimeNode): UiTextureTarget | null {
    return node.source.textureEnum === null ? null : resolveUiTextureRef(node.source.textureEnum);
  }

  private progress(node: RuntimeNode): number {
    const { timeLength, offsetTime } = node.source;
    if (timeLength <= 0) return 0;
    return Math.max(0, Math.min(1, (node.clock - offsetTime) / timeLength));
  }

  private resolveRects(): Map<RuntimeNode, UiRect> {
    const rects = new Map<RuntimeNode, UiRect>();
    const viewport = this.options.viewport ?? { width: 1, height: 1 };
    for (const node of this.nodes) {
      const s = node.source;
      const parent = node.parent ? rects.get(node.parent)! : unitRect;
      const t = this.progress(node);
      const start = s.sizeStart ?? s.size;
      const end = s.sizeEnd ?? s.size;
      const absolute = this.options.isAbsolute?.(s);
      const scaleX = absolute ? 1 / viewport.width : parent.width;
      const scaleY = absolute ? 1 / viewport.height : parent.height;
      const texture = s.autosize ? this.texture(node) : null;
      const intrinsic = texture && this.options.intrinsicSize?.(texture);
      const width = blend(start[0], end[0], t);
      const height = blend(start[1], end[1], t);
      rects.set(node, {
        x: parent.x + blend(s.positionStart[0], s.positionEnd[0], t) * scaleX,
        y: parent.y + blend(s.positionStart[1], s.positionEnd[1], t) * scaleY,
        width: width * (intrinsic ? intrinsic.width / viewport.width : scaleX),
        height: height * (intrinsic ? intrinsic.height / viewport.height : scaleY),
      });
    }
    return rects;
  }
}
