import { cn } from "@/lib/utils";

type Line = { kind: "same" | "add" | "del"; text: string };

function toLines(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  return JSON.stringify(v, null, 2).split("\n");
}

/** Simple LCS line diff — good enough for small JSON objects. */
export function diffLines(a: string[], b: string[]): Line[] {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: "del", text: a[i++] });
    else out.push({ kind: "add", text: b[j++] });
  }
  while (i < n) out.push({ kind: "del", text: a[i++] });
  while (j < m) out.push({ kind: "add", text: b[j++] });
  return out;
}

export function DiffView({
  before,
  after,
  className,
  label = "Changes",
}: {
  before: unknown;
  after: unknown;
  className?: string;
  label?: string;
}) {
  const lines = diffLines(toLines(before), toLines(after));
  if (!lines.length) return <p className="text-xs text-muted-foreground">No data</p>;
  return (
    <pre
      aria-label={label}
      className={cn("num overflow-x-auto rounded-md border bg-background p-2 text-2xs leading-5", className)}
    >
      {lines.map((l, idx) => (
        <div
          key={idx}
          className={cn(
            "whitespace-pre px-1",
            l.kind === "add" && "bg-ok/10 text-ok",
            l.kind === "del" && "bg-crit/10 text-crit",
          )}
        >
          <span aria-hidden className="mr-2 inline-block w-3 select-none opacity-70">
            {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
          </span>
          <span className="sr-only">{l.kind === "add" ? "added: " : l.kind === "del" ? "removed: " : ""}</span>
          {l.text}
        </div>
      ))}
    </pre>
  );
}
