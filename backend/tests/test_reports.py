"""Report builder: CSV columns mirror the MSW mock's buildReport(); PDFs are valid for every type."""

import base64
import csv
import io
import os
import re
import shutil
import tempfile
import time

import pytest

_TMP = tempfile.mkdtemp(prefix="reconai-reports-")
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP}/reports.db"

from app.core.config import get_settings  # noqa: E402

get_settings.cache_clear()

from app.db import session as db_session  # noqa: E402
from app.db.init import init_db  # noqa: E402
from app.db.models import FindingRow, PairRow, RunRow, TxnRow  # noqa: E402
from app.reports.builder import build_report  # noqa: E402
from app.services.audit import add_audit  # noqa: E402

RUN = "RUN-T1"
BIG = "RUN-T2"
MONEY = re.compile(r"^-?\d+\.\d{2}$")

LEDGER_HEADER = "match_id,pass,confidence,status,bank_ids,bank_date,bank_description,bank_amount,ledger_ids,ledger_date,ledger_vendor,gl_code,ledger_amount,difference"
AUDIT_HEADER = "id,timestamp,actor_type,actor,action,target,before,after,model_version,ip"
FINDING_HEADER = "finding_id,txn_id,date,description,amount,category,risk,ai_confidence,status,assignee"


def _txn(run_id, tid, source, date, amount, desc, vendor, gl=None, ord_=0):
    return TxnRow(id=tid, run_id=run_id, source=source, date=date, amount=amount, description_raw=desc, vendor_norm=vendor,
                  account_id="ACC-1", gl_code=gl, raw_row={}, ord=ord_)


def _finding(fid, txn_id, category, risk, status, ord_, human_category=None, assignee=None):
    return FindingRow(
        id=fid, run_id=RUN, txn_id=txn_id, category=category, risk_score=risk, confidence=0.87, routing="human_review",
        routing_reason="High value", status=status, model_name="gemini-2.5-flash", model_version="2025-06", ord=ord_,
        explanation=f"Explanation for {fid} with <tags> & ampersands", suggested_action="Confirm with vendor, then post",
        evidence_txn_ids=["L-3", "B-2"], covered_txn_ids=[txn_id], human_category=human_category, assignee=assignee,
        signals=[{"txnId": txn_id, "detector": "amount_outlier", "score": 0.9, "evidenceIds": ["B-2"], "details": {},
                  "humanText": f"Amount is 4.2x the vendor median ({fid})"}],
        agent_trace=[],
    )


