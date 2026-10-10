import type { ExactUs, ProjectDocument } from "./types";
const gcd = (a: bigint, b: bigint): bigint => {
  while (b) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a < 0n ? -a : a;
};
function rational(numerator: bigint, denominator: bigint): ExactUs {
  if (denominator <= 0n) throw Error("Invalid exact-time denominator");
  const divisor = gcd(numerator, denominator);
  return {
    numerator: String(numerator / divisor),
    denominator: String(denominator / divisor),
  };
}
export const integerUs = (value: number): ExactUs =>
  rational(BigInt(value), 1n);
export function frameTimeUs(
  frames: number,
  doc: Pick<ProjectDocument, "fps">,
): ExactUs {
  if (!Number.isSafeInteger(frames))
    throw Error("Exact source clock requires integer project frames");
  return rational(
    BigInt(frames) * 1000000n * BigInt(doc.fps.denominator),
    BigInt(doc.fps.numerator),
  );
}
export function addUs(a: ExactUs, b: ExactUs): ExactUs {
  return rational(
    BigInt(a.numerator) * BigInt(b.denominator) +
      BigInt(b.numerator) * BigInt(a.denominator),
    BigInt(a.denominator) * BigInt(b.denominator),
  );
}
export function subtractUs(a: ExactUs, b: ExactUs): ExactUs {
  return addUs(a, { ...b, numerator: String(-BigInt(b.numerator)) });
}
export function compareUs(a: ExactUs, b: ExactUs): number {
  const delta =
    BigInt(a.numerator) * BigInt(b.denominator) -
    BigInt(b.numerator) * BigInt(a.denominator);
  return delta < 0n ? -1 : delta > 0n ? 1 : 0;
}
export function moduloUs(value: ExactUs, period: ExactUs): ExactUs {
  const numerator = BigInt(value.numerator) * BigInt(period.denominator),
    divisor = BigInt(period.numerator) * BigInt(value.denominator);
  if (divisor <= 0n) throw Error("Invalid source period");
  return rational(
    ((numerator % divisor) + divisor) % divisor,
    BigInt(value.denominator) * BigInt(period.denominator),
  );
}
export const numberUs = (value: ExactUs) =>
  Number(value.numerator) / Number(value.denominator);
export const floorUs = (value: ExactUs) =>
  Number(BigInt(value.numerator) / BigInt(value.denominator));
export const ceilUs = (value: ExactUs) =>
  Number(
    (BigInt(value.numerator) + BigInt(value.denominator) - 1n) /
      BigInt(value.denominator),
  );
export const minimumUs = (a: ExactUs, b: ExactUs) =>
  compareUs(a, b) <= 0 ? a : b;
export function validExactUs(value: unknown): value is ExactUs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = Object.keys(value);
  if (
    fields.length !== 2 ||
    !fields.includes("numerator") ||
    !fields.includes("denominator")
  )
    return false;
  const exact = value as ExactUs;
  return (
    typeof exact.numerator === "string" &&
    typeof exact.denominator === "string" &&
    /^(0|[1-9]\d{0,39})$/.test(exact.numerator) &&
    /^[1-9]\d{0,39}$/.test(exact.denominator)
  );
}

/** Scale exact clocks by a supported playback ratio, retaining fractional phase. */
export function scaleUs(value: ExactUs, factor: number): ExactUs {
  if (![0.5, 1, 2].includes(factor)) throw Error("Unsupported clock ratio");
  return rational(
    BigInt(value.numerator) * BigInt(factor === 2 ? 2 : 1),
    BigInt(value.denominator) * BigInt(factor === 0.5 ? 2 : 1),
  );
}
