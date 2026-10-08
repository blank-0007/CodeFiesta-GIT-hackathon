import * as React from "react";
import { useNavigate } from "react-router-dom";
import { FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Loader2, Play } from "lucide-react";
import { toast } from "sonner";
import { api, qk } from "@/api/endpoints";
import { errorMessage, toastError } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { Can, PageHeader, StepProgress } from "@/components/shared/misc";
import { useCan } from "@/lib/permissions";
import { guessMapping, mappingErrors, wizardDefaults, wizardSchema, type FileEntry, type WizardValues } from "./schema";
import { UploadStep, filesReady } from "./UploadStep";
import { MappingStep } from "./MappingStep";
import { RulesStep } from "./RulesStep";
import { ReviewStep } from "./ReviewStep";
import { sampleFiles } from "./sampleFiles";

const STEPS = [
  { label: "Upload", description: "Statements & ledger" },
  { label: "Column mapping", description: "Only if needed" },
  { label: "Matching rules", description: "Tolerances & detectors" },
  { label: "Review & start", description: "Confirm and run" },
];

let seq = 0;
const guessAccount = (name: string) => (/icici/i.test(name) ? "acc_icici" : /hdfc/i.test(name) ? "acc_hdfc" : undefined);

export default function NewRunWizard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canCreate = useCan("run.create");
  const form = useForm<WizardValues>({ resolver: zodResolver(wizardSchema), defaultValues: wizardDefaults, mode: "onChange" });
  const [step, setStep] = React.useState(0);
  const [files, setFiles] = React.useState<FileEntry[]>([]);
  const [problems, setProblems] = React.useState<string[]>([]);
  const [showMapErrors, setShowMapErrors] = React.useState(false);
  const headingRef = React.useRef<HTMLHeadingElement>(null);

  const ledgerSource = form.watch("ledgerSource");
  const relevant = files.filter((f) => f.kind === "bank" || ledgerSource === "csv");
  const needsMapping = relevant.some((f) => f.status === "needs_mapping");

  const patch = (id: string, p: Partial<FileEntry>) => setFiles((fs) => fs.map((f) => (f.localId === id ? { ...f, ...p } : f)));

  const upload = async (entry: FileEntry) => {
    try {
      const result = await api.upload(entry.file, entry.kind, entry.accountId);
      patch(entry.localId, { result, status: result.status === "needs_mapping" ? "needs_mapping" : result.status === "error" ? "error" : "parsed", error: result.error });
      if (result.status === "needs_mapping") form.setValue(`mappings.${entry.localId}`, guessMapping(result.columns));
    } catch (e) {
      patch(entry.localId, { status: "error", error: errorMessage(e) });
    }
  };

  const addFiles = (list: File[], kind: "bank" | "ledger") => {
    const entries: FileEntry[] = list.map((file) => ({ localId: `f${++seq}`, file, kind, status: "uploading", accountId: kind === "bank" ? (guessAccount(file.name) ?? "acc_hdfc") : undefined }));
    setFiles((fs) => (kind === "ledger" ? [...fs.filter((f) => f.kind !== "ledger"), ...entries] : [...fs, ...entries]));
    entries.forEach(upload);
  };

  const create = useMutation({
    mutationFn: api.createRun,
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: qk.runs });
      toast.success("Reconciliation started", { description: "Watching progress live…" });
      navigate(`/runs/${run.id}`);
    },
    onError: (e) => toastError(e, "Couldn't start the run"),
  });

  const goTo = (s: number) => {
    setStep(s);
    requestAnimationFrame(() => headingRef.current?.focus());
  };

  const next = async () => {
    if (step === 0) {
      const p = filesReady(relevant, ledgerSource);
      const ok = await form.trigger(["period", "name"]);
      setProblems(p);
      if (p.length || !ok) return;
      return goTo(needsMapping ? 1 : 2);
    }
    if (step === 1) {
      const m = form.getValues("mappings");
      const bad = relevant.filter((f) => f.status === "needs_mapping" && mappingErrors(m[f.localId]).length);
      setShowMapErrors(true);
      if (bad.length) return;
      return goTo(2);
    }
    if (step === 2) {
      const ok = await form.trigger("config");
      if (!ok) return toast.error("Fix the highlighted rule settings");
      return goTo(3);
    }
  };
  const back = () => goTo(step === 2 && !needsMapping ? 0 : step - 1);

  const submit = form.handleSubmit((v) => {
    const bank = relevant.filter((f) => f.kind === "bank");
    const ledgerFile = relevant.find((f) => f.kind === "ledger");
    create.mutate({
      name: v.name || undefined,
      period: v.period,
      accounts: [...new Set(bank.map((f) => f.accountId!))],
      fileIds: relevant.map((f) => f.result!.id),
      ledgerSource: v.ledgerSource === "api" ? { type: "api", connector: v.connector, from: v.apiFrom, to: v.apiTo } : { type: "csv", fileId: ledgerFile?.result?.id },
      columnMapping: v.mappings,
      signConvention: v.signConvention,
      config: v.config,
      maskAccountNumbers: v.maskAccountNumbers,
    });
  });

  return (
    <div>
      <PageHeader title="New reconciliation" breadcrumbs={[{ label: "Runs", to: "/runs" }, { label: "New reconciliation" }]} description="Upload statements, confirm the matching rules and start the agent." />
      {!canCreate && (
        <div className="mb-4 rounded-md border border-warn/30 bg-warn/5 px-4 py-2 text-sm text-warn" role="status">
          Your current role can view this wizard but can't start runs. Switch role from the user menu to try it.
        </div>
      )}
      <div className="card mb-5 p-4">
        <StepProgress steps={STEPS.map((s, i) => ({ ...s, skipped: i === 1 && !needsMapping && step > 0 }))} current={step} onStepClick={(i) => (i === 1 && !needsMapping ? undefined : goTo(i))} />
      </div>

      <FormProvider {...form}>
        <form onSubmit={(e) => { e.preventDefault(); if (step === 3) submit(); else next(); }} noValidate>
          <h2 ref={headingRef} tabIndex={-1} className="mb-4 text-base font-semibold focus:outline-none">
            Step {step + 1} of 4 · {STEPS[step].label}
          </h2>
          {step === 0 && (
            <UploadStep
              files={files}
              addFiles={addFiles}
              removeFile={(id) => setFiles((fs) => fs.filter((f) => f.localId !== id))}
              setAccount={(id, a) => patch(id, { accountId: a })}
              retryUpload={(id) => {
                const f = files.find((x) => x.localId === id);
                if (f) {
                  patch(id, { status: "uploading", error: undefined });
                  upload(f);
                }
              }}
              retryOcr={async (id) => {
                const f = files.find((x) => x.localId === id);
                if (!f?.result) return;
                patch(id, { ocrPending: true });
                try {
                  const r = await api.retryOcr(f.result.id);
                  patch(id, { result: r, ocrPending: false });
                  toast.success("OCR recovered 26 more rows", { description: "Balances now reconcile." });
                } catch (e) {
                  patch(id, { ocrPending: false });
                  toastError(e, "OCR retry failed");
                }
              }}
              loadSamples={async () => {
                try {
                  const s = await sampleFiles();
                  addFiles(s.bank, "bank");
                  if (s.ledger.length) addFiles(s.ledger, "ledger");
                } catch (e) {
                  toastError(e, "Couldn't load sample files");
                }
              }}
            />
          )}
          {step === 1 && <MappingStep files={relevant} showErrors={showMapErrors} />}
          {step === 2 && <RulesStep />}
          {step === 3 && <ReviewStep files={relevant} />}

          {problems.length > 0 && step === 0 && (
            <ul className="mt-4 space-y-0.5 rounded-md border border-crit/30 bg-crit/5 px-4 py-2 text-sm text-crit" role="alert">
              {problems.map((p) => <li key={p}>• {p}</li>)}
            </ul>
          )}

          <div className="sticky bottom-0 -mx-4 mt-6 flex items-center justify-between gap-2 border-t bg-background/90 px-4 py-3 pb-safe backdrop-blur md:-mx-6 md:px-6 lg:-mx-8 lg:px-8">
            <Button variant="ghost" onClick={step === 0 ? () => navigate("/runs") : back}>
              <ArrowLeft /> {step === 0 ? "Cancel" : "Back"}
            </Button>
            {step < 3 ? (
              <Button type="submit">
                Continue <ArrowRight />
              </Button>
            ) : (
              <Can perm="run.create">
                <Button type="submit" disabled={create.isPending}>
                  {create.isPending ? <Loader2 className="animate-spin" /> : <Play />} Start run
                </Button>
              </Can>
            )}
          </div>
        </form>
      </FormProvider>
    </div>
  );
}
