import { mock } from "bun:test";

class MockLog {
  write() {}
  flush() {}
}
mock.module("../../engine/log", () => ({
  log: new MockLog(),
}));

mock.module("../../engine/logger", () => ({
  Logger: class {
    private _observer: ((entry: Record<string, unknown>) => void) | null = null;

    private _append(entry: Record<string, unknown>) {
      this._observer?.({ ts: Date.now(), ...entry });
    }

    setEntryObserver(fn: ((entry: Record<string, unknown>) => void) | null) {
      this._observer = fn;
    }

    setSnapshotProvider() {}
    setMarketResultProvider() {}
    setTickerProvider() {}

    startSlot(
      slug: string,
      startTime: number,
      endTime: number,
      strategy: string,
    ) {
      this._append({
        type: "slot",
        action: "start",
        slug,
        startTime,
        endTime,
        strategy,
      });
    }
    endSlot(slug: string) {
      this._append({ type: "slot", action: "end", slug });
      return "";
    }
    destroy() {}
    log(entry: Record<string, unknown>) {
      this._append(entry);
    }
    snapshot() {}
  },
}));
