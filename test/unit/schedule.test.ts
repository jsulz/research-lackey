import { describe, expect, it } from "vitest";
import type { Schedule } from "../../src/core/ports";
import { slotAt } from "../../src/core/schedule";

// 2026-11-16 is a Monday. Expected slots are worked by hand from the spec's rule: the most
// recent scheduled time at or before the tick. Every-N-hours slots are anchored at the Unix
// epoch (1970-01-01T00:00Z, a Thursday).

type Row = [tick: string, slot: string];

function check(schedule: Schedule, rows: Row[]) {
  it.each(rows)("tick %s -> slot %s", (tick, slot) => {
    expect(slotAt(schedule, new Date(tick)).toISOString()).toBe(new Date(slot).toISOString());
  });
}

describe("slotAt, every N hours", () => {
  describe("N = 6 (00, 06, 12, 18 UTC)", () => {
    check({ kind: "every_n_hours", interval_hours: 6 }, [
      ["2026-11-16T11:59:59.999Z", "2026-11-16T06:00:00Z"],
      ["2026-11-16T12:00:00.000Z", "2026-11-16T12:00:00Z"],
      ["2026-11-16T12:15:00.000Z", "2026-11-16T12:00:00Z"],
      ["2026-11-16T00:05:00.000Z", "2026-11-16T00:00:00Z"],
    ]);
  });

  describe("N = 1", () => {
    check({ kind: "every_n_hours", interval_hours: 1 }, [
      ["2026-11-16T11:59:59.999Z", "2026-11-16T11:00:00Z"],
      ["2026-11-16T12:00:00.000Z", "2026-11-16T12:00:00Z"],
      ["2026-11-16T12:15:00.000Z", "2026-11-16T12:00:00Z"],
    ]);
  });

  describe("N = 5 (does not divide 24, so slots drift across days)", () => {
    check({ kind: "every_n_hours", interval_hours: 5 }, [
      ["2026-11-16T07:59:59.999Z", "2026-11-16T03:00:00Z"],
      ["2026-11-16T08:00:00.000Z", "2026-11-16T08:00:00Z"],
      ["2026-11-16T12:15:00.000Z", "2026-11-16T08:00:00Z"],
      ["2026-11-16T00:10:00.000Z", "2026-11-15T22:00:00Z"],
    ]);
  });

  describe("N = 48 (every other day at 00:00)", () => {
    check({ kind: "every_n_hours", interval_hours: 48 }, [
      ["2026-11-16T12:15:00.000Z", "2026-11-15T00:00:00Z"],
      ["2026-11-16T23:59:59.999Z", "2026-11-15T00:00:00Z"],
      ["2026-11-17T00:00:00.000Z", "2026-11-17T00:00:00Z"],
    ]);
  });

  describe("N = 168 (Thursdays at 00:00)", () => {
    check({ kind: "every_n_hours", interval_hours: 168 }, [
      ["2026-11-16T12:15:00.000Z", "2026-11-12T00:00:00Z"],
      ["2026-11-18T23:59:59.999Z", "2026-11-12T00:00:00Z"],
      ["2026-11-19T00:00:00.000Z", "2026-11-19T00:00:00Z"],
    ]);
  });
});

describe("slotAt, daily", () => {
  describe("12:00", () => {
    check({ kind: "daily", time_utc: "12:00" }, [
      ["2026-11-16T11:59:59.999Z", "2026-11-15T12:00:00Z"],
      ["2026-11-16T12:00:00.000Z", "2026-11-16T12:00:00Z"],
      ["2026-11-16T12:15:00.000Z", "2026-11-16T12:00:00Z"],
    ]);
  });

  describe("23:30, across the day rollover", () => {
    check({ kind: "daily", time_utc: "23:30" }, [
      ["2026-11-16T00:10:00.000Z", "2026-11-15T23:30:00Z"],
      ["2026-11-16T23:29:59.999Z", "2026-11-15T23:30:00Z"],
      ["2026-11-16T23:30:00.000Z", "2026-11-16T23:30:00Z"],
    ]);
  });

  describe("00:00, across a month rollover", () => {
    check({ kind: "daily", time_utc: "00:00" }, [
      ["2026-11-30T23:59:59.999Z", "2026-11-30T00:00:00Z"],
      ["2026-12-01T00:00:00.000Z", "2026-12-01T00:00:00Z"],
    ]);
  });
});

describe("slotAt, weekly", () => {
  describe("Monday 12:00", () => {
    check({ kind: "weekly", weekday: 1, time_utc: "12:00" }, [
      ["2026-11-16T11:59:59.999Z", "2026-11-09T12:00:00Z"],
      ["2026-11-16T12:00:00.000Z", "2026-11-16T12:00:00Z"],
      ["2026-11-16T12:15:00.000Z", "2026-11-16T12:00:00Z"],
      ["2026-11-22T23:59:59.999Z", "2026-11-16T12:00:00Z"],
    ]);
  });

  describe("Sunday 23:00, across the week rollover", () => {
    check({ kind: "weekly", weekday: 0, time_utc: "23:00" }, [
      ["2026-11-16T00:05:00.000Z", "2026-11-15T23:00:00Z"],
      ["2026-11-15T22:59:59.999Z", "2026-11-08T23:00:00Z"],
      ["2026-11-15T23:00:00.000Z", "2026-11-15T23:00:00Z"],
    ]);
  });

  describe("Saturday 09:00, ticked on a Monday", () => {
    check({ kind: "weekly", weekday: 6, time_utc: "09:00" }, [
      ["2026-11-16T12:15:00.000Z", "2026-11-14T09:00:00Z"],
    ]);
  });
});
