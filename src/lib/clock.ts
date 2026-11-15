export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock tests can move. Starts on Monday 2026-11-16 at 09:00 America/New_York. */
export class ManualClock implements Clock {
  constructor(private t = Date.UTC(2026, 10, 16, 14, 0, 0)) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
