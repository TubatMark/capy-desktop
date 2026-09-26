/** The capy wordmark from the asset pack; swaps ink/cream with the theme. */
export function Wordmark({ className = "h-7" }: { className?: string }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/capy-wordmark-dark.png" alt="capy" className={`${className} w-auto dark:hidden`} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/capy-wordmark-light.png" alt="capy" className={`${className} hidden w-auto dark:block`} />
    </>
  );
}
