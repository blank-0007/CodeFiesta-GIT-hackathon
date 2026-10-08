import { Controller, useFormContext } from "react-hook-form";
import { AlertTriangle, CheckCircle2, FileSpreadsheet } from "lucide-react";
import { CANONICAL_FIELDS, mappingErrors, type FileEntry, type WizardValues } from "./schema";
import { Label, RadioGroup, RadioGroupItem } from "@/components/ui/form-controls";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/menus";
import { InfoTip } from "@/components/shared/misc";

const NONE = "__none__";

export function MappingStep({ files, showErrors }: { files: FileEntry[]; showErrors: boolean }) {
  const { control, watch, setValue } = useFormContext<WizardValues>();
  const mappings = watch("mappings");
  const toMap = files.filter((f) => f.status === "needs_mapping");

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        We couldn't auto-detect the columns in {toMap.length === 1 ? "this file" : "these files"}. Map each source column to a canonical field — sample values are shown to help.
      </p>

      {toMap.map((f) => {
        const m = mappings[f.localId] ?? {};
        const errs = mappingErrors(m);
        const cols = f.result?.columns ?? [];
        const sample = (col: string) =>
          (f.result?.previewRows ?? [])
            .slice(0, 3)
            .map((r) => r[col])
            .filter(Boolean);
        return (
          <section key={f.localId} className="card" aria-labelledby={`map-${f.localId}`}>
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <FileSpreadsheet className="h-4 w-4 text-muted-foreground" aria-hidden />
              <h2 id={`map-${f.localId}`} className="text-sm font-semibold">{f.file.name}</h2>
              <span className="text-2xs text-muted-foreground">{f.result?.detectedFormat}</span>
              <span className="ml-auto">
                {errs.length ? (
                  <span className="flex items-center gap-1 text-xs text-warn"><AlertTriangle className="h-3.5 w-3.5" /> Incomplete</span>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-ok"><CheckCircle2 className="h-3.5 w-3.5" /> Ready</span>
                )}
              </span>
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-2xs uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="px-4 py-2 font-semibold">Canonical field</th>
                  <th scope="col" className="px-4 py-2 font-semibold">Source column</th>
                  <th scope="col" className="hidden px-4 py-2 font-semibold md:table-cell">Sample values</th>
                </tr>
              </thead>
              <tbody>
                {CANONICAL_FIELDS.map((field) => {
                  const selected = m[field.id] || "";
                  const id = `${f.localId}-${field.id}`;
                  return (
                    <tr key={field.id} className="border-t">
                      <td className="px-4 py-2">
                        <Label htmlFor={id} className="text-sm">
                          {field.label} {field.required && <span className="text-crit">*</span>}
                        </Label>
                      </td>
                      <td className="px-4 py-2">
                        <Select
                          value={selected || NONE}
                          onValueChange={(v) => setValue(`mappings.${f.localId}`, { ...m, [field.id]: v === NONE ? "" : v }, { shouldDirty: true })}
                        >
                          <SelectTrigger id={id} className="h-8 max-w-[240px] text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NONE}>— Not mapped —</SelectItem>
                            {cols.map((c) => (
                              <SelectItem key={c} value={c}>{c}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </td>
                      <td className="hidden px-4 py-2 md:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {selected ? (
                            sample(selected).map((s, i) => (
                              <span key={i} className="num max-w-[200px] truncate rounded bg-surface-2 px-1.5 py-0.5 text-2xs" title={s}>{s}</span>
                            ))
                          ) : (
                            <span className="text-2xs text-muted-foreground">—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {showErrors && errs.length > 0 && (
              <ul className="space-y-0.5 border-t px-4 py-2 text-xs text-crit" role="alert">
                {errs.map((e) => <li key={e}>• {e}</li>)}
              </ul>
            )}
          </section>
        );
      })}

      <section className="card p-4" aria-labelledby="sign-h">
        <h2 id="sign-h" className="mb-1 flex items-center gap-1 text-sm font-semibold">
          Sign convention <InfoTip>How the source file represents money leaving the account when a single signed Amount column is used.</InfoTip>
        </h2>
        <Controller
          control={control}
          name="signConvention"
          render={({ field }) => (
            <RadioGroup value={field.value} onValueChange={field.onChange} className="mt-2 sm:grid-cols-2" aria-label="Sign convention">
              {[
                { v: "debit_negative", t: "Debits are negative", d: "−18,450.00 = payment out (most banks)" },
                { v: "credit_negative", t: "Credits are negative", d: "−18,450.00 = money in (some ledger exports)" },
              ].map((o) => (
                <label key={o.v} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[[data-state=checked]]:border-sys has-[[data-state=checked]]:bg-sys/5">
                  <RadioGroupItem value={o.v} className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-medium">{o.t}</span>
                    <span className="num block text-2xs text-muted-foreground">{o.d}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          )}
        />
      </section>
    </div>
  );
}
