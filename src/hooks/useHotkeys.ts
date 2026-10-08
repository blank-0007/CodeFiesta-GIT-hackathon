import { useEffect, useRef } from "react";

export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.getAttribute("role") === "combobox";
}

/**
 * Keyboard shortcuts. Keys: "a", "shift+?", "mod+k", or two-key sequences "g d".
 * Single keys are ignored while typing in a form field; "mod+…" always fires.
 */
export function useHotkeys(map: HotkeyMap, enabled = true) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      if (mod) {
        const h = ref.current[`mod+${key}`];
        if (h) {
          e.preventDefault();
          h(e);
        }
        return;
      }
      if (isTyping(e.target) || e.altKey) return;
      // Ignore keys while a modal (other than the one registering) has focus in a dialog input
      if (pending) {
        const seq = ref.current[`${pending} ${key}`];
        pending = null;
        clearTimeout(timer);
        if (seq) {
          e.preventDefault();
          seq(e);
          return;
        }
      }
      if (Object.keys(ref.current).some((k) => k.startsWith(`${key} `))) {
        pending = key;
        timer = setTimeout(() => (pending = null), 900);
        return;
      }
      const h = ref.current[e.shiftKey && key === "?" ? "?" : key] ?? ref.current[e.key];
      if (h) {
        e.preventDefault();
        h(e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      clearTimeout(timer);
    };
  }, [enabled]);
}
