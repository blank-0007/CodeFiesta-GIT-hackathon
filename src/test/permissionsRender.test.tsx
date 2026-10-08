import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { getDb, runView } from "@/api/mocks/db";
import { useUiStore } from "@/lib/store";
import { Can } from "@/components/shared/misc";
import { RerunButton } from "@/features/runs/RunActions";

function septemberRun() {
  return runView(getDb().index.get("run_2026_09")!);
}

describe("role-gated actions", () => {
  it("accountant can re-run with relaxed tolerances", () => {
    renderWithProviders(<RerunButton run={septemberRun()} />);
    expect(screen.getByRole("button", { name: /Re-run with relaxed tolerances/ })).toBeEnabled();
  });

  it("auditor sees the re-run action disabled", () => {
    useUiStore.setState({ role: "auditor" });
    renderWithProviders(<RerunButton run={septemberRun()} />);
    expect(screen.getByRole("button", { name: /Re-run with relaxed tolerances/ })).toBeDisabled();
  });

  it("<Can mode='hide'> removes the action for auditor but keeps permitted ones", () => {
    useUiStore.setState({ role: "auditor" });
    renderWithProviders(
      <>
        <Can perm="run.finalize" mode="hide">
          <button>Finalize run</button>
        </Can>
        <Can perm="audit.export" mode="hide">
          <button>Export audit log</button>
        </Can>
      </>,
    );
    expect(screen.queryByRole("button", { name: "Finalize run" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export audit log" })).toBeEnabled();
  });
});
