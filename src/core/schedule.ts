import type { Schedule } from "./ports";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * The Topic's most recent scheduled time at or before `tick`.
 *
 * Every-N-hours slots are anchored at the Unix epoch: slot = floor(tick / N hours) * N hours.
 * When N divides 24 this is 00:00 UTC plus multiples of N each day; N = 48 is every other
 * day at 00:00, and N = 168 is Thursdays at 00:00.
 */
export function slotAt(schedule: Schedule, tick: Date): Date {
  const t = tick.getTime();
  switch (schedule.kind) {
    case "every_n_hours": {
      const every = schedule.interval_hours * HOUR;
      return new Date(Math.floor(t / every) * every);
    }
    case "daily": {
      const slot = startOfDay(t) + minutesOf(schedule.time_utc) * MINUTE;
      return new Date(slot <= t ? slot : slot - DAY);
    }
    case "weekly": {
      const daysBack = (tick.getUTCDay() - schedule.weekday + 7) % 7;
      const slot = startOfDay(t) - daysBack * DAY + minutesOf(schedule.time_utc) * MINUTE;
      return new Date(slot <= t ? slot : slot - WEEK);
    }
  }
}

function startOfDay(t: number): number {
  return Math.floor(t / DAY) * DAY;
}

/** Minutes after midnight for `HH:MM`. */
function minutesOf(timeUtc: string): number {
  const [h, m] = timeUtc.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}
