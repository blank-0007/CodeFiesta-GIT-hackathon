import { Sparkles } from "lucide-react";
import { useRules } from "@/api/queries";
import { EmptyState, ErrorState, SkeletonRows } from "@/components/shared/misc";
import { ProposedRuleCard } from "./ProposedRuleCard";

export function RunRulesTab({ runId }: { runId: string }) {
  const { data, isLoading, error, refetch } = useRules();
  if (isLoading) return <div className="card"><SkeletonRows rows={5} cols={2} /></div>;
  if (error) return <ErrorState error={error} onRetry={() => refetch()} />;
  const rules = data?.proposed.filter((r) => r.runId === runId) ?? [];
  if (!rules.length)
    return (
      <div className="card">
        <EmptyState icon={Sparkles} title="No rule proposals for this run" description="When the agent notices a repeatable pattern (e.g. a vendor that always posts late), it proposes a rule here for your approval." />
      </div>
    );
  return (
    <div className="space-y-4">
      {rules.map((r) => <ProposedRuleCard key={r.id} rule={r} />)}
    </div>
  );
}
