import { expect, it } from "vitest";
import { allow } from "../src/ratelimit.ts";

it("allows up to the limit inside the window, then refuses, then recovers", () => {
  const key = `k${Math.random()}`;
  const t0 = 1_000_000;
  expect([1, 2, 3].map((i) => allow(key, 3, 1000, t0 + i))).toEqual([true, true, true]);
  expect(allow(key, 3, 1000, t0 + 10)).toBe(false);
  expect(allow(key, 3, 1000, t0 + 2000)).toBe(true);
});
