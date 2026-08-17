import { describe, expect, it } from "vitest";
import type { WatchRunSummary } from "@northcinder/watches";
import { watchRunExitCode } from "../src/watch-runner.js";

function summary(outcomes: Array<{ outcome: string; error?: { code: string; message: string } }>): WatchRunSummary {
  return {
    checkedAt: "2026-07-05T12:00:00.000Z",
    total: outcomes.length,
    reports: outcomes.map((o, i) => ({
      watchId: `watch_${i}`,
      name: `w${i}`,
      outcome: o.outcome as WatchRunSummary["reports"][number]["outcome"],
      ...(o.error !== undefined ? { error: o.error } : {}),
    })),
  };
}

describe("northcinder-watch --once exit code (cron must SEE a fully-failed tick)", () => {
  it("exits 1 when EVERY check failed (source_error / notify_failed)", () => {
    expect(
      watchRunExitCode(
        summary([
          { outcome: "source_error", error: { code: "service_unreachable", message: "down" } },
          { outcome: "notify_failed", error: { code: "ntfy_http_error", message: "HTTP 500" } },
        ]),
      ),
    ).toBe(1);
  });

  it("exits 0 when at least one check succeeded (partial failure is a normal, reported state)", () => {
    expect(
      watchRunExitCode(
        summary([
          { outcome: "source_error", error: { code: "service_unreachable", message: "down" } },
          { outcome: "above_target" },
        ]),
      ),
    ).toBe(0);
  });

  it("exits 0 on an all-healthy tick and on a tick with no active watches", () => {
    expect(watchRunExitCode(summary([{ outcome: "target_hit_notified" }, { outcome: "target_hit_deduped" }]))).toBe(0);
    expect(watchRunExitCode(summary([]))).toBe(0);
  });
});
