"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import * as Tooltip from "@radix-ui/react-tooltip";
import { BookOpen, CalendarClock, Clapperboard, ListChecks, Menu, MonitorPlay, PanelLeftClose, PanelLeftOpen, Radar, Settings, X } from "lucide-react";
import { Mark, Wordmark } from "@/components/logo";
import { useQueueSummary } from "@/hooks/use-queue";
import { cn } from "@/lib/utils";

const KEY = "capy.sidebar";

/** Runs before first paint (see app/layout.tsx) so a collapsed sidebar never flashes open. */
export const SIDEBAR_BOOT = `try{if(localStorage.getItem("${KEY}")==="collapsed")document.documentElement.dataset.sidebar="collapsed"}catch(e){}`;

const isCollapsed = () => document.documentElement.dataset.sidebar === "collapsed";

interface Item {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Pages under this item that also mark it current. */
  also?: (path: string) => boolean;
}

const MAIN: Item[] = [
  { href: "/todo", label: "To do", icon: ListChecks },
  { href: "/", label: "Library", icon: Clapperboard, also: (p) => p.startsWith("/v/") },
  { href: "/stories", label: "Stories", icon: BookOpen },
  { href: "/automation", label: "Automation", icon: Radar },
  { href: "/queue", label: "Queue", icon: CalendarClock },
  { href: "/channel", label: "Channel", icon: MonitorPlay },
];
const SETTINGS: Item = { href: "/settings", label: "Settings", icon: Settings };

const isActive = (item: Item, path: string) => (item.href === "/" ? path === "/" : path.startsWith(item.href)) || !!item.also?.(path);

