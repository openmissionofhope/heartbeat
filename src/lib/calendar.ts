/**
 * Business-hours arithmetic in a host's own time zone, honoring weekends, holidays and
 * daylight-saving changes. All instants are epoch milliseconds.
 */
export interface Hours {
  tz: string;
  /** Minutes after local midnight when staffed hours start and end, e.g. 480 and 1020. */
  startMin: number;
  endMin: number;
  /** ISO weekdays that are staffed: 1 = Monday … 7 = Sunday. */
  days: number[];
  /** Local dates (YYYY-MM-DD) that are not staffed. */
  holidays: Set<string>;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const FMT = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = FMT.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    FMT.set(tz, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export interface LocalParts { y: number; m: number; d: number; hh: number; mm: number; ss: number; weekday: number }

export function localParts(t: number, tz: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(new Date(t))) parts[p.type] = p.value;
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    hh: Number(parts.hour), mm: Number(parts.minute), ss: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday!] ?? 0,
  };
}

/** Offset of the zone from UTC at instant t, in ms (local = utc + offset). */
function offsetAt(t: number, tz: string): number {
  const p = localParts(t, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** The instant at which local wall-clock time (y-m-d, minutes after midnight) occurs in tz. */
export function zonedToUtc(y: number, m: number, d: number, minutes: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  let t = guess - offsetAt(guess, tz);
  const o2 = offsetAt(t, tz);
  if (guess - o2 !== t) t = guess - o2;
  return t;
}

export function localDate(t: number, tz: string): string {
  const p = localParts(t, tz);
  return isoDate(p.y, p.m, p.d);
}

function isoDate(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function addDays(date: string, n: number): { y: number; m: number; d: number; s: string; weekday: number } {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const u = new Date(Date.UTC(y, m - 1, d + n));
  const wd = u.getUTCDay() === 0 ? 7 : u.getUTCDay();
  return { y: u.getUTCFullYear(), m: u.getUTCMonth() + 1, d: u.getUTCDate(), s: isoDate(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate()), weekday: wd };
}

/** Staffed window [start, end) for a local date, or null if that date is not staffed. */
export function dayWindow(date: string, h: Hours): [number, number] | null {
  const day = addDays(date, 0);
  if (!h.days.includes(day.weekday) || h.holidays.has(day.s)) return null;
  return [zonedToUtc(day.y, day.m, day.d, h.startMin, h.tz), zonedToUtc(day.y, day.m, day.d, h.endMin, h.tz)];
}

export function isOpen(t: number, h: Hours): boolean {
  const w = dayWindow(localDate(t, h.tz), h);
  return !!w && t >= w[0] && t < w[1];
}

/** Earliest instant ≥ t inside staffed hours. */
export function nextOpen(t: number, h: Hours): number {
  let date = localDate(t, h.tz);
  for (let i = 0; i < 400; i++) {
    const w = dayWindow(date, h);
    if (w) {
      if (t < w[0]) return w[0];
      if (t < w[1]) return t;
    }
    date = addDays(date, 1).s;
  }
  throw new Error('no staffed hours within 400 days');
}

/** Start of the first staffed day strictly after the local date of t. */
export function nextBusinessDayStart(t: number, h: Hours): number {
  let date = addDays(localDate(t, h.tz), 1).s;
  for (let i = 0; i < 400; i++) {
    const w = dayWindow(date, h);
    if (w) return w[0];
    date = addDays(date, 1).s;
  }
  throw new Error('no staffed hours within 400 days');
}

/** Start of the staffed day containing t, if t is in a staffed day (even outside hours). */
export function businessDayStartOf(t: number, h: Hours): number | null {
  const w = dayWindow(localDate(t, h.tz), h);
  return w ? w[0] : null;
}

/** Adds staffed minutes to t (time outside staffed hours does not count). */
export function addBusinessMinutes(t: number, minutes: number, h: Hours): number {
  let remaining = minutes * MINUTE;
  let cur = nextOpen(t, h);
  for (let i = 0; i < 2000; i++) {
    const w = dayWindow(localDate(cur, h.tz), h)!;
    const avail = w[1] - cur;
    if (remaining <= avail) return cur + remaining;
    remaining -= avail;
    cur = nextOpen(w[1], h);
  }
  throw new Error('business-minute addition did not converge');
}

/** Staffed minutes elapsed between a and b (0 if b ≤ a). */
export function businessMinutesBetween(a: number, b: number, h: Hours): number {
  if (b <= a) return 0;
  let total = 0;
  let date = localDate(a, h.tz);
  const endDate = localDate(b, h.tz);
  for (let i = 0; i < 2000; i++) {
    const w = dayWindow(date, h);
    if (w) total += Math.max(0, Math.min(w[1], b) - Math.max(w[0], a));
    if (date === endDate) break;
    date = addDays(date, 1).s;
  }
  return Math.round(total / MINUTE);
}

export function businessDayMinutes(h: Hours): number {
  return h.endMin - h.startMin;
}

/** Number of staffed days whose start lies in (a, b]. */
export function staffedDayStartsBetween(a: number, b: number, h: Hours): number {
  let n = 0;
  let date = localDate(a, h.tz);
  for (let i = 0; i < 2000; i++) {
    const w = dayWindow(date, h);
    if (w && w[0] > a && w[0] <= b) n++;
    if (w && w[0] > b) break;
    if (date === localDate(b, h.tz)) break;
    date = addDays(date, 1).s;
  }
  return n;
}
