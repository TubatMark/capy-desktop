/**
 * The app's API only answers this computer. capy runs on a fixed-ish localhost port, so a web page could
 * otherwise reach it through DNS rebinding (a foreign Host header) or a cross-site POST (a foreign Origin),
 * and approve or post clips. Extra hosts can be allowed with CAPY_ALLOWED_HOSTS (comma-separated).
 */
const LOCAL = ["localhost", "127.0.0.1", "[::1]", "::1"];

const hostname = (h: string) => (h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0]!).toLowerCase();

export function isLocalRequest(r: { host?: string | null; origin?: string | null; method: string; allowed?: string }): boolean {
  const ok = new Set([...LOCAL, ...(r.allowed ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)]);
  if (!r.host || !ok.has(hostname(r.host))) return false;
  if (r.method === "GET" || r.method === "HEAD" || r.origin === undefined || r.origin === null) return true;
  try {
    const o = new URL(r.origin);
    return ok.has(o.hostname.toLowerCase()) || ok.has(`[${o.hostname.toLowerCase()}]`);
  } catch {
    return false; // "null" (sandboxed iframes, file://) and garbage
  }
}
