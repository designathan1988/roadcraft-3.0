/** ELEMENTS: the small things a scene is dressed with, laid by a brush */

const PROP_KINDS = ['stones', 'pebbles', 'gravel', 'leaves', 'grass', 'tallGrass', 'scrub', 'fern', 'clover', 'flowers', 'mushrooms'] as const;
export const EFFECT_KINDS = ['smoke', 'fire', 'steam', 'dust', 'soot', 'sparks', 'spray'] as const;
const ELEMENT_KINDS = [...PROP_KINDS, ...EFFECT_KINDS] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];
export type EffectKind = (typeof EFFECT_KINDS)[number];

const isElementKind = (v: unknown): v is ElementKind => typeof v === 'string' && (ELEMENT_KINDS as readonly string[]).includes(v);
export const isEffectKind = (k: ElementKind): k is EffectKind => (EFFECT_KINDS as readonly string[]).includes(k);

export interface ElementItem {
  readonly kind: ElementKind;
  readonly x: number;
  readonly y: number;
  /** Across, world units (a prop's size; an effect's spread). */
  readonly size: number;
  readonly yaw: number;
  /** 0..1: which model variant, its tint. */
  readonly seed: number;
  /** Effects only: 0..1, how much it gives off. */
  readonly intensity?: number;
}

/** The brush's settings, in the player's units. */
export interface ElementBrush {
  /** Instances per 100 m² at full strength. */
  readonly density: number;
  /** An instance's size, metres. */
  readonly size: number;
  /** 0..100: how far sizes vary about it. */
  readonly variation: number;
  /** Least distance between two instances of the same kind, metres. */
  readonly spacing: number;
  /** 0..100: how much of the density one dab lays. */
  readonly strength: number;
  /** 0..100: effects only, how much each gives off. */
  readonly intensity: number;
}

/** Each kind's own starting brush: a stone is not a blade of grass. */
export const DEFAULT_BRUSH: Readonly<Record<ElementKind, ElementBrush>> = {
  stones: { density: 2, size: 1.2, variation: 60, spacing: 2, strength: 60, intensity: 50 },
  pebbles: { density: 30, size: 0.3, variation: 50, spacing: 0.4, strength: 60, intensity: 50 },
  gravel: { density: 120, size: 0.12, variation: 40, spacing: 0.15, strength: 60, intensity: 50 },
  leaves: { density: 6, size: 1.6, variation: 40, spacing: 0.8, strength: 60, intensity: 50 },
  grass: { density: 40, size: 0.5, variation: 40, spacing: 0.3, strength: 60, intensity: 50 },
  tallGrass: { density: 20, size: 0.9, variation: 40, spacing: 0.5, strength: 60, intensity: 50 },
  scrub: { density: 6, size: 1.2, variation: 50, spacing: 1, strength: 60, intensity: 50 },
  fern: { density: 4, size: 1.1, variation: 40, spacing: 1, strength: 60, intensity: 50 },
  clover: { density: 30, size: 0.25, variation: 40, spacing: 0.2, strength: 60, intensity: 50 },
  flowers: { density: 12, size: 0.5, variation: 40, spacing: 0.4, strength: 60, intensity: 50 },
  mushrooms: { density: 6, size: 0.25, variation: 50, spacing: 0.3, strength: 60, intensity: 50 },
  smoke: { density: 0.3, size: 3, variation: 30, spacing: 8, strength: 100, intensity: 60 },
  fire: { density: 0.3, size: 2, variation: 30, spacing: 4, strength: 100, intensity: 60 },
  steam: { density: 0.3, size: 2, variation: 30, spacing: 6, strength: 100, intensity: 50 },
  dust: { density: 0.3, size: 4, variation: 30, spacing: 8, strength: 100, intensity: 40 },
  soot: { density: 0.3, size: 3, variation: 30, spacing: 8, strength: 100, intensity: 50 },
  sparks: { density: 0.3, size: 1, variation: 30, spacing: 4, strength: 100, intensity: 50 },
  spray: { density: 0.5, size: 2, variation: 30, spacing: 4, strength: 100, intensity: 50 },
};

/** An element read from a saved map, or null if it is not one. */
export function readElement(data: unknown): ElementItem | null {
  const d = data as Partial<Record<keyof ElementItem, unknown>> | null;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!d || !isElementKind(d.kind) || !finite(d.x) || !finite(d.y) || !finite(d.size)) return null;
  return {
    kind: d.kind, x: d.x, y: d.y, size: Math.max(0.01, d.size), yaw: finite(d.yaw) ? d.yaw : 0, seed: finite(d.seed) ? d.seed : 0,
    ...(finite(d.intensity) ? { intensity: Math.min(1, Math.max(0, d.intensity)) } : {}),
  };
}

/** The instances one dab of the brush lays */
export function scatter(kind: ElementKind, brush: ElementBrush, x: number, y: number, radius: number, unitsPerMetre: number,
  random: () => number, nearby: readonly ElementItem[]): ElementItem[] {
  const area = Math.PI * (radius / unitsPerMetre) ** 2;
  const wanted = (brush.density / 100) * area * (brush.strength / 100);
  // A fraction left over is laid by chance, so a light brush still lays some.
  let count = Math.floor(wanted) + (random() < wanted % 1 ? 1 : 0);
  count = Math.min(count, 400);
  const spacing = brush.spacing * unitsPerMetre;
  const out: ElementItem[] = [];
  const same = nearby.filter((e) => e.kind === kind);
  for (let i = 0; i < count * 3 && out.length < count; i++) {
    const r = radius * Math.sqrt(random());
    const a = random() * Math.PI * 2;
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    const free = (e: { x: number; y: number }): boolean => Math.hypot(e.x - px, e.y - py) >= spacing;
    if (!same.every(free) || !out.every(free)) continue;
    const vary = (brush.variation / 100) * (random() * 2 - 1);
    out.push({
      kind, x: px, y: py, size: brush.size * unitsPerMetre * Math.max(0.15, 1 + vary), yaw: random() * Math.PI * 2, seed: random(),
      ...(isEffectKind(kind) ? { intensity: brush.intensity / 100 } : {}),
    });
  }
  return out;
}
