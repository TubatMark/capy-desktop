/** Next.js calls this once per server start: begin posting queued clips. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startPoster } = await import("./server/poster");
  startPoster();
}
