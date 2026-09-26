"use client";
import { usePathname } from "next/navigation";

/**
 * Page backdrop: warm gradient glow, a soft box grid, and sticker doodles in the corners
 * drawn like the capy logo (thick ink outline + hard offset shadow). Purely decorative.
 * Stickers only on the home page: the editor pages use the full width and text would sit on them.
 */
export function Backdrop() {
  const stickers = usePathname() === "/";
  return (
    <div aria-hidden className="backdrop pointer-events-none fixed inset-0 -z-10 select-none overflow-hidden">
      <div className="backdrop-blob backdrop-blob-a" />
      <div className="backdrop-blob backdrop-blob-b" />
      <div className="backdrop-blob backdrop-blob-c" />
      <div className="backdrop-grid absolute inset-0" />

      {stickers && (
        <div className="backdrop-stickers">
          {/* top left, below the header */}
          <div className="absolute left-0 top-14 size-[320px] origin-top-left max-md:scale-[.55]">
            <Squiggle className="absolute -left-[70px] top-2 w-[300px] -rotate-6" />
            <Plus className="absolute left-[92px] top-[38px] w-9" />
            <Zigzags className="absolute -left-3.5 top-[176px] w-[128px]" />
          </div>
          {/* top right */}
          <div className="absolute right-0 top-14 size-[340px] origin-top-right max-md:scale-[.55]">
            <div className="sticker-sun absolute -right-[90px] -top-[130px] size-[260px] rounded-full" />
            <Cloud className="absolute right-8 top-10 w-[170px]" />
            <Dashes className="absolute right-[228px] top-2 w-12" />
          </div>
          {/* bottom corners: skipped on phones, content covers the whole width */}
          {/* bottom left */}
          <div className="absolute bottom-0 left-0 size-[340px] origin-bottom-left max-md:hidden">
            <div className="sticker-sun absolute -bottom-[110px] -left-[100px] size-[280px] rounded-full" />
            <Cloud className="absolute bottom-9 left-9 w-[190px]" />
            <Play className="absolute bottom-[190px] left-[150px] w-14 rotate-6" />
          </div>
          {/* bottom right */}
          <div className="absolute bottom-0 right-0 size-[340px] origin-bottom-right max-md:hidden">
            <Squiggle className="absolute -right-[80px] bottom-5 w-[300px] rotate-[174deg]" />
            <Plus className="absolute bottom-[58px] right-[112px] w-9" />
            <Zigzags className="absolute -right-3.5 bottom-[176px] w-[128px]" />
          </div>
        </div>
      )}
    </div>
  );
}

const ink = "var(--ink)";

function Squiggle({ className }: { className?: string }) {
  const d = "M14 96 C 58 26, 104 142, 156 80 S 250 18, 292 58";
  return (
    <svg viewBox="0 0 306 130" className={"sticker " + (className ?? "")} fill="none" strokeLinecap="round">
      <path d={d} stroke={ink} strokeWidth={40} />
      <path d={d} stroke="var(--sticker-orange)" strokeWidth={28} />
    </svg>
  );
}

function Zigzags({ className }: { className?: string }) {
  const zig = (y: number) => `M6 ${y + 26} L34 ${y} L62 ${y + 26} L90 ${y} L118 ${y + 26}`;
  return (
    <svg viewBox="0 0 124 110" className={"sticker " + (className ?? "")} fill="none" strokeLinejoin="miter" strokeLinecap="square">
      {[10, 64].map((y) => (
        <g key={y}>
          <path d={zig(y)} stroke={ink} strokeWidth={20} />
          <path d={zig(y)} stroke="var(--sticker-yellow)" strokeWidth={10} />
        </g>
      ))}
    </svg>
  );
}

function Cloud({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 172 88" className={"sticker " + (className ?? "")}>
      <path
        d="M24 78 C 6 78, 4 54, 24 52 C 22 28, 50 20, 64 34 C 72 8, 114 6, 120 36 C 140 28, 160 44, 152 62 C 166 64, 166 78, 152 78 Z"
        fill="var(--sticker-cream)"
        stroke={ink}
        strokeWidth={5}
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Plus({ className }: { className?: string }) {
  const d = "M20 5 V35 M5 20 H35";
  return (
    <svg viewBox="0 0 40 40" className={"sticker " + (className ?? "")} fill="none" strokeLinecap="round">
      <path d={d} stroke={ink} strokeWidth={12} />
      <path d={d} stroke="var(--sticker-yellow)" strokeWidth={5} />
    </svg>
  );
}

function Play({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={"sticker " + (className ?? "")}>
      <path d="M18 10 L54 32 L18 54 Z" fill="var(--sticker-orange)" stroke={ink} strokeWidth={6} strokeLinejoin="round" />
    </svg>
  );
}

/** The three "!" strokes next to the capy in the logo. */
function Dashes({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} fill="none" stroke={ink} strokeWidth={6} strokeLinecap="round">
      <path d="M8 6 L16 18" />
      <path d="M26 4 L26 18" />
      <path d="M42 10 L34 20" />
    </svg>
  );
}
