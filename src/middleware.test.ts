import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getUser() resolves to (a refreshed session ⇒ user,
//                      or null for the logged-out path).
// `refreshedCookies` — cookies Supabase writes via setAll() during getUser(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the middleware returns — including redirects.
let mockUser: { id: string } | null = null;
let mockAuthError: Error | null = null;
let mockAuthException: Error | null = null;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    },
  ) => ({
    auth: {
      // Mirrors real auth-js: an expired access token is transparently
      // refreshed inside getUser(), which rotates the refresh token and
      // pushes the new cookies through setAll() before resolving.
      getUser: async () => {
        if (mockAuthException) throw mockAuthException;
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser }, error: mockAuthError };
      },
    },
  }),
}));

// Imported after the mock is registered.
const { middleware } = await import("./middleware");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockUser = null;
  mockAuthError = null;
  mockAuthException = null;
  refreshedCookies = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

describe("middleware — refreshed auth cookies survive redirects", () => {
  it("carries the rotated token when redirecting a signed-in user off /login", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login"),
    );

    // Redirect to /dashboard…
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("carries the rotated token when redirecting an unauth user to /login", async () => {
    mockUser = null;
    // Even on the logged-out path getUser() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login?invite=abc123"),
    );

    expect(res.headers.get("location")).toContain("/join/abc123");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

describe("middleware — failed auth is controlled", () => {
  const SESSION_COOKIE = {
    name: "sb-test-auth-token",
    value: "stale-session",
  };

  it("redirects a missing session from a protected route", async () => {
    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.test/login");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("keeps an ordinary missing-session auth result quiet", async () => {
    mockAuthError = new Error("Auth session missing");

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("clears an expired or revoked session and redirects to login", async () => {
    mockAuthError = new Error("Invalid Refresh Token: Already Used");

    const req = new NextRequest("https://app.test/dashboard", {
      headers: { cookie: `${SESSION_COOKIE.name}=${SESSION_COOKIE.value}` },
    });
    const res = await middleware(req);

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.test/login");
    expect(res.cookies.get(SESSION_COOKIE.name)?.value).toBe("");
    expect(res.cookies.get(SESSION_COOKIE.name)?.maxAge).toBe(0);
  });

  it("turns a thrown refresh failure into a redirect instead of rejecting", async () => {
    const accessToken = "access-token-value-that-must-never-be-logged";
    const refreshToken = "refresh-token-value-that-must-never-be-logged";
    const cookieValue = "cookie-value-that-must-never-be-logged";
    const supabaseKey = "supabase-api-key-that-must-never-be-logged";
    mockAuthException = new TypeError(
      `refresh request failed; Authorization: Bearer ${accessToken}; ` +
      `refresh_token=${refreshToken}; cookie=${cookieValue}; api_key=${supabaseKey}`,
    );

    const req = new NextRequest("https://app.test/dashboard", {
      headers: { cookie: `${SESSION_COOKIE.name}=${SESSION_COOKIE.value}` },
    });
    const responsePromise = middleware(req);
    await expect(responsePromise).resolves.toBeInstanceOf(Response);
    const res = await responsePromise;

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.test/login");
    expect(res.cookies.get(SESSION_COOKIE.name)?.value).toBe("");

    expect(console.error).toHaveBeenCalledTimes(1);
    const [label, details] = vi.mocked(console.error).mock.calls[0];
    expect(label).toBe("[middleware] Supabase auth validation threw");
    expect(details).toEqual({
      errorName: "TypeError",
      errorType: "Error",
      message: expect.stringContaining("refresh request failed"),
      pathname: "/dashboard",
    });
    const serializedDetails = JSON.stringify(details);
    expect(serializedDetails).not.toContain(accessToken);
    expect(serializedDetails).not.toContain(refreshToken);
    expect(serializedDetails).not.toContain(cookieValue);
    expect(serializedDetails).not.toContain(supabaseKey);
  });

  it("does not redirect or share state between two valid session requests", async () => {
    mockUser = { id: "same-user" };

    const [sessionA, sessionB] = await Promise.all([
      middleware(new NextRequest("https://app.test/dashboard", {
        headers: { cookie: "sb-test-auth-token=session-a" },
      })),
      middleware(new NextRequest("https://app.test/dashboard", {
        headers: { cookie: "sb-test-auth-token=session-b" },
      })),
    ]);

    expect(sessionA.headers.get("location")).toBeNull();
    expect(sessionB.headers.get("location")).toBeNull();
  });

  it("returns 401 instead of throwing for an authenticated API auth error", async () => {
    mockAuthException = new TypeError("auth storage failed");

    const res = await middleware(
      new NextRequest("https://app.test/api/whatsapp/config"),
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
  });
});
