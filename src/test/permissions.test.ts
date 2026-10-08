import { PERMISSIONS, ROLES, roleCan, type Permission, type Role } from "@/lib/permissions";

const ALL = Object.keys(PERMISSIONS) as Permission[];

/** The expected role × permission matrix (mirrors backend/app/core/auth.py MATRIX). */
const EXPECTED: Record<Role, Permission[]> = {
  admin: ALL,
  accountant: [
    "run.create", "run.rerun", "run.finalize", "match.manual", "match.unmatch",
    "finding.decide", "rule.decide", "rule.toggle", "report.generate",
  ],
  reviewer: ["finding.decide", "report.generate"],
  auditor: ["report.generate", "audit.export"],
};

describe("permission matrix", () => {
  it("defines exactly the four roles", () => {
    expect(ROLES.map((r) => r.id).sort()).toEqual(["accountant", "admin", "auditor", "reviewer"]);
  });

  it("covers all 13 permissions", () => {
    expect(ALL).toHaveLength(13);
  });

  const cases = (Object.keys(EXPECTED) as Role[]).flatMap((role) => ALL.map((perm) => [role, perm, EXPECTED[role].includes(perm)] as const));

  it.each(cases)("%s → %s = %s", (role, perm, allowed) => {
    expect(roleCan(role, perm)).toBe(allowed);
  });

  it("admin can do everything; only admin can configure detectors or edit settings", () => {
    for (const perm of ALL) expect(roleCan("admin", perm)).toBe(true);
    for (const role of ["accountant", "reviewer", "auditor"] as Role[]) {
      expect(roleCan(role, "detector.configure")).toBe(false);
      expect(roleCan(role, "settings.org")).toBe(false);
      expect(roleCan(role, "settings.ai")).toBe(false);
    }
  });

  it("auditor is read-only apart from reporting and audit export", () => {
    expect(ALL.filter((p) => roleCan("auditor", p)).sort()).toEqual(["audit.export", "report.generate"]);
  });
});
