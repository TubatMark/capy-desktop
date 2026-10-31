"use client";
import { useEffect, useRef } from "react";

/**
 * Runs `fn` straight away and then every `ms`, but only while the window can be seen: a hidden window does no polling,
 * and coming back refreshes at once.
 */
export function useVisibleInterval(fn: () => unknown, ms: number) {
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const run = () => void latest.current();
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      if (!document.hidden) timer = setInterval(run, ms);
    };
    const onChange = () => {
      if (document.hidden) return stop();
      run();
      start();
    };
    run();
    start();
    document.addEventListener("visibilitychange", onChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onChange);
    };
  }, [ms]);
}
