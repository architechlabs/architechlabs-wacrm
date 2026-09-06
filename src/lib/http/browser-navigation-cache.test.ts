import { describe, expect, it, vi } from "vitest";
import { createCacheHeaderRules, PRIVATE_CACHE_CONTROL } from "./request-policy";

// Import the real application config without starting a local Worker proxy.
vi.mock("@opennextjs/cloudflare", () => ({ initOpenNextCloudflareForDev: vi.fn() }));
vi.mock("next-intl/plugin", () => ({ default: () => (config: unknown) => config }));
import nextConfig from "../../../next.config";

describe("browser-only navigation cache policy", () => {
  it("bounds visited page reuse to 30 seconds without enabling server caching", () => {
    expect(nextConfig.experimental?.staleTimes).toEqual({ dynamic: 30 });
    expect(nextConfig.cacheComponents).not.toBe(true);
  });

  it("preserves every existing HTTP cache rule, including private pages and APIs", async () => {
    const headers = await nextConfig.headers!();
    for (const rule of createCacheHeaderRules()) expect(headers).toContainEqual(rule);
    expect(PRIVATE_CACHE_CONTROL).toContain("no-store");
  });
});
