import * as React from "react";
import { Controller, useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Bell, Building2, Check, Code2, Loader2, Lock, Minus, Plus, Shield, Sparkles, SlidersHorizontal, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import type { Settings } from "@/api/types";
import { useSettings, useUpdateSettings } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label, Slider, Switch } from "@/components/ui/form-controls";
import { Segmented, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/menus";
import { AmountCell } from "@/components/shared/AmountCell";
import { AIBadge } from "@/components/shared/badges";
import { Can, ErrorState, PageHeader, SkeletonRows } from "@/components/shared/misc";
import { useUrlParam } from "@/hooks/useUrlState";
import { useUiStore, type Density, type Theme } from "@/lib/store";
import { PERMISSIONS, ROLES, roleCan, useCan, type Permission, type Role } from "@/lib/permissions";
import { fmtDate } from "@/lib/format";
import type { CurrencyCode, MoneyLocale } from "@/lib/money";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { id: "preferences", label: "Profile & preferences", icon: SlidersHorizontal },
  { id: "organization", label: "Organization", icon: Building2 },
  { id: "ai", label: "AI & privacy", icon: Sparkles },
  { id: "roles", label: "Roles & permissions", icon: Users },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "developer", label: "Developer", icon: Code2 },
] as const;

function SectionCard({ title, description, children, footer }: { title: string; description?: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <section className="card" aria-labelledby={`s-${title}`}>
      <div className="border-b px-5 py-3.5">
        <h2 id={`s-${title}`} className="text-sm font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="space-y-5 p-5">{children}</div>
      {footer && <div className="flex items-center justify-end gap-2 border-t px-5 py-3">{footer}</div>}
    </section>
  );
}

