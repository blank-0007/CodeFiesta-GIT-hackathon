import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChevronDown, ChevronUp, PanelRight } from "lucide-react";
import { useFindings, useRun } from "@/api/queries";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/shared/misc";
import { CategoryBadge, StatusBadge } from "@/components/shared/badges";
import { FindingDetail } from "./FindingDetail";

export default function FindingPage() {
  const { runId = "", findingId = "" } = useParams();
  const navigate = useNavigate();
  const { data: run } = useRun(runId);
  const { data: findings } = useFindings(runId, run);
  const ids = useMemo(() => [...(findings ?? [])].sort((a, b) => b.riskScore - a.riskScore).map((f) => f.id), [findings]);
  const idx = ids.indexOf(findingId);
  const f = findings?.find((x) => x.id === findingId);
  const go = (id?: string) => id && navigate(`/runs/${runId}/findings/${id}`);

  return (
    <div>
      <PageHeader
        breadcrumbs={[{ label: "Runs", to: "/runs" }, { label: run?.name ?? runId, to: `/runs/${runId}?tab=anomalies` }, { label: findingId }]}
        title={<span className="num">{findingId}</span>}
        badge={f && <span className="flex gap-1.5"><CategoryBadge category={f.humanCategory ?? f.category} /><StatusBadge status={f.status} /></span>}
        description={f ? `${f.txn.vendorNorm} · ${idx + 1} of ${ids.length} findings in this run (sorted by risk)` : undefined}
        actions={
          <>
            <Button variant="ghost" size="sm" disabled={idx <= 0} onClick={() => go(ids[idx - 1])}>
              <ChevronUp /> Previous
            </Button>
            <Button variant="ghost" size="sm" disabled={idx < 0 || idx >= ids.length - 1} onClick={() => go(ids[idx + 1])}>
              <ChevronDown /> Next
            </Button>
            <Button variant="secondary" size="sm" onClick={() => navigate(`/runs/${runId}?tab=anomalies&finding=${findingId}`)}>
              <PanelRight /> Open in drawer
            </Button>
          </>
        }
      />
      <FindingDetail key={findingId} findingId={findingId} onNext={() => go(ids[idx + 1])} onPrev={() => go(ids[idx - 1])} />
    </div>
  );
}
