import { describe, expect, test } from "bun:test";
import { awaitControlled } from "./queryControl.ts";
import { DbError } from "../shared.ts";

function pendingQuery<T>() {
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((_, rejectPromise) => { reject = rejectPromise; });
  let cancelled = false;
  return {
    query: {
      then: promise.then.bind(promise),
      cancel: () => { cancelled = true; reject(new Error("driver cancelled")); },
    },
    cancelled: () => cancelled,
  };
}

describe("query cancellation", () => {
  test("cancels a driver query when the request aborts", async () => {
    const controller = new AbortController();
    const pending = pendingQuery<never>();
    const result = awaitControlled(pending.query, controller.signal, 1000);
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "cancelled" });
    expect(pending.cancelled()).toBe(true);
  });

  test("turns the driver cancellation into a timeout error", async () => {
    const pending = pendingQuery<never>();
    await expect(awaitControlled(pending.query, undefined, 1))
      .rejects.toBeInstanceOf(DbError);
    expect(pending.cancelled()).toBe(true);
  });
});
