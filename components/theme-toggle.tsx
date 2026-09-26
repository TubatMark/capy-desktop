"use client";
import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

const KEY = "capy.theme";

/** Light/dark switch. The initial class is set by an inline script in layout.tsx to avoid a flash. */
export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(KEY, next ? "dark" : "light");
    } catch {
      /* ignore */
    }
  }
  return (
    <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} title={dark ? "Light theme" : "Dark theme"}>
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}

/** Runs before paint: applies the saved theme (default light). */
export const THEME_INIT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(KEY)});if(t==="dark")document.documentElement.classList.add("dark");}catch(e){}})();`;
