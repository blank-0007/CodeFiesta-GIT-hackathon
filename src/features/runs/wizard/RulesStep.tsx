import * as React from "react";
import { Controller, useFieldArray, useFormContext } from "react-hook-form";
import { CheckCircle2, Plus, Save, Trash2, XCircle } from "lucide-react";
import { toast } from "sonner";
import type { WizardValues } from "./schema";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label, Slider, Switch } from "@/components/ui/form-controls";
import { Segmented, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/menus";
import { InfoTip } from "@/components/shared/misc";
import { DETECTOR_LABELS, PRESETS } from "@/lib/matching";
import { vendorSimilarity } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";

const TEMPLATE_KEY = "reconai-templates";
type Templates = Record<string, WizardValues["config"]>;
function loadTemplates(): Templates {
  try {
    return JSON.parse(localStorage.getItem(TEMPLATE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function FuzzyExample({ threshold }: { threshold: number }) {
  const [a, setA] = React.useState("AMZN MKTP US*2K4");
  const [b, setB] = React.useState("Amazon");
  const score = vendorSimilarity(a, b);
  const pass = score >= threshold;
  return (
    <div className="mt-3 rounded-md border bg-background p-3">
      <p className="mb-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Live example</p>
      <div className="grid items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
        <Input aria-label="Bank narration" value={a} onChange={(e) => setA(e.target.value)} className="num h-8 text-xs" />
        <span className="text-center text-xs text-muted-foreground">vs</span>
        <Input aria-label="Ledger vendor" value={b} onChange={(e) => setB(e.target.value)} className="h-8 text-xs" />
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs" aria-live="polite">
        <span className="num text-base font-semibold">{Math.round(score * 100)}%</span>
        {pass ? (
          <span className="flex items-center gap-1 text-ok"><CheckCircle2 className="h-3.5 w-3.5" /> Would match at {Math.round(threshold * 100)}%</span>
        ) : (
          <span className="flex items-center gap-1 text-attn"><XCircle className="h-3.5 w-3.5" /> Below threshold — left unmatched</span>
        )}
      </div>
    </div>
  );
}

function Field({ label, help, children, htmlFor }: { label: string; help?: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="flex items-center gap-1">
        {label}
        {help && <InfoTip>{help}</InfoTip>}
      </Label>
      {children}
    </div>
  );
}

export function RulesStep() {
  const { control, register, watch, setValue, getValues, formState } = useFormContext<WizardValues>();
  const passes = useFieldArray({ control, name: "config.passes" });
  const cfg = watch("config");
  const errors = formState.errors.config;
  const [templates, setTemplates] = React.useState<Templates>(loadTemplates);
  const [tplName, setTplName] = React.useState("");

  const custom = () => setValue("config.preset", "custom");
  const applyPreset = (p: WizardValues["config"]["preset"]) => {
    if (p === "custom") return setValue("config.preset", "custom");
    const c = PRESETS[p].config;
    setValue("config", { ...c, detectors: { ...c.detectors }, passes: c.passes.map((x) => ({ ...x })) } as WizardValues["config"], { shouldDirty: true });
  };
  const saveTemplate = () => {
    const name = tplName.trim();
    if (!name) return;
    const next = { ...templates, [name]: getValues("config") };
    localStorage.setItem(TEMPLATE_KEY, JSON.stringify(next));
    setTemplates(next);
    setTplName("");
    toast.success(`Template “${name}” saved`, { description: "Available next time you start a run." });
  };

  return (
    <div className="space-y-5">
      <section aria-labelledby="preset-h">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 id="preset-h" className="text-sm font-semibold">Preset</h2>
          {Object.keys(templates).length > 0 && (
            <Select onValueChange={(n) => setValue("config", { ...templates[n], preset: "custom" })}>
              <SelectTrigger className="h-8 w-56 text-xs" aria-label="Load saved template"><SelectValue placeholder="Load saved template…" /></SelectTrigger>
              <SelectContent>
                {Object.keys(templates).map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>
        <div role="radiogroup" aria-label="Matching preset" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          {(["strict", "balanced", "relaxed", "custom"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={cfg.preset === p}
              onClick={() => applyPreset(p)}
              className={cn("rounded-lg border p-3 text-left transition-colors hover:border-muted-foreground/50", cfg.preset === p && "border-sys bg-sys/5 ring-1 ring-sys/30")}
            >
              <span className="block text-sm font-medium">{p === "custom" ? "Custom" : PRESETS[p].label}{p === "balanced" && <span className="ml-1.5 text-2xs text-sys">Recommended</span>}</span>
              <span className="mt-0.5 block text-2xs text-muted-foreground">{p === "custom" ? "Your own combination — any change below switches to Custom." : PRESETS[p].description}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="card space-y-5 p-4" aria-label="Tolerances">
          <Field label={`Date tolerance: ±${cfg.dateToleranceDays} day${cfg.dateToleranceDays === 1 ? "" : "s"}`} help="How far apart the bank value date and ledger posting date may be.">
            <Controller
              control={control}
              name="config.dateToleranceDays"
              render={({ field }) => (
                <Slider min={0} max={10} step={1} value={[field.value]} thumbLabel="Date tolerance in days" onValueChange={(v) => { field.onChange(v[0]); custom(); }} />
              )}
            />
            <div className="num flex justify-between text-2xs text-muted-foreground"><span>0</span><span>5</span><span>10 days</span></div>
          </Field>

          <Field label="Amount tolerance" help="Exact requires identical amounts. A tolerance absorbs rounding and FX differences." htmlFor="amt-tol">
            <div className="flex flex-wrap items-center gap-2">
              <Controller control={control} name="config.amountMode" render={({ field }) => <Segmented label="Amount mode" value={field.value} onChange={(v) => { field.onChange(v); custom(); }} options={[{ value: "exact", label: "Exact" }, { value: "tolerance", label: "± Amount" }]} />} />
              {cfg.amountMode === "tolerance" && (
                <div className="relative">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">±₹</span>
                  <Input id="amt-tol" inputMode="decimal" className="num h-8 w-28 pl-7 text-xs" {...register("config.amountTolerance", { onChange: custom })} aria-invalid={!!errors?.amountTolerance} />
                </div>
              )}
            </div>
            <FieldError message={errors?.amountTolerance?.message} />
          </Field>

          <Field label={`Fuzzy vendor threshold: ${Math.round(cfg.vendorThreshold * 100)}%`} help="Minimum vendor-name similarity for a fuzzy match. Lower = more matches, more false positives.">
            <Controller control={control} name="config.vendorThreshold" render={({ field }) => <Slider min={0.5} max={1} step={0.01} value={[field.value]} thumbLabel="Vendor similarity threshold" onValueChange={(v) => { field.onChange(v[0]); custom(); }} />} />
            <FuzzyExample threshold={cfg.vendorThreshold} />
          </Field>

          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="ref-match" className="flex items-center gap-1">Reference matching <InfoTip>Use UTR / cheque / invoice numbers found in narrations as a strong match signal.</InfoTip></Label>
            <Controller control={control} name="config.referenceMatching" render={({ field }) => <Switch id="ref-match" checked={field.value} onCheckedChange={(v) => { field.onChange(v); custom(); }} />} />
          </div>
        </section>

        <section className="card space-y-4 p-4" aria-label="Thresholds and detectors">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="High-value threshold" help="Items above this are always routed to human review." htmlFor="hv">
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
                <Input id="hv" inputMode="decimal" className="num pl-6" {...register("config.highValueThreshold", { onChange: custom })} aria-invalid={!!errors?.highValueThreshold} />
              </div>
              <FieldError message={errors?.highValueThreshold?.message} />
            </Field>
            <Field label="Approval limit" help="Used by the just-below-threshold detector (e.g. ₹49,900 when the limit is ₹50,000)." htmlFor="al">
              <div className="relative">
                <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
                <Input id="al" inputMode="decimal" className="num pl-6" {...register("config.approvalLimit", { onChange: custom })} aria-invalid={!!errors?.approvalLimit} />
              </div>
              <FieldError message={errors?.approvalLimit?.message} />
            </Field>
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold">Detectors</h3>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {Object.entries(DETECTOR_LABELS).map(([id, label]) => (
                <li key={id} className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5">
                  <Label htmlFor={`det-${id}`} className="text-xs font-normal">{label}</Label>
                  <Controller control={control} name={`config.detectors.${id}`} render={({ field }) => <Switch id={`det-${id}`} checked={!!field.value} onCheckedChange={(v) => { field.onChange(v); custom(); }} />} />
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      <section className="card" aria-labelledby="passes-h">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div className="flex items-center gap-3">
            <h2 id="passes-h" className="text-sm font-semibold">Multi-pass matching</h2>
            <Controller control={control} name="config.multiPass" render={({ field }) => <Switch checked={field.value} onCheckedChange={(v) => { field.onChange(v); custom(); }} aria-label="Enable multi-pass matching" />} />
          </div>
          <p className="text-2xs text-muted-foreground">Passes run in order; each only sees items still unmatched.</p>
        </div>
        {cfg.multiPass ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-2xs uppercase tracking-wider text-muted-foreground">
                  <th scope="col" className="px-4 py-2 font-semibold">Pass</th>
                  <th scope="col" className="px-2 py-2 font-semibold">Date ±days</th>
                  <th scope="col" className="px-2 py-2 font-semibold">Amount ±₹</th>
                  <th scope="col" className="px-2 py-2 font-semibold">Vendor ≥</th>
                  <th scope="col" className="px-2 py-2 font-semibold">Confidence</th>
                  <th scope="col" className="w-10 px-2 py-2"><span className="sr-only">Remove</span></th>
                </tr>
              </thead>
              <tbody>
                {passes.fields.map((p, i) => (
                  <tr key={p.id} className="border-t">
                    <td className="px-4 py-1.5"><Input aria-label={`Pass ${i + 1} name`} className="h-8 text-xs" {...register(`config.passes.${i}.name`, { onChange: custom })} /></td>
                    <td className="px-2 py-1.5"><Input aria-label={`Pass ${i + 1} date tolerance`} type="number" min={0} max={30} className="num h-8 w-20 text-xs" {...register(`config.passes.${i}.dateToleranceDays`, { valueAsNumber: true, onChange: custom })} /></td>
                    <td className="px-2 py-1.5"><Input aria-label={`Pass ${i + 1} amount tolerance`} inputMode="decimal" className="num h-8 w-24 text-xs" {...register(`config.passes.${i}.amountTolerance`, { onChange: custom })} aria-invalid={!!errors?.passes?.[i]?.amountTolerance} /></td>
                    <td className="px-2 py-1.5"><Input aria-label={`Pass ${i + 1} vendor threshold`} type="number" step={0.01} min={0} max={1} className="num h-8 w-20 text-xs" {...register(`config.passes.${i}.vendorThreshold`, { valueAsNumber: true, onChange: custom })} /></td>
                    <td className="px-2 py-1.5"><Input aria-label={`Pass ${i + 1} confidence`} type="number" step={0.01} min={0} max={1} className="num h-8 w-20 text-xs" {...register(`config.passes.${i}.confidence`, { valueAsNumber: true, onChange: custom })} /></td>
                    <td className="px-2 py-1.5">
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove pass ${i + 1}`} disabled={passes.fields.length === 1} onClick={() => { passes.remove(i); custom(); }}>
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t px-4 py-2">
              <Button variant="ghost" size="sm" onClick={() => { passes.append({ name: `P${passes.fields.length + 1} · Custom`, dateToleranceDays: 5, amountTolerance: "10.00", vendorThreshold: 0.6, confidence: 0.75 }); custom(); }}>
                <Plus /> Add pass
              </Button>
            </div>
            <FieldError message={errors?.passes?.message ?? errors?.passes?.root?.message} />
          </div>
        ) : (
          <p className="px-4 py-3 text-xs text-muted-foreground">Single pass using the tolerances above.</p>
        )}
      </section>

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <Label htmlFor="tpl-name">Save as template</Label>
          <Input id="tpl-name" value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="e.g. Quarter-end relaxed" className="mt-1 w-64" />
        </div>
        <Button variant="secondary" onClick={saveTemplate} disabled={!tplName.trim()}>
          <Save /> Save template
        </Button>
      </div>
    </div>
  );
}