function Row({ label, help, children, htmlFor }: { label: string; help?: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[220px_1fr] sm:items-center">
      <div>
        <Label htmlFor={htmlFor} className="text-sm">{label}</Label>
        {help && <p className="text-2xs text-muted-foreground">{help}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function ReadOnlyNotice({ perm }: { perm: Permission }) {
  const can = useCan(perm);
  if (can) return null;
  return (
    <p className="flex items-center gap-1.5 rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn" role="status">
      <Lock className="h-3.5 w-3.5" /> Read-only — only Admins can change this section.
    </p>
  );
}

/* ---------------- Preferences ---------------- */
function Preferences() {
  const s = useUiStore();
  return (
    <SectionCard title="Profile & preferences" description="Stored on this device. Applies immediately.">
      <Row label="Name"><p className="text-sm">Priya Sharma · priya.sharma@acme.in</p></Row>
      <Row label="Theme">
        <Segmented<Theme> label="Theme" value={s.theme} onChange={(v) => s.set({ theme: v })} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" }]} />
      </Row>
      <Row label="Table density" help="Row height in data tables.">
        <Segmented<Density> label="Density" value={s.density} onChange={(v) => s.set({ density: v })} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} />
      </Row>
      <Row label="Number format" htmlFor="locale" help="Digit grouping for amounts.">
        <Select value={s.locale} onValueChange={(v) => s.set({ locale: v as MoneyLocale })}>
          <SelectTrigger id="locale" className="w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="en-IN">Indian (12,34,567.89)</SelectItem>
            <SelectItem value="en-US">International (1,234,567.89)</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label="Currency" htmlFor="currency">
        <Select value={s.currency} onValueChange={(v) => s.set({ currency: v as CurrencyCode })}>
          <SelectTrigger id="currency" className="w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="INR">₹ Indian Rupee (INR)</SelectItem>
            <SelectItem value="USD">$ US Dollar (USD)</SelectItem>
            <SelectItem value="EUR">€ Euro (EUR)</SelectItem>
            <SelectItem value="GBP">£ Pound Sterling (GBP)</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label="Date format" htmlFor="datefmt">
        <Select value={s.dateFormat} onValueChange={(v) => s.set({ dateFormat: v })}>
          <SelectTrigger id="datefmt" className="w-64"><SelectValue /></SelectTrigger>
          <SelectContent>
            {["dd MMM yyyy", "dd/MM/yyyy", "yyyy-MM-dd", "MMM d, yyyy"].map((f) => (
              <SelectItem key={f} value={f}>{fmtDate("2026-09-30", f)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label="Preview">
        <div className="flex flex-wrap items-center gap-4 rounded-md border bg-background px-3 py-2 text-sm">
          <span className="num">{fmtDate("2026-09-30")}</span>
          <AmountCell value="-124500.00" />
          <AmountCell value="1240880.5" />
          <AmountCell value="98765432.10" colorize={false} />
        </div>
      </Row>
    </SectionCard>
  );
}

/* ---------------- Organization ---------------- */
const money = z.string().regex(/^\d+(\.\d{1,2})?$/, "Enter an amount like 50000 or 50000.00");
const orgSchema = z
  .object({
    name: z.string().min(2, "Required"),
    approvalLimit: money,
    highValueThreshold: money,
    connectorType: z.enum(["csv", "api"]),
    provider: z.string().min(1),
    accounts: z.array(
      z.object({
        id: z.string(),
        name: z.string().min(2, "Required"),
        bank: z.string().min(2, "Required"),
        last4: z.string().regex(/^\d{4}$/, "4 digits"),
        parserTemplate: z.string().min(1, "Required"),
        currency: z.string(),
      }),
    ),
  })
  .refine((v) => Number(v.approvalLimit) <= Number(v.highValueThreshold), { path: ["approvalLimit"], message: "Should not exceed the high-value threshold" });
type OrgValues = z.infer<typeof orgSchema>;

function Organization({ settings }: { settings: Settings }) {
  const save = useUpdateSettings();
  const can = useCan("settings.org");
  const o = settings.organization;
  const form = useForm<OrgValues>({
    resolver: zodResolver(orgSchema),
    defaultValues: { name: o.name, approvalLimit: o.approvalLimit, highValueThreshold: o.highValueThreshold, connectorType: o.connector.type, provider: o.connector.provider, accounts: o.accounts },
  });
  const accounts = useFieldArray({ control: form.control, name: "accounts" });
  const errs = form.formState.errors;
  const submit = form.handleSubmit((v) =>
    save.mutate({
      organization: { name: v.name, approvalLimit: v.approvalLimit, highValueThreshold: v.highValueThreshold, accounts: v.accounts, connector: { type: v.connectorType, provider: v.provider, status: "connected" } },
    }),
  );
  return (
    <form onSubmit={submit} noValidate>
      <SectionCard
        title="Organization"
        description="Bank accounts, accounting connector and approval thresholds used by detectors."
        footer={
          <Can perm="settings.org">
            <Button type="submit" disabled={save.isPending || !form.formState.isDirty}>{save.isPending && <Loader2 className="animate-spin" />} Save changes</Button>
          </Can>
        }
      >
        <ReadOnlyNotice perm="settings.org" />
        <fieldset disabled={!can} className="space-y-5">
          <Row label="Organization name" htmlFor="org-name">
            <Input id="org-name" {...form.register("name")} aria-invalid={!!errs.name} />
            <FieldError message={errs.name?.message} />
          </Row>
          <Row label="Approval limit" help="Payments just below this are flagged." htmlFor="org-al">
            <div className="relative w-48"><span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span><Input id="org-al" className="num pl-6" {...form.register("approvalLimit")} aria-invalid={!!errs.approvalLimit} /></div>
            <FieldError message={errs.approvalLimit?.message} />
          </Row>
          <Row label="High-value threshold" help="Always routed to human review." htmlFor="org-hv">
            <div className="relative w-48"><span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span><Input id="org-hv" className="num pl-6" {...form.register("highValueThreshold")} aria-invalid={!!errs.highValueThreshold} /></div>
            <FieldError message={errs.highValueThreshold?.message} />
          </Row>
          <Row label="Accounting connector">
            <div className="flex flex-wrap items-center gap-2">
              <Controller control={form.control} name="connectorType" render={({ field }) => <Segmented label="Connector type" value={field.value} onChange={(v) => field.onChange(v)} options={[{ value: "csv", label: "CSV upload" }, { value: "api", label: "API" }]} />} />
              <Controller
                control={form.control}
                name="provider"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-56" aria-label="Accounting system"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["Tally Prime", "Zoho Books", "QuickBooks Online", "Oracle NetSuite", "SAP Business One"].map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              />
              <span className="flex items-center gap-1 text-xs text-ok"><Check className="h-3.5 w-3.5" /> {o.connector.status}</span>
            </div>
          </Row>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-medium">Bank accounts</h3>
              <Button size="xs" variant="secondary" onClick={() => accounts.append({ id: `acc_${Date.now().toString(36)}`, name: "", bank: "", last4: "", parserTemplate: "Generic CSV", currency: "INR" })}>
                <Plus /> Add account
              </Button>
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-2xs uppercase tracking-wider text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-semibold">Account name</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Bank</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Last 4</th>
                    <th scope="col" className="px-3 py-2 font-semibold">Parser template</th>
                    <th scope="col" className="w-10 px-3 py-2"><span className="sr-only">Remove</span></th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.fields.map((a, i) => (
                    <tr key={a.id} className="border-t align-top">
                      <td className="px-3 py-1.5"><Input aria-label="Account name" className="h-8 text-xs" {...form.register(`accounts.${i}.name`)} aria-invalid={!!errs.accounts?.[i]?.name} /></td>
                      <td className="px-3 py-1.5"><Input aria-label="Bank" className="h-8 text-xs" {...form.register(`accounts.${i}.bank`)} aria-invalid={!!errs.accounts?.[i]?.bank} /></td>
                      <td className="px-3 py-1.5"><Input aria-label="Last 4 digits" className="num h-8 w-20 text-xs" maxLength={4} {...form.register(`accounts.${i}.last4`)} aria-invalid={!!errs.accounts?.[i]?.last4} /><FieldError message={errs.accounts?.[i]?.last4?.message} /></td>
                      <td className="px-3 py-1.5">
                        <Controller
                          control={form.control}
                          name={`accounts.${i}.parserTemplate`}
                          render={({ field }) => (
                            <Select value={field.value} onValueChange={field.onChange}>
                              <SelectTrigger className="h-8 text-xs" aria-label="Parser template"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                {["HDFC PDF v3", "ICICI CSV (iBizz)", "SBI PDF", "Kotak CSV", "Axis PDF", "Generic CSV"].map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          )}
                        />
                      </td>
                      <td className="px-3 py-1.5"><Button variant="ghost" size="icon-sm" aria-label={`Remove account ${i + 1}`} onClick={() => accounts.remove(i)}><Trash2 /></Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </fieldset>
      </SectionCard>
    </form>
  );
}

/* ---------------- AI & privacy ---------------- */
function AiPrivacy({ settings }: { settings: Settings }) {
  const save = useUpdateSettings();
  const can = useCan("settings.ai");
  const [ai, setAi] = React.useState(settings.ai);
  React.useEffect(() => setAi(settings.ai), [settings.ai]);
  const dirty = JSON.stringify(ai) !== JSON.stringify(settings.ai);
  return (
    <SectionCard
      title="AI & privacy"
      description="Controls what the investigation agent sees. Matching and detectors never use the AI."
      footer={<Can perm="settings.ai"><Button disabled={!dirty || save.isPending} onClick={() => save.mutate({ ai })}>{save.isPending && <Loader2 className="animate-spin" />} Save changes</Button></Can>}
    >
      <ReadOnlyNotice perm="settings.ai" />
      <fieldset disabled={!can} className="space-y-5">
        <Row label="Send data to AI" help="Master switch for the investigation agent.">
          <div className="flex items-center gap-3">
            <Switch checked={ai.sendDataToAi} onCheckedChange={(v) => setAi({ ...ai, sendDataToAi: v })} aria-label="Send data to AI" />
            {!ai.sendDataToAi && <span className="text-xs text-warn">AI investigation off — every unmatched item goes to human review without an explanation.</span>}
          </div>
        </Row>
        <Row label="Provider"><span className="flex items-center gap-2 text-sm">Google Gemini <AIBadge label="via LangGraph" /></span></Row>
        <Row label="Default model" htmlFor="ai-model" help="Used for all investigations.">
          <Select value={ai.defaultModel} onValueChange={(v) => setAi({ ...ai, defaultModel: v })}>
            <SelectTrigger id="ai-model" className="w-64"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="gemini-2.5-flash">Gemini Flash (default, fast)</SelectItem>
              <SelectItem value="gemini-2.5-flash-lite">Gemini Flash-Lite (cheapest)</SelectItem>
              <SelectItem value="gemini-2.5-pro">Gemini Pro (most capable)</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label="High-value escalation model" htmlFor="ai-esc" help="Potential fraud and high-value items are re-investigated with this model.">
          <Select value={ai.escalationModel} onValueChange={(v) => setAi({ ...ai, escalationModel: v })}>
            <SelectTrigger id="ai-esc" className="w-64"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="gemini-2.5-pro">Gemini Pro</SelectItem>
              <SelectItem value="gemini-2.5-flash">Gemini Flash (no escalation)</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label="Mask account numbers" help="Replaced with ••last4 before any AI call.">
          <Switch checked={ai.maskAccountNumbers} onCheckedChange={(v) => setAi({ ...ai, maskAccountNumbers: v })} aria-label="Mask account numbers" />
        </Row>
        <Row label="Mask personal names" help="Individuals in narrations (e.g. IMPS to a person) become PERSON_1, PERSON_2…">
          <Switch checked={ai.maskPersonalNames} onCheckedChange={(v) => setAi({ ...ai, maskPersonalNames: v })} aria-label="Mask personal names" />
        </Row>
        <Row label="Retention">
          <p className="text-sm text-muted-foreground">Prompts and responses are retained for <span className="num text-foreground">{ai.retentionDays}</span> days for audit, then deleted. The provider does not train on your data.</p>
        </Row>
        <Row label="Estimated cost per run"><span className="flex items-center gap-2"><AmountCell value={ai.estCostPerRun} colorize={false} className="text-sm font-semibold" /> <span className="text-xs text-muted-foreground">at ~35 investigated items</span></span></Row>
      </fieldset>
    </SectionCard>
  );
}

/* ---------------- Roles ---------------- */
function RolesMatrix() {
  const role = useUiStore((s) => s.role);
  const set = useUiStore((s) => s.set);
  return (
    <SectionCard title="Roles & permissions" description="The UI hides or disables controls based on the current role. Use the dev role switcher to try each one.">
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed px-3 py-2">
        <span className="flex items-center gap-1.5 text-xs font-medium"><Code2 className="h-3.5 w-3.5" /> Dev mode · current role</span>
        <Segmented<Role> label="Current role" value={role} onChange={(v) => { set({ role: v }); toast.info(`Now acting as ${ROLES.find((r) => r.id === v)?.label}`); }} options={ROLES.map((r) => ({ value: r.id, label: r.label }))} />
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Permissions by role</caption>
          <thead>
            <tr>
              <th scope="col" className="px-3 py-2 text-left text-2xs font-semibold uppercase tracking-wider text-muted-foreground">Permission</th>
              {ROLES.map((r) => (
                <th key={r.id} scope="col" className={cn("px-3 py-2 text-center text-xs font-semibold", r.id === role && "bg-sys/10 text-sys")}>
                  {r.label}
                  {r.id === role && <span className="block text-[10px] font-normal">(you)</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(Object.entries(PERMISSIONS) as [Permission, string][]).map(([p, label]) => (
              <tr key={p} className="border-t border-border/60">
                <th scope="row" className="px-3 py-1.5 text-left font-normal">{label}</th>
                {ROLES.map((r) => {
                  const ok = roleCan(r.id, p);
                  return (
                    <td key={r.id} className={cn("px-3 py-1.5 text-center", r.id === role && "bg-sys/5")}>
                      {ok ? <Check className="mx-auto h-4 w-4 text-ok" aria-label="Allowed" /> : <Minus className="mx-auto h-4 w-4 text-muted-foreground/50" aria-label="Not allowed" />}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Shield className="h-3.5 w-3.5" /> The mock API enforces the same matrix (403) via the X-Demo-Role header; a real backend should use the session's role.</p>
    </SectionCard>
  );
}

/* ---------------- Notifications ---------------- */
function Notifications({ settings }: { settings: Settings }) {
  const save = useUpdateSettings();
  const [n, setN] = React.useState(settings.notifications);
  React.useEffect(() => setN(settings.notifications), [settings.notifications]);
  const dirty = JSON.stringify(n) !== JSON.stringify(settings.notifications);
  return (
    <SectionCard title="Notifications" description="When a run finishes, when something is assigned to you, and when a potential-fraud item appears." footer={<Button disabled={!dirty || save.isPending} onClick={() => save.mutate({ notifications: n })}>{save.isPending && <Loader2 className="animate-spin" />} Save changes</Button>}>
      <Row label="Email"><Switch checked={n.email} onCheckedChange={(v) => setN({ ...n, email: v })} aria-label="Email notifications" /></Row>
      <Row label="Slack"><Switch checked={n.slack} onCheckedChange={(v) => setN({ ...n, slack: v })} aria-label="Slack notifications" /></Row>
      {n.slack && (
        <Row label="Slack channel" htmlFor="slack-ch">
          <Input id="slack-ch" className="w-64" value={n.slackChannel} onChange={(e) => setN({ ...n, slackChannel: e.target.value })} />
        </Row>
      )}
      <Row label="Digest">
        <Segmented label="Digest frequency" value={n.digest} onChange={(v) => setN({ ...n, digest: v })} options={[{ value: "realtime", label: "Real-time" }, { value: "daily", label: "Daily digest" }]} />
      </Row>
      <p className="text-xs text-muted-foreground">Potential-fraud alerts are always sent immediately, regardless of digest setting.</p>
    </SectionCard>
  );
}

/* ---------------- Developer ---------------- */
function Developer() {
  const read = () => {
    try {
      return { minLatency: 200, maxLatency: 800, errorRate: 0.02, ...JSON.parse(localStorage.getItem("reconai-mock") ?? "{}") };
    } catch {
      return { minLatency: 200, maxLatency: 800, errorRate: 0.02 };
    }
  };
  const [cfg, setCfg] = React.useState(read);
  const update = (patch: Partial<typeof cfg>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    localStorage.setItem("reconai-mock", JSON.stringify(next));
  };
  return (
    <SectionCard title="Developer" description="Mock API controls (MSW). Mock data lives in memory and resets when you reload the page.">
      <Row label={`Latency: ${cfg.minLatency}–${cfg.maxLatency} ms`}>
        <Slider min={0} max={2000} step={50} value={[cfg.minLatency, cfg.maxLatency]} onValueChange={(v) => update({ minLatency: v[0], maxLatency: v[1] })} thumbLabel="Latency" className="max-w-md" />
      </Row>
      <Row label={`Error rate: ${Math.round(cfg.errorRate * 100)}%`} help="Random 503s to exercise retry, rollback and error states.">
        <Slider min={0} max={0.5} step={0.01} value={[cfg.errorRate]} onValueChange={(v) => update({ errorRate: v[0] })} thumbLabel="Error rate" className="max-w-md" />
      </Row>
      <Row label="API base URL"><code className="num text-xs">{import.meta.env.VITE_API_BASE_URL || "(same origin) /api"}</code></Row>
      <Row label="Mocks enabled"><code className="num text-xs">{import.meta.env.VITE_USE_MOCKS === "false" ? "false — using real backend" : "true"}</code></Row>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => { localStorage.removeItem("reconai-mock"); setCfg(read()); toast.success("Mock settings reset"); }}>Reset mock settings</Button>
        <Button variant="secondary" onClick={() => window.location.reload()}>Reset demo data (reload)</Button>
      </div>
    </SectionCard>
  );
}

export default function SettingsPage() {
  const [section, setSection] = useUrlParam("section", "preferences");
  const { data, isLoading, error, refetch } = useSettings();
  const needsServer = section === "organization" || section === "ai" || section === "notifications";
  return (
    <div>
      <PageHeader title="Settings" breadcrumbs={[{ label: "Dashboard", to: "/" }, { label: "Settings" }]} />
      <div className="grid gap-5 md:grid-cols-[220px_1fr]">
        <nav aria-label="Settings sections">
          <ul className="flex gap-1 overflow-x-auto md:flex-col">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => setSection(s.id)}
                  aria-current={section === s.id ? "page" : undefined}
                  className={cn("flex w-full items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm text-muted-foreground hover:bg-surface-2 hover:text-foreground", section === s.id && "bg-surface-2 font-medium text-foreground")}
                >
                  <s.icon className="h-4 w-4" aria-hidden /> {s.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 max-w-4xl">
          {needsServer && isLoading ? (
            <div className="card"><SkeletonRows rows={6} cols={2} /></div>
          ) : needsServer && (error || !data) ? (
            <ErrorState error={error} onRetry={() => refetch()} />
          ) : section === "organization" ? (
            <Organization settings={data!} />
          ) : section === "ai" ? (
            <AiPrivacy settings={data!} />
          ) : section === "roles" ? (
            <RolesMatrix />
          ) : section === "notifications" ? (
            <Notifications settings={data!} />
          ) : section === "developer" ? (
            <Developer />
          ) : (
            <Preferences />
          )}
        </div>
      </div>
    </div>
  );
}
