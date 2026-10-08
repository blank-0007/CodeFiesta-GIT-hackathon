import { useUiStore } from "@/lib/store";

export type Role = "admin" | "accountant" | "reviewer" | "auditor";

export const ROLES: { id: Role; label: string; description: string }[] = [
  { id: "admin", label: "Admin", description: "Full access, including org, AI and detector configuration" },
  { id: "accountant", label: "Accountant", description: "Runs reconciliations, matches, decides findings, approves rules" },
  { id: "reviewer", label: "Reviewer", description: "Decides findings routed to human review" },
  { id: "auditor", label: "Auditor", description: "Read-only access to everything, can export" },
];

export const PERMISSIONS = {
  "run.create": "Start reconciliation runs",
  "run.rerun": "Re-run with relaxed tolerances",
  "run.finalize": "Finalize runs",
  "match.manual": "Create manual matches",
  "match.unmatch": "Unmatch pairs",
  "finding.decide": "Approve / reject findings",
  "rule.decide": "Approve AI-proposed rules",
  "rule.toggle": "Enable / disable rules",
  "detector.configure": "Configure detectors",
  "report.generate": "Generate & download reports",
  "audit.export": "Export audit log",
  "settings.org": "Edit organization settings",
  "settings.ai": "Edit AI & privacy settings",
} as const;

export type Permission = keyof typeof PERMISSIONS;

const MATRIX: Record<Role, Permission[]> = {
  admin: Object.keys(PERMISSIONS) as Permission[],
  accountant: [
    "run.create", "run.rerun", "run.finalize", "match.manual", "match.unmatch",
    "finding.decide", "rule.decide", "rule.toggle", "report.generate",
  ],
  reviewer: ["finding.decide", "report.generate"],
  auditor: ["report.generate", "audit.export"],
};

export function roleCan(role: Role, perm: Permission): boolean {
  return MATRIX[role].includes(perm);
}

export function useCan(perm: Permission): boolean {
  const role = useUiStore((s) => s.role);
  return roleCan(role, perm);
}

export function useRoleLabel(): string {
  const role = useUiStore((s) => s.role);
  return ROLES.find((r) => r.id === role)?.label ?? role;
}
