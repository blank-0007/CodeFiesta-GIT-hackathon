import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { SortingState, VisibilityState } from "@tanstack/react-table";

/** A single string param persisted in the URL (replace, not push). */
export function useUrlParam(key: string, fallback = ""): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) ?? fallback;
  const set = useCallback(
    (v: string) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (!v || v === fallback) next.delete(key);
          else next.set(key, v);
          return next;
        },
        { replace: true },
      ),
    [key, fallback, setParams],
  );
  return [value, set];
}

/** Multi-value param stored comma-separated: ?category=duplicate,timing */
export function useUrlList(key: string): [string[], (v: string[]) => void] {
  const [raw, setRaw] = useUrlParam(key);
  const list = useMemo(() => (raw ? raw.split(",").filter(Boolean) : []), [raw]);
  const set = useCallback((v: string[]) => setRaw(v.join(",")), [setRaw]);
  return [list, set];
}

/** Numeric range param stored as "min~max". */
export function useUrlRange(key: string, min: number, max: number): [[number, number], (v: [number, number]) => void] {
  const [raw, setRaw] = useUrlParam(key);
  const value = useMemo<[number, number]>(() => {
    if (!raw) return [min, max];
    const [a, b] = raw.split("~").map(Number);
    return [Number.isFinite(a) ? a : min, Number.isFinite(b) ? b : max];
  }, [raw, min, max]);
  const set = useCallback(
    (v: [number, number]) => setRaw(v[0] === min && v[1] === max ? "" : `${v[0]}~${v[1]}`),
    [setRaw, min, max],
  );
  return [value, set];
}

/** Sorting + column visibility for a table, persisted under a key prefix. */
export function useTableUrlState(prefix: string, defaultSort: SortingState = []) {
  const [sortRaw, setSortRaw] = useUrlParam(`${prefix}sort`);
  const [hideRaw, setHideRaw] = useUrlParam(`${prefix}hide`);

  const sorting = useMemo<SortingState>(() => {
    if (!sortRaw) return defaultSort;
    return sortRaw.split(",").map((s) => {
      const [id, dir] = s.split(":");
      return { id, desc: dir === "desc" };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortRaw]);

  const columnVisibility = useMemo<VisibilityState>(() => {
    const v: VisibilityState = {};
    hideRaw.split(",").filter(Boolean).forEach((id) => (v[id] = false));
    return v;
  }, [hideRaw]);

  const setSorting = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      setSortRaw(next.map((s) => `${s.id}:${s.desc ? "desc" : "asc"}`).join(","));
    },
    [sorting, setSortRaw],
  );

  const setColumnVisibility = useCallback(
    (updater: VisibilityState | ((old: VisibilityState) => VisibilityState)) => {
      const next = typeof updater === "function" ? updater(columnVisibility) : updater;
      setHideRaw(
        Object.entries(next)
          .filter(([, visible]) => !visible)
          .map(([id]) => id)
          .join(","),
      );
    },
    [columnVisibility, setHideRaw],
  );

  return { sorting, setSorting, columnVisibility, setColumnVisibility };
}
