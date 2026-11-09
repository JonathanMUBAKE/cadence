export interface Limits {
  anonymousPerMinute: number;
  sessionPerMinute: number;
  aiPerMinute: number;
  invitationsPerHour: number;
  ssePerUser: number;
  aiRunsPerHour: number;
}
export const DEFAULT_LIMITS: Limits = {
  anonymousPerMinute: 300,
  sessionPerMinute: 600,
  aiPerMinute: 20,
  invitationsPerHour: 50,
  ssePerUser: 10,
  aiRunsPerHour: 300,
};
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
const MAX_KEYS = 50_000;

/** Compteurs par fenêtre de temps, en mémoire : ils valent pour un serveur à la fois. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();

  allow(key: string, max: number, windowMs: number, now = Date.now()) {
    const hit = this.hits.get(key);
    if (hit && hit.reset > now) return ++hit.n <= max;
    if (this.hits.size >= MAX_KEYS) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    this.hits.set(key, { n: 1, reset: now + windowMs });
    return max >= 1;
  }
}
