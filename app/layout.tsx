import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import Link from "next/link";
import "./globals.css";
import { Wordmark } from "@/components/logo";
import { Backdrop } from "@/components/backdrop";
import { Settings } from "lucide-react";
import { NavLink } from "@/components/nav-link";

export const metadata: Metadata = {
  title: "capy",
  description: "YouTube → captioned shorts, picked by AI",
  icons: { icon: [{ url: "/favicon-32.png", sizes: "32x32" }, { url: "/icon-192.png", sizes: "192x192" }], apple: "/icon-192.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen">
        <Backdrop />
        <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-6 px-6">
            <Link href="/" className="flex items-center gap-2.5" aria-label="capy home">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/capy-mark.png" alt="" className="size-8" />
              <Wordmark className="h-7" />
            </Link>
            {/* the logo is the library link; settings sits alone on the right as an icon */}
            <nav className="ml-auto flex items-center text-muted-foreground">
              <NavLink href="/settings" label="Settings" className="rounded-md p-2 hover:bg-accent">
                <Settings className="size-5" />
              </NavLink>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
