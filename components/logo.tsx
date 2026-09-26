/**
 * The capy wordmark from the asset pack; swaps ink/cream with the theme.
 * `className` (size + visibility, e.g. "hidden h-7 sm:block") goes on one wrapper so a
 * caller's `sm:block` cannot un-hide the off-theme variant.
 */
export function Wordmark({ className = "h-7" }: { className?: string }) {
  return (
    <span className={`${className} shrink-0`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/capy-wordmark-dark.png" alt="capy" className="h-full w-auto dark:hidden" />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/capy-wordmark-light.png" alt="capy" className="hidden h-full w-auto dark:block" />
    </span>
  );
}
