import { api } from "@/api/endpoints";
import { downloadBlob } from "@/lib/utils";
import type { Report } from "@/api/types";
import { toast } from "sonner";

export function saveReport(r: Report) {
  if (!r.content) return;
  if (r.format === "pdf") {
    const bin = atob(r.content);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    downloadBlob(bytes, r.name, "application/pdf");
  } else {
    downloadBlob(r.content, r.name, "text/csv;charset=utf-8");
  }
  toast.success("Download started", { description: r.name });
}

export async function downloadReport(id: string) {
  const r = await api.downloadReport(id);
  saveReport(r);
}
