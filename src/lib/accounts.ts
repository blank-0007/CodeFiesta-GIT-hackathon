/**
 * Display labels for bank accounts. Kept separate from the seed so UI code can
 * import it without pulling the mock generator into the main bundle.
 * With a real backend these come from GET /api/settings (organization.accounts).
 */
export const ACCOUNT_LABEL: Record<string, string> = {
  acc_hdfc: "HDFC ••4521",
  acc_icici: "ICICI ••8834",
};

export const ACCOUNT_OPTIONS = [
  { id: "acc_hdfc", label: "HDFC Bank Current A/c ••4521" },
  { id: "acc_icici", label: "ICICI Bank Current A/c ••8834" },
];