@pytest.fixture(scope="module")
def db():
    db_session.reset_engine()
    init_db(use_alembic=False)
    s = db_session.SessionLocal()
    s.add(RunRow(id=RUN, name="Sep 2026 — HDFC current", period="2026-09", status="awaiting_review", created_by="Asha Rao",
                 accounts=["ACC-1"], config={}, stages=[]))
    s.add(RunRow(id=BIG, name="Big run", period="2026-08", status="completed", created_by="Asha Rao"))
    s.flush()
    s.add_all([
        _txn(RUN, "B-1", "bank", "2026-09-03", "1000.00", 'NEFT ACME, LTD "INV-9"', "acme", ord_=1),
        _txn(RUN, "B-2", "bank", "2026-09-04", "-250.50", "UPI CHAI POINT", "chai point", ord_=2),
        _txn(RUN, "B-3", "bank", "2026-09-09", "-4999.9", "IMPS UNKNOWN PAYEE ₹", "unknown payee", ord_=3),
        _txn(RUN, "L-1", "ledger", "2026-09-02", "1000", "Acme sale", "acme", gl="4000 Sales", ord_=4),
        _txn(RUN, "L-2", "ledger", "2026-09-04", "-250.5", "Chai", "chai point", gl="6100", ord_=5),
        _txn(RUN, "L-3", "ledger", "2026-09-20", "-1200.00", "Rent accrual", "landlord", ord_=6),
    ])
    bd = {"amount": 0.4, "date": 0.2, "vendor": 0.25, "reference": 0.1}
    s.add_all([
        PairRow(id="M-1", run_id=RUN, bank_txn_ids=["B-1"], ledger_txn_ids=["L-1"], score=0.95, pass_name="exact", breakdown=bd, status="auto", ord=1),
        PairRow(id="M-2", run_id=RUN, bank_txn_ids=["B-2"], ledger_txn_ids=["L-2"], score=1.0, pass_name="fuzzy", breakdown=bd, status="manual", ord=2),
    ])
    s.add_all([
        _finding("F-1", "B-3", "potential_fraud", 0.82, "open", 1, assignee="Asha Rao"),
        _finding("F-2", "L-3", "missing", 0.4, "approved", 2),
        _finding("F-3", "L-3", "duplicate", 0.61, "escalated", 3, human_category="timing"),
        _finding("F-4", "B-3", "unknown", 0.3, "in_review", 4),
        _finding("F-5", "B-3", "timing", 0.2, "rejected", 5),
    ])
    s.flush()
    add_audit(s, actor_type="system", actor_name="pipeline", action="run.completed", target=RUN, run_id=RUN, ts="2026-09-30T10:00:00.000Z")
    add_audit(s, actor_type="user", actor_name="Asha Rao", action="finding.approve", target="F-2", run_id=RUN,
              before={"status": "open", "score": 1.0}, after={"status": "approved", "note": 'said "ok", fine'},
              ip="10.0.0.1", ts="2026-09-30T11:00:00.000Z")
    add_audit(s, actor_type="ai", actor_name="gemini", action="finding.explain", target="F-1", run_id=RUN, after="explained",
              model_version="gemini-2.5-flash@2025-06", ts="2026-09-30T10:30:00.000Z")
    add_audit(s, actor_type="user", actor_name="Other", action="run.created", target="X", run_id="OTHER")
    # A long run for pagination: 700 unmatched bank rows.
    s.add_all([_txn(BIG, f"B-9{i:04d}", "bank", "2026-08-15", f"{i * 13.37:.2f}", f"Payment number {i} to a long vendor name " * 2,
                    f"vendor {i}", ord_=i) for i in range(700)])
    s.commit()
    yield s
    s.close()
    db_session.reset_engine()
    shutil.rmtree(_TMP, ignore_errors=True)


def _parse(content: str) -> list[list[str]]:
    return list(csv.reader(io.StringIO(content)))


def test_reconciled_ledger_csv(db):
    content, size = build_report(db, RUN, "reconciled_ledger", "csv", False, False, "Asha Rao")
    assert size == len(content)
    assert content.split("\n")[0] == LEDGER_HEADER
    rows = _parse(content)
    h = rows[0]
    data = [dict(zip(h, r, strict=True)) for r in rows[1:]]
    assert [d["match_id"] for d in data] == ["M-1", "M-2", "", ""]
    m1, m2, ub, ul = data
    assert m1["confidence"] == "0.95" and m2["confidence"] == "1"  # JS String(number)
    assert m1["bank_description"] == 'NEFT ACME, LTD "INV-9"'
    assert '"NEFT ACME, LTD ""INV-9"""' in content
    assert m1["bank_amount"] == "1000.00" and m1["ledger_amount"] == "1000.00" and m1["difference"] == "0.00"
    assert m2["ledger_amount"] == "-250.50" and m2["gl_code"] == "6100"
    assert ub["pass"] == "UNMATCHED" and ub["status"] == "potential_fraud" and ub["bank_amount"] == "-4999.90"
    assert ub["ledger_ids"] == "" and ub["confidence"] == ""
    assert ul["status"] == "missing" and ul["ledger_amount"] == "-1200.00" and ul["bank_ids"] == ""
    for d in data:
        for k in ("bank_amount", "ledger_amount", "difference"):
            assert d[k] == "" or MONEY.match(d[k]), (k, d[k])


