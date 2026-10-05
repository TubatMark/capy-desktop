import { describe, expect, it } from "vitest";
import { isLocalRequest } from "../server/local-guard";

describe("isLocalRequest", () => {
  it("allows this computer's own addresses on any port", () => {
    for (const host of ["localhost:3000", "127.0.0.1:54277", "[::1]:3000", "localhost"]) expect(isLocalRequest({ host, method: "GET" })).toBe(true);
  });
  it("refuses other host names (DNS rebinding) and LAN addresses", () => {
    expect(isLocalRequest({ host: "evil.example:3000", method: "GET" })).toBe(false);
    expect(isLocalRequest({ host: "192.168.1.5:3000", method: "GET" })).toBe(false);
    expect(isLocalRequest({ host: undefined, method: "GET" })).toBe(false);
  });
  it("refuses changes coming from another site's page", () => {
    expect(isLocalRequest({ host: "localhost:3000", origin: "https://evil.example", method: "POST" })).toBe(false);
    expect(isLocalRequest({ host: "localhost:3000", origin: "http://localhost:3000", method: "POST" })).toBe(true);
    expect(isLocalRequest({ host: "localhost:3000", origin: "null", method: "PUT" })).toBe(false);
    expect(isLocalRequest({ host: "localhost:3000", method: "DELETE" })).toBe(true); // same-origin fetches may omit Origin
  });
  it("allows extra hosts named in CAPY_ALLOWED_HOSTS", () => {
    expect(isLocalRequest({ host: "my-mac.local:3000", method: "GET", allowed: "my-mac.local" })).toBe(true);
  });
});
