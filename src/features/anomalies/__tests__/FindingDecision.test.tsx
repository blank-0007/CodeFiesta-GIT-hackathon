import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { renderWithProviders } from "@/test/render";
import { server } from "@/api/mocks/server";
import { getDb, locateFinding } from "@/api/mocks/db";
import { useUiStore } from "@/lib/store";
import { FindingDetail } from "../FindingDetail";

/** The September showcase run's open potential-fraud finding (new vendor, ₹49,900). */
function fraudFindingId() {
  const rec = getDb().index.get("run_2026_09")!;
  return rec.findings.find((f) => f.category === "potential_fraud" && f.status === "open")!.id;
}

async function openFinding() {
  const id = fraudFindingId();
  const user = userEvent.setup();
  renderWithProviders(<FindingDetail findingId={id} />);
  await screen.findByText("Nova Infra Solutions");
  return { id, user };
}

describe("Finding detail — decision flow", () => {
  it("shows AI output with confidence, model and evidence warning", async () => {
    await openFinding();
    const ai = screen.getByRole("region", { name: /AI analysis/i });
    expect(within(ai).getByRole("meter", { name: "AI confidence" })).toHaveAttribute("aria-valuenow", "81");
    expect(within(ai).getByText(/gemini-2.5-pro/)).toBeInTheDocument();
    expect(within(ai).getByRole("alert")).toHaveTextContent(/No supporting evidence/);
  });

  it("requires resolution notes to approve a potential-fraud item, shows impact, then approves", async () => {
    const { id, user } = await openFinding();
    await user.click(screen.getByRole("button", { name: /^Approve/ }));

    const dialog = await screen.findByRole("dialog", { name: /Approve AI classification/i });
    // Impact on totals is shown before confirming
    await within(dialog).findByTestId("impact");

    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/Notes are required/);
    expect(locateFinding(id)!.f.status).toBe("open"); // nothing sent

    await user.type(within(dialog).getByLabelText(/Resolution notes/), "Verified vendor GSTIN and PO with procurement");
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(locateFinding(id)!.f.status).toBe("approved"));
    expect(await screen.findByRole("button", { name: /Reopen/ })).toBeInTheDocument();
    // Notes are recorded as a comment for the audit trail
    expect(locateFinding(id)!.rec.comments[id].at(-1)!.body).toMatch(/Verified vendor GSTIN/);
    expect(getDb().audit.some((a) => a.target === id && a.action === "finding.approve")).toBe(true);
  });

  it("rejecting requires a reason; the R shortcut opens the dialog", async () => {
    const { id, user } = await openFinding();
    await user.keyboard("r");
    const dialog = await screen.findByRole("dialog", { name: /Reject AI classification/i });
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/reason is required/i);
    await user.type(within(dialog).getByLabelText(/Reason/), "Known supplier, onboarding was done offline");
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(locateFinding(id)!.f.status).toBe("rejected"));
  });

  it("rolls back the optimistic update when the server fails", async () => {
    const { id, user } = await openFinding();
    server.use(http.post("*/api/findings/:id/decision", () => HttpResponse.json({ error: "boom", detail: "Server exploded" }, { status: 500 })));
    await user.click(screen.getByRole("button", { name: /^Escalate/ }));
    const dialog = await screen.findByRole("dialog", { name: /Escalate/i });
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    // Optimistic "Escalated" badge appears then reverts to "Open"
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Decision" })).getByText("Open")).toBeInTheDocument());
    expect(locateFinding(id)!.f.status).toBe("open");
  });

  it("hides decision controls' effect for read-only roles", async () => {
    useUiStore.setState({ role: "auditor" });
    await openFinding();
    expect(screen.getByRole("button", { name: /^Approve/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Reject/ })).toBeDisabled();
  });
});
