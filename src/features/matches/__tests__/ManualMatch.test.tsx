import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { getDb } from "@/api/mocks/db";
import { api } from "@/api/endpoints";
import { useUiStore } from "@/lib/store";
import { UnmatchedTab, rankCandidates } from "../UnmatchedTab";

async function setup() {
  const run = await api.run("run_2026_09");
  const rec = getDb().index.get("run_2026_09")!;
  // The Asian Paints amount mismatch: bank +4,99,410 vs ledger +5,00,000 — both unmatched.
  const link = rec.relaxable.find((r) => rec.txns.get(r.bankIds[0])!.vendorNorm === "Asian Paints Ltd")!;
  const bankId = link.bankIds[0];
  const ledgerId = link.ledgerIds[0];
  const user = userEvent.setup();
  renderWithProviders(<UnmatchedTab run={run} />, { route: "/runs/run_2026_09?tab=unmatched" });
  const bankList = await screen.findByRole("list", { name: "Bank only transactions" });
  const ledgerList = screen.getByRole("list", { name: "Ledger only transactions" });
  return { user, bankId, ledgerId, bankList, ledgerList, rec };
}

describe("Unmatched — manual match", () => {
  it("selecting one of each side and matching requires a note, then creates a manual pair", async () => {
    const { user, bankId, ledgerId, bankList, ledgerList, rec } = await setup();
    const matchBtn = screen.getByRole("button", { name: /Match manually/ });
    expect(matchBtn).toBeDisabled();

    await user.click(within(bankList).getByRole("button", { name: new RegExp(bankId) }));
    // Suggested candidates appear for a single selection, ranked with the true counterpart first
    const suggestions = await screen.findByRole("region", { name: "Suggested candidates" });
    expect(within(suggestions).getAllByRole("listitem")[0]).toHaveTextContent(ledgerId);

    await user.click(within(ledgerList).getByRole("button", { name: new RegExp(ledgerId) }));
    expect(matchBtn).toBeEnabled();
    await user.click(matchBtn);

    const dialog = await screen.findByRole("dialog", { name: "Create manual match" });
    // Sum check shows the ₹590 difference
    expect(within(dialog).getByTestId("match-diff")).toHaveTextContent("590.00");

    await user.click(within(dialog).getByRole("button", { name: "Create match" }));
    expect(await within(dialog).findByText(/at least 5 characters/)).toBeInTheDocument();
    expect(rec.pairs.some((p) => p.status === "manual")).toBe(false);

    await user.type(within(dialog).getByLabelText(/Note/), "Customer short-paid ₹590 NEFT charges; same invoice");
    await user.click(within(dialog).getByRole("button", { name: "Create match" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const pair = rec.pairs.find((p) => p.status === "manual")!;
    expect(pair.bankTxnIds).toEqual([bankId]);
    expect(pair.ledgerTxnIds).toEqual([ledgerId]);
    expect(pair.note).toMatch(/short-paid/);
    // Both rows leave the unmatched lists after refetch
    await waitFor(() => expect(within(bankList).queryByRole("button", { name: new RegExp(bankId) })).not.toBeInTheDocument());
  });

  it("is read-only for roles without match permission", async () => {
    useUiStore.setState({ role: "reviewer" });
    await setup();
    expect(screen.getByText(/your role can't create matches/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Match manually/ })).toBeDisabled();
  });

  it("ranks candidates by amount, date and vendor similarity", () => {
    const base = { source: "ledger" as const, accountId: "acc_hdfc", rawRow: {}, descriptionRaw: "" };
    const t = { ...base, id: "B1", source: "bank" as const, date: "2026-09-17", amount: "499410.00", vendorNorm: "Asian Paints Ltd" };
    const pool = [
      { ...base, id: "L1", date: "2026-09-02", amount: "12000.00", vendorNorm: "Swiggy" },
      { ...base, id: "L2", date: "2026-09-17", amount: "500000.00", vendorNorm: "Asian Paints Ltd" },
      { ...base, id: "L3", date: "2026-09-17", amount: "-499410.00", vendorNorm: "Asian Paints Ltd" }, // opposite sign
    ];
    const ranked = rankCandidates(t, pool);
    expect(ranked[0].txn.id).toBe("L2");
    expect(ranked.find((r) => r.txn.id === "L3")).toBeUndefined();
  });
});
