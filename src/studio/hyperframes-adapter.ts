/** Adoption remains gated on measured preview/export and offline packaging evidence. */
export const hyperframesDecision = {
  status: "deferred",
  testedVersion: null,
  reason: "React edit round-trip, arbitrary seeking, parity and offline packaged Electron gates have not been executed.",
} as const;
export function requireHyperframesAdapter(): never {
  throw new Error("Hyperframes adapter unavailable: integration correctness and packaging gates remain unverified");
}
