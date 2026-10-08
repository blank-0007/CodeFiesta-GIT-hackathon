"""Loading run data + id generation."""

from __future__ import annotations

import re
import secrets
import string
from dataclasses import dataclass, field

from sqlalchemy import func, select
from sqlalchemy.orm import Session, defer

from app.core.errors import not_found
from app.db.models import FindingRow, PairRow, ProposedRuleRow, ReportRow, RuleRow, RunRow, SettingsRow, TxnRow


@dataclass
class RunData:
    run: RunRow
    txns: dict[str, TxnRow] = field(default_factory=dict)  # in-period, insertion (ord) order
    external: dict[str, TxnRow] = field(default_factory=dict)
    bank_ids: list[str] = field(default_factory=list)
    ledger_ids: list[str] = field(default_factory=list)
    pairs: list[PairRow] = field(default_factory=list)
    findings: list[FindingRow] = field(default_factory=list)

    def txn_of(self, tid: str) -> TxnRow | None:
        return self.txns.get(tid) or self.external.get(tid)

    def matched_ids(self) -> set[str]:
        s: set[str] = set()
        for p in self.pairs:
            s.update(p.bank_txn_ids)
            s.update(p.ledger_txn_ids)
        return s

    def finding_for(self, txn_id: str) -> FindingRow | None:
        for f in self.findings:
            if txn_id in (f.covered_txn_ids or []):
                return f
        return None


def get_run(db: Session, run_id: str) -> RunRow:
    run = db.get(RunRow, run_id)
    if not run:
        raise not_found("Run")
    return run


def load_run(db: Session, run: RunRow | str, *, lite: bool = False) -> RunData:
    if isinstance(run, str):
        run = get_run(db, run)
    rd = RunData(run=run)
    q = select(TxnRow).where(TxnRow.run_id == run.id).order_by(TxnRow.ord, TxnRow.pk)
    if lite:
        q = q.options(defer(TxnRow.raw_row))
    for t in db.execute(q).scalars():
        if t.external:
            rd.external[t.id] = t
            continue
        rd.txns[t.id] = t
        (rd.bank_ids if t.source == "bank" else rd.ledger_ids).append(t.id)
    rd.pairs = list(db.execute(select(PairRow).where(PairRow.run_id == run.id).order_by(PairRow.ord, PairRow.created_at)).scalars())
    rd.findings = list(db.execute(select(FindingRow).where(FindingRow.run_id == run.id).order_by(FindingRow.ord, FindingRow.id)).scalars())
    return rd


def settings_data(db: Session) -> dict:
    row = db.get(SettingsRow, 1)
    return dict(row.data) if row else {}


# ----------------------------------------------------------------------------- ids
_RAND = string.ascii_lowercase + string.digits


def rand(n: int) -> str:
    return "".join(secrets.choice(_RAND) for _ in range(n))


def _max_suffix(ids: list[str], prefix: str) -> int:
    best = 0
    pat = re.compile(re.escape(prefix) + r"(\d+)$")
    for i in ids:
        m = pat.match(i or "")
        if m:
            best = max(best, int(m.group(1)))
    return best


def next_txn_seq(db: Session, prefix: str) -> int:
    """prefix like 'B-2609-' — numbering continues across runs so ids are globally unique."""
    ids = list(db.execute(select(TxnRow.id).where(TxnRow.id.like(prefix + "%"))).scalars())
    return _max_suffix(ids, prefix)


def next_pair_seq(db: Session, prefix: str) -> int:
    ids = list(db.execute(select(PairRow.id).where(PairRow.id.like(prefix + "%"))).scalars())
    return _max_suffix(ids, prefix)


def next_finding_seq(db: Session, prefix: str) -> int:
    ids = list(db.execute(select(FindingRow.id).where(FindingRow.id.like(prefix + "%"))).scalars())
    return _max_suffix(ids, prefix)


def next_proposed_seq(db: Session, prefix: str) -> int:
    ids = list(db.execute(select(ProposedRuleRow.id).where(ProposedRuleRow.id.like(prefix + "%"))).scalars())
    return _max_suffix(ids, prefix)


def next_rule_id(db: Session) -> str:
    ids = list(db.execute(select(RuleRow.id)).scalars())
    return f"R-{_max_suffix(ids, 'R-') + 1:03d}"


def next_report_id(db: Session) -> str:
    ids = list(db.execute(select(ReportRow.id)).scalars())
    return f"RP-{max(_max_suffix(ids, 'RP-'), 99) + 1}"


def ym(period: str) -> str:
    y, m = period.split("-")
    return f"{y[2:]}{m}"


def count_runs(db: Session) -> int:
    return db.scalar(select(func.count()).select_from(RunRow)) or 0
