export interface Region {
  id: string;
  name: string;
  geojson: string;
  bounds: number[];   // [minLon, minLat, maxLon, maxLat]
}

export interface Projected { x: number; y: number }

export const CHINA_REGION: Region = {
  id: 'china',
  name: '中国',
  geojson: 'assets/geo/china.json',
  bounds: [73, 18, 135, 54]
};

const DEG = Math.PI / 180;

function mercY(lat: number): number {
  const clamped = Math.max(-85, Math.min(85, lat));
  return Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2));
}

export function projectMercator(
  lon: number, lat: number, w: number, h: number, bounds: number[]
): Projected {
  const minLon = bounds[0];
  const minLat = bounds[1];
  const maxLon = bounds[2];
  const maxLat = bounds[3];
  const x = ((lon - minLon) / (maxLon - minLon)) * w;
  const yTop = mercY(maxLat);
  const yBottom = mercY(minLat);
  const y = ((yTop - mercY(lat)) / (yTop - yBottom)) * h;
  return { x: x, y: y };
}
