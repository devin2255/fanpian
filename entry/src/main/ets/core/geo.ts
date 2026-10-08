export type PinKind = 'gps' | 'manual' | 'named';

export interface GeoPoint { lat: number; lon: number }

export interface Pin {
  id: string;
  name: string;
  lat: number;
  lon: number;
  kind: PinKind;
}

export const EARTH_RADIUS_M = 6371000;

const DEG = Math.PI / 180;

export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const h = s1 * s1 + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * s2 * s2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function dmsToDecimal(dms: string): number {
  if (dms === undefined || dms === null || dms === '') { return NaN; }
  const norm = dms.replace(/，/g, ',');
  const parts: string[] = norm.split(',');
  if (parts.length < 3) { return NaN; }
  const d = parseFloat(parts[0].trim());
  const m = parseFloat(parts[1].trim());
  const s = parseFloat(parts[2].trim());
  if (Number.isNaN(d) || Number.isNaN(m) || Number.isNaN(s)) { return NaN; }
  return d + m / 60 + s / 3600;
}

export function applyRef(dec: number, ref: string): number {
  if (Number.isNaN(dec) || ref === undefined || ref === null || ref === '') { return dec; }
  const r = ref.trim().toUpperCase();
  const neg = (r === 'S' || r === 'W' || r === '83' || r === '87');
  return neg ? -dec : dec;
}

export function parseExifCoord(dms: string, ref: string): number {
  return applyRef(dmsToDecimal(dms), ref);
}

export function clusterPoints(points: GeoPoint[], thresholdM: number): number[][] {
  const n = points.length;
  const parent: number[] = [];
  for (let i = 0; i < n; i++) { parent.push(i); }
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) { r = parent[r]; }
    return r;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (haversineMeters(points[i], points[j]) <= thresholdM) {
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

export function medianPoint(points: GeoPoint[]): GeoPoint {
  if (points.length === 0) { return { lat: 0, lon: 0 }; }
  const lats = points.map((p: GeoPoint) => p.lat).sort((a: number, b: number) => a - b);
  const lons = points.map((p: GeoPoint) => p.lon).sort((a: number, b: number) => a - b);
  const mid = Math.floor(points.length / 2);
  const lat = points.length % 2 === 1 ? lats[mid] : (lats[mid - 1] + lats[mid]) / 2;
  const lon = points.length % 2 === 1 ? lons[mid] : (lons[mid - 1] + lons[mid]) / 2;
  return { lat: lat, lon: lon };
}

export function dedupePins(pins: Pin[], thresholdM: number): Pin[] {
  // 用户钉（manual/named）优先保留；把 gps 钉并进最近的用户钉
  const userPins = pins.filter((p: Pin) => p.kind !== 'gps');
  const gpsPins = pins.filter((p: Pin) => p.kind === 'gps');
  const keptGps: Pin[] = [];

  for (let i = 0; i < gpsPins.length; i++) {
    const g = gpsPins[i];
    let merged = false;
    for (let j = 0; j < userPins.length; j++) {
      if (haversineMeters(g, userPins[j]) <= thresholdM) { merged = true; break; }
    }
    if (merged) { continue; }
    // 只在已保留的 gps 钉之间去重（user pin 已在上一循环排除）
    let dup = false;
    for (let j = 0; j < keptGps.length; j++) {
      if (haversineMeters(g, keptGps[j]) <= thresholdM) { dup = true; break; }
    }
    if (!dup) { keptGps.push(g); }
  }
  return userPins.concat(keptGps);
}
