export const MAX_HANG = 9;
export const EXPAND_ALL_MAX = 3;
export const COLLAPSE_THRESHOLD = 15;
export const MIN_PIN_DIST_PT = 40;
export const MIN_ZOOM_FOR_EXPAND = 0.5;

export interface PlacedPin { pinId: string; x: number; y: number }
export interface PinLayout { pinId: string; expanded: boolean; count: number }

export function computeLayout(
  pins: PlacedPin[], counts: Map<string, number>, zoom: number
): PinLayout[] {
  const out: PinLayout[] = [];
  const tooSmall = zoom < MIN_ZOOM_FOR_EXPAND;
  const collapsed = pins.length > COLLAPSE_THRESHOLD;

  for (let i = 0; i < pins.length; i++) {
    const p = pins[i];
    const raw = counts.get(p.pinId);
    const n = raw === undefined ? 0 : raw;
    let expanded = false;
    if (!tooSmall && !collapsed) {
      if (pins.length <= EXPAND_ALL_MAX) {
        expanded = n > 0;
      } else {
        expanded = n >= 3;
      }
    }
    out.push({ pinId: p.pinId, expanded: expanded, count: Math.min(n, MAX_HANG) });
  }
  return out;
}

export function clusterByScreen(placed: PlacedPin[], minDistPt: number): number[][] {
  const n = placed.length;
  const parent: number[] = [];
  for (let i = 0; i < n; i++) { parent.push(i); }
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) { r = parent[r]; }
    return r;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = placed[i].x - placed[j].x;
      const dy = placed[i].y - placed[j].y;
      if (Math.sqrt(dx * dx + dy * dy) <= minDistPt) {
        const ri = find(i);
        const rj = find(j);
        if (ri !== rj) { parent[rj] = ri; }
      }
    }
  }
  const buckets: Map<number, number[]> = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const arr = buckets.get(r);
    if (arr === undefined) { buckets.set(r, [i]); } else { arr.push(i); }
  }
  const out: number[][] = [];
  buckets.forEach((v: number[]) => { out.push(v); });
  return out;
}