def test_audit_trail_csv(db):
    content, _ = build_report(db, RUN, "audit_trail", "csv", False, False, "Asha Rao")
    assert content.split("\n")[0] == AUDIT_HEADER
    rows = _parse(content)
    data = [dict(zip(rows[0], r, strict=True)) for r in rows[1:]]
    assert [d["action"] for d in data] == ["finding.approve", "finding.explain", "run.completed"]  # newest first, run-scoped
    approve, explain, completed = data
    assert approve["before"] == '{"status":"open","score":1}'
    assert approve["after"] == '{"status":"approved","note":"said \\"ok\\", fine"}'
    assert approve["ip"] == "10.0.0.1" and approve["actor"] == "Asha Rao" and approve["actor_type"] == "user"
    assert explain["after"] == '"explained"' and explain["before"] == '""'
    assert explain["model_version"] == "gemini-2.5-flash@2025-06"
    assert completed["before"] == '""' and completed["after"] == '""' and completed["ip"] == ""


def test_anomaly_csv_columns(db):
    content, _ = build_report(db, RUN, "anomaly_report", "csv", False, False, "x")
    assert content.split("\n")[0] == FINDING_HEADER
    assert len(_parse(content)) == 6
    content, _ = build_report(db, RUN, "anomaly_report", "csv", True, True, "x")
    rows = _parse(content)
    assert ",".join(rows[0]) == FINDING_HEADER + ",ai_explanation,suggested_action,model,evidence_ids,signals"
    data = [dict(zip(rows[0], r, strict=True)) for r in rows[1:]]
    f1 = data[0]
    assert f1["finding_id"] == "F-1" and f1["amount"] == "-4999.90" and f1["risk"] == "0.82" and f1["ai_confidence"] == "0.87"
    assert f1["assignee"] == "Asha Rao" and f1["model"] == "gemini-2.5-flash@2025-06"
    assert f1["evidence_ids"] == "L-3 B-2" and f1["signals"] == "Amount is 4.2x the vendor median (F-1)"
    assert data[2]["category"] == "timing"  # humanCategory wins
    for d in data:
        assert MONEY.match(d["amount"])
    content, _ = build_report(db, RUN, "anomaly_report", "csv", True, False, "x")
    assert _parse(content)[0][-3:] == ["ai_explanation", "suggested_action", "model"]


def test_unresolved_only_open(db):
    content, _ = build_report(db, RUN, "unresolved_items", "csv", False, True, "x")
    rows = _parse(content)
    assert ",".join(rows[0]) == FINDING_HEADER + ",evidence_ids,signals"
    data = [dict(zip(rows[0], r, strict=True)) for r in rows[1:]]
    assert [d["finding_id"] for d in data] == ["F-1", "F-3", "F-4"]
    assert {d["status"] for d in data} <= {"open", "in_review", "escalated"}


@pytest.mark.parametrize("rtype", ["reconciled_ledger", "anomaly_report", "audit_trail", "unresolved_items"])
@pytest.mark.parametrize("flags", [(False, False), (True, True)])
def test_pdf_every_type(db, rtype, flags):
    content, size = build_report(db, RUN, rtype, "pdf", *flags, "Asha Rao")
    raw = base64.b64decode(content)
    assert raw.startswith(b"%PDF") and raw.rstrip().endswith(b"%%EOF")
    assert size == len(raw)


def test_pdf_paginates_long_ledger(db):
    t = time.perf_counter()
    content, size = build_report(db, BIG, "reconciled_ledger", "pdf", False, False, "Asha Rao")
    elapsed = time.perf_counter() - t
    raw = base64.b64decode(content)
    assert raw.startswith(b"%PDF") and size == len(raw)
    pages = len(re.findall(rb"/Type /Page\b", raw))
    assert pages > 10
    assert elapsed < 20
    csv_content, _ = build_report(db, BIG, "reconciled_ledger", "csv", False, False, "x")
    assert len(csv_content.split("\n")) == 701


def test_empty_and_invalid(db):
    assert build_report(db, BIG, "audit_trail", "csv", False, False, "x") == ("", 0)
    content, _ = build_report(db, BIG, "anomaly_report", "pdf", True, True, "x")
    assert base64.b64decode(content).startswith(b"%PDF")
    with pytest.raises(ValueError):
        build_report(db, RUN, "nope", "csv", False, False, "x")
    with pytest.raises(ValueError):
        build_report(db, RUN, "audit_trail", "xlsx", False, False, "x")
