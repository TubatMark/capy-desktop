/** capy wordmark from the asset pack (ink on cream). */
export function Wordmark({ className = "h-7" }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/capy-wordmark-dark.png" alt="capy" className={`${className} w-auto`} />;
}

/** Head mark. */
export function Mark({ className = "size-8" }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/capy-mark.png" alt="" className={className} />;
}

/** Full logo for the home hero. */
export function HeroLogo({ className = "h-44" }: { className?: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/capy-logo.png" alt="capy" className={`${className} mx-auto w-auto`} />;
}
