"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** Header link that marks itself current. `/` only matches the library and video pages. */
export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const path = usePathname();
  const active = href === "/" ? path === "/" || path.startsWith("/v/") : path.startsWith(href);
  return (
    <Link href={href} aria-current={active ? "page" : undefined} className={cn("hover:text-foreground", active && "text-foreground")}>
      {children}
    </Link>
  );
}
