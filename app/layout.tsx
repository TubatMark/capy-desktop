import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { Backdrop } from "@/components/backdrop";
import { AppSidebar, SIDEBAR_BOOT } from "@/components/sidebar";

export const metadata: Metadata = {
  title: "capy",
  description: "YouTube → captioned shorts, picked by AI",
  icons: { icon: [{ url: "/favicon-32.png", sizes: "32x32" }, { url: "/icon-192.png", sizes: "192x192" }], apple: "/icon-192.png" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

/** Set by the Electron shell; the sidebar top then leaves room for the traffic lights and drags the window (globals.css). */
const isDesktop = process.env.CAPY_DESKTOP === "1";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // data-sidebar is set before paint by SIDEBAR_BOOT, so React must not fight it
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} data-desktop={isDesktop ? "" : undefined} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_BOOT }} />
      </head>
      <body className="min-h-screen overflow-x-hidden">
        <Backdrop />
        <AppSidebar />
        {/* desktop app: an invisible strip that drags the window, above the content (pages start below it) */}
        <div aria-hidden className="app-titlebar" />
        <div className="app-main">
          <main className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 sm:py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
