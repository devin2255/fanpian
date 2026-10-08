export interface SwipeEvent {
  photoId: string;
  shownAt: number;
  decidedAt: number;
  action: string;
  rolledBack: boolean;
}

export interface MetricsState { events: SwipeEvent[] }

export function emptyMetrics(): MetricsState {
  return { events: [] };
}

export function recordSwipe(m: MetricsState, e: SwipeEvent): MetricsState {
  if (e.decidedAt < e.shownAt) { return m; }   // 脏数据丢弃
  const events = m.events.slice();
  events.push(e);
  return { events: events };
}

export function medianDecisionMs(m: MetricsState): number {
  const n = m.events.length;
  if (n === 0) { return 0; }
  const arr = m.events
    .map((e: SwipeEvent) => e.decidedAt - e.shownAt)
    .sort((a: number, b: number) => a - b);
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

export function rollbackRate(m: MetricsState): number {
  const n = m.events.length;
  if (n === 0) { return 0; }
  let rb = 0;
  for (let i = 0; i < n; i++) { if (m.events[i].rolledBack) { rb++; } }
  return rb / n;
}

export function wallConversion(faved: number, walled: number): number {
  if (faved <= 0) { return 0; }
  return walled / faved;
}
