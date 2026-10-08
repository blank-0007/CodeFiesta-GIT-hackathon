import type { ApiErrorBody } from "./types";
import { useUiStore } from "@/lib/store";

/** Base URL of the FastAPI backend; empty = same origin (MSW intercepts /api/*). */
export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "";

/** Absolute base — same-origin when no backend URL is configured (also needed under Node/jsdom). */
const base = () => API_BASE_URL || (typeof window !== "undefined" ? window.location.origin : "");

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: ApiErrorBody | null,
  ) {
    super(body?.detail ?? body?.error ?? `Request failed (${status})`);
    this.name = "ApiError";
  }
}

type Json = Record<string, unknown> | unknown[];

export async function request<T>(method: string, path: string, body?: Json | FormData, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", "X-Demo-Role": useUiStore.getState().role };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base()}/api${path}`, { method, headers, body: payload, ...init });
  if (!res.ok) {
    let parsed: ApiErrorBody | null = null;
    try {
      parsed = (await res.json()) as ApiErrorBody;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(res.status, parsed);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const get = <T>(path: string) => request<T>("GET", path);
export const post = <T>(path: string, body?: Json | FormData) => request<T>("POST", path, body);
export const put = <T>(path: string, body?: Json) => request<T>("PUT", path, body);

/**
 * Consume a text/event-stream over fetch (works with MSW and with FastAPI's
 * StreamingResponse). Returns an abort function.
 */
export function streamEvents(path: string, onEvent: (event: string, data: unknown) => void, onError?: (e: unknown) => void): () => void {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${base()}/api${path}`, { headers: { Accept: "text/event-stream" }, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new ApiError(res.status, null);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message";
          let data = "";
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          try {
            onEvent(event, data ? JSON.parse(data) : null);
          } catch {
            onEvent(event, data);
          }
        }
      }
    } catch (e) {
      if (!ctrl.signal.aborted) onError?.(e);
    }
  })();
  return () => ctrl.abort();
}
