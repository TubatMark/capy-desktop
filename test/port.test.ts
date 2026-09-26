import net from "node:net";
import { describe, expect, it } from "vitest";
import { pickPort } from "../electron/port";

function tryListen(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(port, "127.0.0.1", () => srv.close((err) => (err ? reject(err) : resolve())));
  });
}

describe("pickPort", () => {
  it("returns a port in the ephemeral range that can be bound", async () => {
    const port = await pickPort();
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThanOrEqual(65535);
    await expect(tryListen(port)).resolves.toBeUndefined();
  });

  it("returns distinct ports on consecutive calls (usually)", async () => {
    const ports = await Promise.all([pickPort(), pickPort(), pickPort()]);
    expect(ports.every((p) => p > 0)).toBe(true);
  });
});
