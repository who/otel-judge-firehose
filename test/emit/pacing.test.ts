import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JudgePostResult } from "../../src/emit/judgeClient";
import {
  MAX_BURST,
  MAX_INTERVAL_MS,
  MAX_RUN_MS,
  pacedEmit,
  resolvePacing,
  type BurstSender,
  type Pacing,
} from "../../src/emit/pacing";
import { buildScenarioPackets } from "../../src/fixtures/registry";
import type { Packet } from "../../src/packet/schema";

function packets(count: number): Packet[] {
  return buildScenarioPackets("healthy", count, { seed: "pacing" });
}

interface SendCall {
  at: number;
  ids: string[];
}

/** Records the fake-clock time and packet ids of every burst; accepts everything. */
function recorder(): { send: BurstSender; calls: SendCall[] } {
  const calls: SendCall[] = [];
  const send: BurstSender = async (burst) => {
    calls.push({ at: Date.now(), ids: burst.map((packet) => packet.packet_id) });
    return burst.map(
      (packet): JudgePostResult => ({ packetId: packet.packet_id, accepted: true, status: 202, attempts: 1 }),
    );
  };
  return { send, calls };
}

function pacing(overrides: Partial<Pacing>): Pacing {
  return { intervalMs: 0, burst: 1, maxRunMs: MAX_RUN_MS, ...overrides };
}

describe("resolvePacing", () => {
  it("defaults to no interval and one burst of the full count", () => {
    expect(resolvePacing({ count: 7 })).toEqual({ intervalMs: 0, burst: 7, maxRunMs: MAX_RUN_MS });
    expect(resolvePacing({ count: 50 })).toEqual({ intervalMs: 0, burst: 50, maxRunMs: MAX_RUN_MS });
  });

  it("keeps explicit values inside the documented bounds", () => {
    expect(resolvePacing({ count: 20, intervalMs: 250, burst: 4 })).toMatchObject({ intervalMs: 250, burst: 4 });
    expect(resolvePacing({ count: 20, intervalMs: MAX_INTERVAL_MS + 1, burst: MAX_BURST + 5 })).toMatchObject({
      intervalMs: MAX_INTERVAL_MS,
      burst: MAX_BURST,
    });
    expect(resolvePacing({ count: 20, intervalMs: -5, burst: 0 })).toMatchObject({ intervalMs: 0, burst: 1 });
  });
});

