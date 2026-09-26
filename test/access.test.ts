import { describe, expect, it } from "vitest";
import { FORBIDDEN, getAccess } from "../server/access";
import type { Access } from "../lib/types";

describe("getAccess", () => {
  it("returns the local owner with every capability", async () => {
    const a: Access = await getAccess();
    expect(a).toEqual({ user: { id: "local", name: "Local owner" }, plan: "local", can: { createJob: true, render: true } });
  });

  it("has the shape the UI and routes rely on", async () => {
    const a = await getAccess(new Request("http://localhost/api/me"));
    expect(typeof a.user.id).toBe("string");
    expect(typeof a.user.name).toBe("string");
    expect(["local", "free", "pro"]).toContain(a.plan);
    expect(Object.keys(a.can).sort()).toEqual(["createJob", "render"]);
    for (const v of Object.values(a.can)) expect(typeof v).toBe("boolean");
  });

  it("uses a stable 403 body", () => {
    expect(FORBIDDEN).toEqual({ error: "Sign in required", code: "forbidden" });
  });
});