/** Collapsed state lives on <html data-sidebar> (CSS sizes everything from it) and in localStorage. */
function useCollapsed() {
  const [collapsed, set] = useState(false);
  useEffect(() => set(isCollapsed()), []);
  const toggle = useCallback(() => {
    const next = !isCollapsed();
    if (next) document.documentElement.dataset.sidebar = "collapsed";
    else delete document.documentElement.dataset.sidebar;
    try {
      localStorage.setItem(KEY, next ? "collapsed" : "open");
    } catch {
      /* private mode */
    }
    set(next);
  }, []);
  // ⌘B / Ctrl+B, the usual sidebar shortcut (not while typing in a field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "b" || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);
  return { collapsed, toggle };
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The app's navigation: a sidebar that folds to an icon rail on wide screens, a top bar with a drawer on narrow ones. */
export function AppSidebar() {
  const path = usePathname();
  const { collapsed, toggle } = useCollapsed();
  const summary = useQueueSummary();
  const [drawer, setDrawer] = useState(false);
  const [shortcut, setShortcut] = useState("Ctrl B");
  useEffect(() => setShortcut(isMac() ? "⌘B" : "Ctrl B"), []);
  useEffect(() => setDrawer(false), [path]);

  const counts: Record<string, number | undefined> = { "/todo": summary?.todo || undefined, "/queue": summary?.review || undefined, "/automation": summary?.watching || undefined };

  return (
    <Tooltip.Provider delayDuration={300} skipDelayDuration={0}>
      {/* wide screens */}
      <aside className="sidebar fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-border/70 bg-[var(--sidebar)] md:flex" aria-label="Main">
        <div className="sidebar-top flex h-14 shrink-0 items-center px-4">
          <Link href="/" className="no-drag flex min-w-0 items-center gap-2.5 rounded-md outline-offset-4" aria-label="capy home">
            <Mark className="size-8 shrink-0" />
            <Wordmark className="sb-word h-6" />
          </Link>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-2">
          {MAIN.map((item) => (
            <NavItem key={item.href} item={item} active={isActive(item, path)} count={counts[item.href]} urgent={item.href === "/queue" || item.href === "/todo"} collapsed={collapsed} />
          ))}
        </nav>
        <div className="flex flex-col gap-1 border-t border-border/60 px-3 py-3">
          <NavItem item={SETTINGS} active={isActive(SETTINGS, path)} collapsed={collapsed} />
          <Tip show={collapsed} label="Expand sidebar" hint={shortcut}>
            <button type="button" onClick={toggle} className="sb-item no-drag text-muted-foreground" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-keyshortcuts="Meta+B Control+B">
              {collapsed ? <PanelLeftOpen className="size-[18px] shrink-0" /> : <PanelLeftClose className="size-[18px] shrink-0" />}
              <span className="sb-label flex-1 text-left">Collapse</span>
              <kbd className="sb-hint font-sans text-[11px] text-muted-foreground/80">{shortcut}</kbd>
            </button>
          </Tip>
        </div>
      </aside>

      {/* narrow screens */}
      <Dialog.Root open={drawer} onOpenChange={setDrawer}>
        <header className="mobile-bar sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-border/60 bg-background/90 px-3 backdrop-blur md:hidden">
          <Dialog.Trigger asChild>
            <button type="button" className="no-drag grid size-10 place-items-center rounded-md text-foreground hover:bg-accent" aria-label="Open menu">
              <Menu className="size-5" />
            </button>
          </Dialog.Trigger>
          <Link href="/" className="no-drag flex items-center gap-2" aria-label="capy home">
            <Mark className="size-7" />
            <Wordmark className="h-6" />
          </Link>
          <Link href="/queue" className="no-drag relative ml-auto grid size-10 place-items-center rounded-md text-muted-foreground hover:bg-accent" aria-label={summary?.review ? `Queue: ${summary.review} waiting for your OK` : "Queue"}>
            <CalendarClock className="size-5" />
            {!!summary?.review && <Count n={summary.review} urgent dot />}
          </Link>
        </header>
        <Dialog.Portal>
          <Dialog.Overlay className="drawer-overlay fixed inset-0 z-50 bg-black/30 md:hidden" />
          <Dialog.Content className="drawer fixed inset-y-0 left-0 z-50 flex w-[min(17rem,85vw)] flex-col border-r border-border/70 bg-[var(--sidebar)] shadow-[8px_0_32px_-12px_oklch(0.24_0.03_45_/_35%)] outline-none md:hidden">
            <div className="flex h-14 items-center justify-between px-4">
              <Dialog.Title className="flex items-center gap-2.5">
                <Mark className="size-8" />
                <Wordmark className="h-6" />
              </Dialog.Title>
              <Dialog.Close className="grid size-9 place-items-center rounded-md text-muted-foreground hover:bg-accent" aria-label="Close menu">
                <X className="size-5" />
              </Dialog.Close>
            </div>
            <Dialog.Description className="sr-only">Go to another part of capy</Dialog.Description>
            <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
              {MAIN.map((item) => (
                <NavItem key={item.href} item={item} active={isActive(item, path)} count={counts[item.href]} urgent={item.href === "/queue" || item.href === "/todo"} collapsed={false} />
              ))}
            </nav>
            <div className="border-t border-border/60 px-3 py-3">
              <NavItem item={SETTINGS} active={isActive(SETTINGS, path)} collapsed={false} />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Tooltip.Provider>
  );
}

function NavItem({ item, active, count, urgent, collapsed }: { item: Item; active: boolean; count?: number; urgent?: boolean; collapsed: boolean }) {
  const Icon = item.icon;
  const hint = count ? (item.href === "/todo" ? `${count} to do` : urgent ? `${count} waiting for your OK` : `${count} watched`) : undefined;
  return (
    <Tip show={collapsed} label={item.label} hint={hint}>
      <Link href={item.href} aria-current={active ? "page" : undefined} className={cn("sb-item no-drag relative", active ? "sb-active" : "text-muted-foreground")}>
        <Icon className="sb-icon size-[18px] shrink-0" />
        <span className="sb-label flex-1 truncate">{item.label}</span>
        {count !== undefined && <Count n={count} urgent={urgent} dot={collapsed} />}
      </Link>
    </Tip>
  );
}

/** A count next to a nav item; on the folded rail it sits on the icon's corner. */
function Count({ n, urgent, dot }: { n: number; urgent?: boolean; dot?: boolean }) {
  return (
    <span
      className={cn(
        "grid min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-semibold leading-5 tabular-nums",
        urgent ? "bg-primary text-primary-foreground" : "bg-foreground/[0.07] text-muted-foreground",
        dot && "absolute right-0.5 top-0.5 min-w-4 px-1 text-[10px] leading-4",
        dot && !urgent && "hidden",
      )}
    >
      {n > 99 ? "99+" : n}
    </span>
  );
}

/** Tooltip only when the rail is folded (the labels are visible otherwise). */
function Tip({ show, label, hint, children }: { show: boolean; label: string; hint?: string; children: React.ReactElement }) {
  if (!show) return children;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content side="right" sideOffset={10} className="tip z-50 flex items-center gap-2 rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background shadow-[0_4px_16px_-4px_oklch(0.24_0.03_45_/_40%)]">
          {label}
          {hint && <span className="font-normal text-background/70">{hint}</span>}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