describe("pacedEmit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("burst slicing", () => {
    it("splits packets into ceil(count / burst) bursts in order", async () => {
      const input = packets(7);
      const { send, calls } = recorder();

      const run = await pacedEmit(input, pacing({ burst: 3 }), send);

      expect(calls.map((call) => call.ids.length)).toEqual([3, 3, 1]);
      expect(calls.flatMap((call) => call.ids)).toEqual(input.map((packet) => packet.packet_id));
      expect(run.bursts).toBe(3);
      expect(run.results).toHaveLength(7);
      expect(run.truncated).toBe(false);
    });

    it("sends everything in one burst when the burst exceeds the count", async () => {
      const sleep = vi.fn(async () => {});
      const { send, calls } = recorder();

      const run = await pacedEmit(packets(4), pacing({ burst: 10, intervalMs: 500 }), send, { sleep });

      expect(calls).toHaveLength(1);
      expect(run.bursts).toBe(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(run.elapsedMs).toBe(0);
    });

    it("performs no request for an empty input", async () => {
      const { send, calls } = recorder();

      const run = await pacedEmit([], pacing({ burst: 2, intervalMs: 100 }), send);

      expect(calls).toHaveLength(0);
      expect(run).toEqual({ results: [], bursts: 0, truncated: false, elapsedMs: 0 });
    });
  });

  describe("interval spacing", () => {
    it("waits the interval between bursts and adds no trailing delay after the last", async () => {
      const { send, calls } = recorder();
      let settled = false;

      const pending = pacedEmit(packets(6), pacing({ burst: 2, intervalMs: 500 }), send).then((run) => {
        settled = true;
        return run;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(calls.map((call) => call.at)).toEqual([0]);

      await vi.advanceTimersByTimeAsync(499);
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(calls.map((call) => call.at)).toEqual([0, 500]);

      await vi.advanceTimersByTimeAsync(500);
      expect(calls.map((call) => call.at)).toEqual([0, 500, 1000]);
      expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      const run = await pending;
      expect(run.elapsedMs).toBe(1000);
      expect(run.truncated).toBe(false);
    });

    it("schedules no timer at all when the interval is zero", async () => {
      const sleep = vi.fn(async () => {});
      const { send, calls } = recorder();

      const run = await pacedEmit(packets(5), pacing({ burst: 2, intervalMs: 0 }), send, { sleep });

      expect(calls).toHaveLength(3);
      expect(sleep).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(run.elapsedMs).toBe(0);
    });
  });

  describe("wall-clock ceiling", () => {
    it("truncates the run once the next interval would cross the ceiling", async () => {
      const { send, calls } = recorder();

      const pending = pacedEmit(packets(30), pacing({ burst: 1, intervalMs: 2000 }), send);
      await vi.advanceTimersByTimeAsync(60000);
      const run = await pending;

      // Bursts at 0, 2000, ..., 20000 fit; the gap to 22000 would cross the ceiling.
      expect(calls).toHaveLength(11);
      expect(calls.at(-1)?.at).toBe(MAX_RUN_MS);
      expect(run.truncated).toBe(true);
      expect(run.bursts).toBe(11);
      expect(run.results).toHaveLength(11);
      expect(run.results.every((result) => result.accepted)).toBe(true);
      expect(run.elapsedMs).toBe(MAX_RUN_MS);
    });

    it("truncates when slow sends consume the budget even with a short interval", async () => {
      const calls: number[] = [];
      const send: BurstSender = async (burst) => {
        calls.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 9000));
        return burst.map((packet) => ({ packetId: packet.packet_id, accepted: true, attempts: 1 }));
      };

      const pending = pacedEmit(packets(5), pacing({ burst: 1, intervalMs: 100 }), send);
      await vi.advanceTimersByTimeAsync(60000);
      const run = await pending;

      // Bursts at 0, 9100, and 18200 each take 9000ms; at 27200 the next gap is past the ceiling.
      expect(calls).toEqual([0, 9100, 18200]);
      expect(run.truncated).toBe(true);
      expect(run.results).toHaveLength(3);
      expect(run.elapsedMs).toBe(27200);
    });

    it("does not truncate a run that exactly fits the ceiling", async () => {
      const { send, calls } = recorder();

      const pending = pacedEmit(packets(11), pacing({ burst: 1, intervalMs: 2000 }), send);
      await vi.advanceTimersByTimeAsync(60000);
      const run = await pending;

      expect(calls).toHaveLength(11);
      expect(run.truncated).toBe(false);
    });
  });

  describe("send failure", () => {
    it("stops after a rejected burst and reports that burst as failed results", async () => {
      const input = packets(6);
      let bursts = 0;
      const send: BurstSender = async (burst) => {
        bursts += 1;
        if (bursts === 2) {
          throw new Error("socket hang up");
        }
        return burst.map((packet) => ({ packetId: packet.packet_id, accepted: true, attempts: 1 }));
      };

      const run = await pacedEmit(input, pacing({ burst: 2 }), send);

      expect(bursts).toBe(2);
      expect(run.results).toHaveLength(4);
      expect(run.results.slice(0, 2).every((result) => result.accepted)).toBe(true);
      expect(run.results.slice(2)).toEqual([
        { packetId: input[2]?.packet_id, accepted: false, attempts: 0, error: "burst failed: socket hang up" },
        { packetId: input[3]?.packet_id, accepted: false, attempts: 0, error: "burst failed: socket hang up" },
      ]);
      expect(run.truncated).toBe(false);
    });
  });
});
