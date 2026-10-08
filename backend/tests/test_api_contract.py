"""Contract tests: every endpoint's shape matches src/api/types.ts; money is a 2-dp string; errors are
{error, detail: str}; SSE frames use LF-LF; permissions per role; integrity (unexplained → 0.00)."""

import os
import re
import tempfile
from decimal import Decimal
from pathlib import Path

import pytest

_TMP = tempfile.mkdtemp(prefix="reconai-contract-")
os.environ["DATABASE_URL"] = f"sqlite:///{_TMP}/t.db"
os.environ["DATA_DIR"] = f"{_TMP}/data"
os.environ["INLINE_JOBS"] = "true"
os.environ["GEMINI_API_KEY"] = ""  # offline fallback must fully work

from fastapi.testclient import TestClient  # noqa: E402

from app.core.config import get_settings  # noqa: E402
from app.db.session import reset_engine  # noqa: E402

get_settings.cache_clear()
reset_engine()

from app.main import create_app  # noqa: E402

MONEY = re.compile(r"^-?\d+\.\d{2}$")
TS = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Required keys per types.ts (optional props may be omitted).
TXN = {"id", "source", "date", "amount", "descriptionRaw", "vendorNorm", "accountId", "rawRow"}
PAIR = {"id", "bankTxnIds", "ledgerTxnIds", "score", "passName", "breakdown", "status"}
PAIR_VIEW = PAIR | {"bank", "ledger", "dateDiffDays", "vendorSimilarity", "amountDiff"}
SIGNAL = {"txnId", "detector", "score", "evidenceIds", "details", "humanText"}
FINDING = {"id", "runId", "txnId", "category", "riskScore", "signals", "explanation", "evidenceTxnIds", "suggestedAction", "confidence",
           "routing", "status", "agentTrace", "model", "createdAt", "updatedAt"}
FINDING_VIEW = FINDING | {"txn", "runPeriod"}
FINDING_DETAIL = FINDING_VIEW | {"evidence", "vendorHistory", "comments", "history", "impact"}
RUN = {"id", "name", "period", "status", "accounts", "stats", "config", "stages", "createdAt", "createdBy", "review", "categoryCounts", "toleranceDiff"}
STATS = {"bankCount", "ledgerCount", "matched", "unmatchedBank", "unmatchedLedger", "anomalies", "autoMatchRate", "bankTotal", "ledgerTotal", "explained"}
UPLOAD = {"id", "name", "size", "kind", "format", "detectedFormat", "status", "rowCount", "columns", "autoMapped", "previewRows", "warnings"}
AUDIT = {"id", "ts", "actor", "action", "target"}
REPORT = {"id", "runId", "runPeriod", "type", "format", "name", "size", "createdAt", "createdBy", "shareUrl"}
STAGES = ["Ingest", "Normalize", "Match P1", "Match P2", "Match P3", "Detect", "AI Investigate", "Verify", "Done"]
PASSES = {"P1 · Exact", "P2 · Date ±3d", "P3 · Fuzzy vendor", "P4 · Group sum", "P5 · Relaxed re-run", "Manual"}
DETECTORS = {"duplicate_detector", "approval_limit", "new_vendor", "weekend_payment", "high_value", "period_boundary", "amount_outlier",
             "no_counterpart", "amount_mismatch", "round_amount"}


def bank_csv() -> str:
    rows = [
        ("01/09/2026", "NEFT DR-HDFC0000123-ACME TRADERS-INV2041", "4100001", "184500.00", ""),
        ("02/09/2026", "UPI/412345678901/SWIGGY/swiggy@ybl", "4100002", "1240.50", ""),
        ("03/09/2026", "NACH-DR-ZOHO CORP-4471029381", "4100003", "14160.00", ""),
        ("04/09/2026", "RTGS CR-UTIB0000789-FLIPKART INTERNET-88120934", "4100004", "", "742350.00"),
        ("05/09/2026", "NEFT DR-HDFC0000123-BLUEDART EXPRESS-INV2042", "4100005", "9680.00", ""),
        ("04/09/2026", "NACH-DR-ZOHO CORP-4471029388", "4100006", "14160.00", ""),
        ("10/09/2026", "NEFT DR-YESB0000221-NOVA INFRA SOLUTIONS-INV0007", "4100007", "49900.00", ""),
        ("12/09/2026", "IMPS/P2A/612345098712/OFFICEMART", "4100008", "6240.00", ""),
        ("15/09/2026", "NEFT DR-HDFC0000123-MAHINDRA LOGISTICS-INV2050", "4100009", "147000.00", ""),
        ("30/09/2026", "CHRG: NEFT/RTGS CHGS SEP26", "4100010", "1180.00", ""),
        ("30/09/2026", "UPI/412345678999/AWS INDIA/aws@ybl", "4100011", "52310.25", ""),
    ]
    bal = Decimal("1240880.00")
    out = ["Txn Date,Value Date,Description,Ref No,Debit,Credit,Balance"]
    for d, desc, ref, dr, cr in rows:
        bal += Decimal(cr or 0) - Decimal(dr or 0)
        out.append(f"{d},{d},{desc},{ref},{dr},{cr},{bal}")
    return "\n".join(out)


def ledger_csv() -> str:
    rows = [
        ("01-Sep-2026", "Payment", "INV-2041", "ACME Traders Pvt Ltd", "", "184500.00", "5010 Raw Materials", "Raw material purchase"),
        ("02-Sep-2026", "Payment", "PV-09-0301", "Swiggy", "", "1240.50", "6610 Staff Welfare", "Team meals"),
        ("03-Sep-2026", "Payment", "PV-09-0302", "Zoho Corporation", "", "14160.00", "6200 Cloud & Software", "Zoho One"),
        ("04-Sep-2026", "Receipt", "INV-2026-0871", "Flipkart Internet Pvt Ltd", "248000.00", "", "4000 Revenue", "Customer receipt"),
        ("04-Sep-2026", "Receipt", "INV-2026-0875", "Flipkart Internet Pvt Ltd", "312850.00", "", "4000 Revenue", "Customer receipt"),
        ("04-Sep-2026", "Receipt", "INV-2026-0879", "Flipkart Internet Pvt Ltd", "181500.00", "", "4000 Revenue", "Customer receipt"),
        ("05-Sep-2026", "Payment", "INV-2042", "Blue Dart Express", "", "9860.00", "6500 Logistics", "Courier"),
        ("12-Sep-2026", "Payment", "PV-09-0303", "Office Mart Supplies", "", "6240.00", "6800 Office Supplies", "Stationery"),
        ("15-Sep-2026", "Payment", "INV-2050", "Mahindra Logistics", "", "150000.00", "6500 Logistics", "Warehousing"),
        ("21-Sep-2026", "Payment", "PV-09-0304", "Quess Corp", "", "186400.00", "7200 Contract Staff", "Contract staffing"),
        ("29-Sep-2026", "Payment", "PV-09-0305", "Amazon Web Services India", "", "52310.25", "6200 Cloud & Software", "Cloud hosting"),
    ]
    out = ["Voucher Date,Vch Type,Vch No.,Particulars,Ledger,Debit,Credit,Cost Centre,Narration"]
    for d, t, no, p, dr, cr, gl, n in rows:
        out.append(f"{d},{t},{no},{p},ICICI Bank A/c 8834,{dr},{cr},{gl},{n}")
    return "\n".join(out)


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app()) as c:
        yield c


@pytest.fixture(scope="module")
def run(client):
    b = client.post("/api/uploads", files={"file": ("ICICI_Statement_Sep2026.csv", bank_csv(), "text/csv")}, data={"kind": "bank", "accountId": "acc_icici"})
    assert b.status_code == 201, b.text
    l_ = client.post("/api/uploads", files={"file": ("Tally_DayBook_Sep2026.csv", ledger_csv(), "text/csv")}, data={"kind": "ledger"})
    assert l_.status_code == 201, l_.text
    body = {"period": "2026-09", "accounts": ["acc_icici"], "fileIds": [b.json()["id"], l_.json()["id"]],
            "ledgerSource": {"type": "csv", "fileId": l_.json()["id"]}, "config": {}, "maskAccountNumbers": True}
    r = client.post("/api/runs", json=body)
    assert r.status_code == 201, r.text
    run = client.get(f"/api/runs/{r.json()['id']}").json()
    assert run["status"] == "awaiting_review", run
    return run


def assert_money(v):
    assert isinstance(v, str) and MONEY.match(v), v


def assert_error(r, status, code):
    assert r.status_code == status, r.text
    body = r.json()
    assert set(body) == {"error", "detail"} and body["error"] == code and isinstance(body["detail"], str), body


def check_txn(t):
    assert TXN <= set(t), set(t) ^ TXN
    assert t["source"] in ("bank", "ledger") and DATE.match(t["date"])
    assert_money(t["amount"])


# ----------------------------------------------------------------------------- shapes
def test_upload_shapes(client):
    r = client.post("/api/uploads", files={"file": ("x.xlsx", b"PK\x03\x04", "application/octet-stream")}, data={"kind": "bank"})
    assert r.status_code == 422
    assert UPLOAD <= set(r.json()) and r.json()["status"] == "error" and r.json()["error"]
    r = client.post("/api/uploads", files={"file": ("weird.csv", "Posting,Narr,Amt\n1,2,3\n", "text/csv")}, data={"kind": "bank"})
    assert r.status_code == 201 and r.json()["status"] == "needs_mapping" and r.json()["autoMapped"] is False
    r = client.post("/api/uploads", files={"file": ("broken.pdf", b"%PDF-1.4 garbage", "application/pdf")}, data={"kind": "bank"})
    assert r.status_code == 422 and r.json()["status"] == "error"


def test_upload_parsed(client):
    r = client.post("/api/uploads", files={"file": ("ICICI_Statement_Sep2026.csv", bank_csv(), "text/csv")}, data={"kind": "bank"})
    j = r.json()
    assert r.status_code == 201 and j["status"] == "parsed" and j["detectedFormat"] == "ICICI iBizz CSV"
    assert j["rowCount"] == 11 and len(j["previewRows"]) == 11 and j["accountId"] == "acc_icici"
    assert j["sanity"]["ok"] is True
    for k in ("openingBalance", "sumOfTxns", "closingBalance", "computedClosing"):
        assert_money(j["sanity"][k])


def test_run_shape(client, run):
    assert RUN <= set(run) and STATS <= set(run["stats"])
    for k in ("bankTotal", "ledgerTotal", "explained"):
        assert_money(run["stats"][k])
    assert_money(run["toleranceDiff"])
    assert [s["name"] for s in run["stages"]] == STAGES and all(s["state"] == "done" for s in run["stages"])
    assert set(run["categoryCounts"]) == {"duplicate", "missing", "timing", "potential_fraud", "unknown"}
    assert TS.match(run["createdAt"]) and re.match(r"^run_2026_09_[a-z0-9]{4}$", run["id"])
    lst = client.get("/api/runs").json()
    assert lst[0]["id"] == run["id"]


def test_matches(client, run):
    ms = client.get(f"/api/runs/{run['id']}/matches").json()
    assert ms
    for p in ms:
        assert PAIR_VIEW <= set(p) and p["passName"] in PASSES and re.match(r"^M-2609-\d{4}$", p["id"])
        assert set(p["breakdown"]) == {"amount", "date", "vendor", "reference"}
        assert_money(p["amountDiff"])
        for t in p["bank"] + p["ledger"]:
            check_txn(t)
    group = [p for p in ms if p["passName"] == "P4 · Group sum"]
    assert group and len(group[0]["ledgerTxnIds"]) == 3  # Flipkart 1:N


def test_unmatched_and_findings(client, run):
    um = client.get(f"/api/runs/{run['id']}/unmatched").json()
    assert set(um) == {"bank", "ledger"}
    covered = 0
    for item in um["bank"] + um["ledger"]:
        assert {"txn", "signals", "riskScore"} <= set(item)
        check_txn(item["txn"])
        covered += 1 if item.get("findingId") else 0
    assert covered == len(um["bank"]) + len(um["ledger"])  # every unmatched txn is explained by a finding
    fs = client.get(f"/api/runs/{run['id']}/findings").json()
    assert fs
    for f in fs:
        assert FINDING_VIEW <= set(f) and "coveredTxnIds" not in f
        assert re.match(r"^F-2609-\d{3}$", f["id"]) and f["category"] in run["categoryCounts"]
        for s in f["signals"]:
            assert SIGNAL <= set(s) and s["detector"] in DETECTORS and s["humanText"]
        if f["routing"] == "human_review":
            assert f["routingReason"] in ("High value", "Potential fraud", "Low AI confidence", "Unknown category")
        assert f["confidence"] <= 0.6 or f["model"]["name"] == "rules-engine"  # offline fallback cap
    cats = {f["category"] for f in fs}
    assert "duplicate" in cats and "potential_fraud" in cats


def test_finding_detail(client, run):
    fs = client.get(f"/api/runs/{run['id']}/findings").json()
    d = client.get(f"/api/findings/{fs[0]['id']}").json()
    assert FINDING_DETAIL <= set(d)
    assert_money(d["impact"]["contribution"])
    assert_money(d["impact"]["unexplainedBefore"])
    for e in d["evidence"]:
        assert e["relation"] in ("candidate", "duplicate", "vendor_history", "period_boundary") and 0 <= e["similarity"] <= 1
    for h in d["vendorHistory"]:
        assert_money(h["amount"])
    assert d["history"] and AUDIT <= set(d["history"][0])


def test_activity_dashboard_queue_search(client, run):
    a = client.get(f"/api/runs/{run['id']}/activity").json()
    assert a["events"] and {"seq", "ts", "level", "stage", "message"} <= set(a["events"][0]) and a["audit"]
    d = client.get("/api/dashboard").json()
    assert {"runsThisMonth", "autoMatchRate", "openAnomalies", "pendingReviews", "unreconciledAmount", "avgHoursSaved", "trend", "anomaliesByMonth", "attention"} <= set(d)
    assert_money(d["unreconciledAmount"])
    assert len(d["attention"]) <= 5
    q = client.get("/api/review-queue").json()
    assert q and {"finding", "priority", "routingReason", "waitingDays"} <= set(q[0])
    assert [x["priority"] for x in q] == sorted([x["priority"] for x in q], reverse=True)
    s = client.get("/api/search?q=acme").json()
    assert set(s) == {"runs", "txns", "vendors"} and s["vendors"]


def test_sse_frames(client, run):
    with client.stream("GET", f"/api/runs/{run['id']}/events") as r:
        assert r.headers["content-type"].startswith("text/event-stream")
        assert r.headers["cache-control"] == "no-cache" and r.headers["x-accel-buffering"] == "no"
        raw = b"".join(r.iter_bytes()).decode()
    assert "\r\n" not in raw
    frames = [f for f in raw.split("\n\n") if f]
    names = [f.split("\n")[0] for f in frames]
    assert names[0] == "event: log" and names[-1] == "event: done" and "event: stages" in names
    for f in frames:
        ev, data = f.split("\n")
        assert ev.startswith("event: ") and data.startswith("data: ") and "\n" not in data


# ----------------------------------------------------------------------------- errors & permissions
def test_errors(client, run):
    assert_error(client.get("/api/runs/nope"), 404, "not_found")
    assert_error(client.get("/api/findings/F-0000-000"), 404, "not_found")
    assert_error(client.post("/api/runs", json={"period": "2026-09"}), 422, "validation_error")
    assert_error(client.post("/api/runs/x/rerun", json={"dateToleranceDays": "abc"}), 422, "validation_error")
    assert_error(client.post(f"/api/runs/{run['id']}/finalize"), 409, "validation_error")


@pytest.mark.parametrize("role,path,method,body,perm", [
    ("auditor", "/api/runs", "post", {"period": "2026-09", "accounts": ["acc_hdfc"]}, "run.create"),
    ("reviewer", "/api/matches/manual", "post", {"runId": "x", "bankTxnIds": [], "ledgerTxnIds": [], "note": "x"}, "match.manual"),
    ("auditor", "/api/findings/bulk-decision", "post", {"ids": [], "action": "approve"}, "finding.decide"),
    ("reviewer", "/api/rules/PR-1/decision", "post", {"action": "approve"}, "rule.decide"),
    ("reviewer", "/api/rules/R-001", "put", {"enabled": False}, "rule.toggle"),
    ("accountant", "/api/detectors/high_value", "put", {"threshold": 1}, "detector.configure"),
    ("accountant", "/api/settings", "put", {"organization": {"name": "X"}}, "settings.org"),
    ("accountant", "/api/settings", "put", {"ai": {"sendDataToAi": False}}, "settings.ai"),
    ("reviewer", "/api/runs/x/finalize", "post", None, "run.finalize"),
])
def test_permissions(client, role, path, method, body, perm):
    r = getattr(client, method)(path, json=body, headers={"X-Demo-Role": role})
    assert_error(r, 403, "forbidden")
    assert r.json()["detail"] == f"Role '{role}' cannot perform '{perm}'"


def test_notifications_any_role(client):
    r = client.put("/api/settings", json={"notifications": {"slack": True}}, headers={"X-Demo-Role": "auditor"})
    assert r.status_code == 200 and r.json()["notifications"]["slack"] is True


# ----------------------------------------------------------------------------- behaviour
def test_decision_validation(client, run):
    fs = client.get(f"/api/runs/{run['id']}/findings").json()
    fraud = next(f for f in fs if f["category"] == "potential_fraud")
    assert_error(client.post(f"/api/findings/{fraud['id']}/decision", json={"action": "approve"}), 422, "validation_error")
    r = client.post(f"/api/findings/{fraud['id']}/decision", json={"action": "approve"})
    assert r.json()["detail"] == "Resolution notes are required for potential fraud and high-value items."
    other = next(f for f in fs if f["status"] == "open" and f["category"] != "potential_fraud")
    assert_error(client.post(f"/api/findings/{other['id']}/decision", json={"action": "reject", "reason": "no"}), 422, "validation_error")
    assert_error(client.post(f"/api/findings/{other['id']}/decision", json={"action": "change_category"}), 422, "validation_error")
    d = client.post(f"/api/findings/{other['id']}/decision", json={"action": "escalate", "comment": "@Rahul Mehta please check"}).json()
    assert d["status"] == "escalated" and d["assignee"] == "Rahul Mehta"
    assert any(c["mentions"] == ["Rahul Mehta"] for c in d["comments"])
    d = client.post(f"/api/findings/{other['id']}/decision", json={"action": "reopen"}).json()
    assert d["status"] == "open" and [h["action"] for h in d["history"]][-2:] == ["finding.escalate", "finding.undo"]
    c = client.post(f"/api/findings/{other['id']}/comments", json={"body": "Looked into it"})
    assert c.status_code == 201 and {"id", "author", "body", "createdAt", "mentions"} <= set(c.json())


def test_rules_and_detectors(client, run):
    rules = client.get("/api/rules").json()
    assert {"active", "proposed", "detectors", "versions"} == set(rules)
    assert {d["id"] for d in rules["detectors"]} >= DETECTORS - {"amount_mismatch"}
    r = client.put("/api/rules/R-009", json={"enabled": True}).json()
    assert r["enabled"] is True and r["version"] == 2
    t = client.post("/api/detectors/approval_limit/test", json={"runId": run["id"], "threshold": 0.5, "weight": 1, "enabled": True}).json()
    assert {"flaggedNow", "flaggedAfter", "newlyFlagged", "cleared", "routedToReviewDelta", "sample"} == set(t)
    assert t["flaggedAfter"] >= t["flaggedNow"]
    off = client.post("/api/detectors/approval_limit/test", json={"runId": run["id"], "threshold": 0.02, "weight": 1, "enabled": False}).json()
    assert off["flaggedAfter"] == 0 and off["cleared"] == off["flaggedNow"]
    d = client.put("/api/detectors/round_amount", json={"weight": 0.2}).json()
    assert d["weight"] == 0.2
    client.put("/api/rules/R-009", json={"enabled": False})
    for p in rules["proposed"]:
        assert {"id", "runId", "title", "description", "scope", "params", "supportingTxnIds", "supportingTxns", "simulation", "confidence", "status", "model"} <= set(p)


def test_full_resolution_reaches_zero_and_finalize(client, run):
    rid = run["id"]
    # relaxed re-run picks up the amount mismatches
    rr = client.post(f"/api/runs/{rid}/rerun", json={"dateToleranceDays": 3, "amountTolerance": "5000.00", "vendorThreshold": 0.8})
    assert rr.status_code == 200 and rr.json()["matchesGained"] >= 1
    ms = client.get(f"/api/runs/{rid}/matches").json()
    assert any(p["passName"] == "P5 · Relaxed re-run" for p in ms)
    # unmatch + manual re-match round-trip
    pair = next(p for p in ms if p["passName"] == "P1 · Exact")
    assert_error(client.post(f"/api/matches/{pair['id']}/unmatch", json={"runId": rid, "reason": "no"}), 422, "validation_error")
    assert client.post(f"/api/matches/{pair['id']}/unmatch", json={"runId": rid, "reason": "wrong pairing"}).json() == {"ok": True}
    m = client.post("/api/matches/manual", json={"runId": rid, "bankTxnIds": pair["bankTxnIds"], "ledgerTxnIds": pair["ledgerTxnIds"], "note": "Re-matched after review"})
    assert m.status_code == 201 and m.json()["status"] == "manual" and m.json()["passName"] == "Manual"
    assert_error(client.post("/api/matches/manual", json={"runId": rid, "bankTxnIds": pair["bankTxnIds"], "ledgerTxnIds": pair["ledgerTxnIds"], "note": "again!"}), 409, "validation_error")
    # bulk approve skips fraud / high value
    fs = client.get(f"/api/runs/{rid}/findings").json()
    open_ids = [f["id"] for f in fs if f["status"] in ("open", "in_review", "escalated")]
    n = client.post("/api/findings/bulk-decision", json={"ids": open_ids, "action": "approve"}).json()["updated"]
    fs = client.get(f"/api/runs/{rid}/findings").json()
    left = [f for f in fs if f["status"] in ("open", "in_review", "escalated")]
    assert n >= 1 and all(f["category"] == "potential_fraud" or abs(Decimal(f["txn"]["amount"])) >= 500000 for f in left)
    for f in left:
        assert client.post(f"/api/findings/{f['id']}/decision", json={"action": "approve", "reason": "Verified with procurement"}).status_code == 200
    run_after = client.get(f"/api/runs/{rid}").json()
    s = run_after["stats"]
    assert Decimal(s["bankTotal"]) - Decimal(s["ledgerTotal"]) - Decimal(s["explained"]) == 0
    fin = client.post(f"/api/runs/{rid}/finalize")
    assert fin.status_code == 200 and fin.json()["status"] == "completed"
    # reports for a finished run
    for typ, fmt in [("reconciled_ledger", "csv"), ("anomaly_report", "pdf"), ("audit_trail", "csv"), ("unresolved_items", "csv")]:
        rep = client.post("/api/reports", json={"runId": rid, "type": typ, "format": fmt, "includeAiExplanations": True, "includeEvidence": True})
        assert rep.status_code == 201, rep.text
        j = rep.json()
        assert REPORT <= set(j) and (j["content"] or typ == "unresolved_items") and re.match(r"^RP-\d+$", j["id"])
        assert j["name"] == f"{typ.replace('_', '-')}-2026-09.{fmt}" and j["shareUrl"].startswith("http://localhost:8000/s/")
    lst = client.get("/api/reports").json()
    assert lst and "content" not in lst[0]
    pdf = next(x for x in lst if x["format"] == "pdf")
    dl = client.get(f"/api/reports/{pdf['id']}/download").json()
    assert dl["content"]
    share = client.get("/s/" + pdf["shareUrl"].rsplit("/", 1)[1])
    assert share.status_code == 200 and share.content.startswith(b"%PDF")


def test_audit_filters_and_chain(client, run):
    all_ = client.get("/api/audit").json()
    assert all_ and AUDIT <= set(all_[0]) and TS.match(all_[0]["ts"])
    assert [a["ts"] for a in all_] == sorted([a["ts"] for a in all_], reverse=True)
    ai = client.get("/api/audit?actor=ai,system").json()
    assert ai and all(a["actor"]["type"] in ("ai", "system") for a in ai)
    q = client.get(f"/api/audit?q=finding.approve&runId={run['id']}").json()
    assert q and all(a["runId"] == run["id"] for a in q)
    assert client.get("/api/audit/verify").json()["ok"] is True


def test_audit_append_only():
    import sqlalchemy as sa

    from app.db.session import engine

    with pytest.raises(sa.exc.DBAPIError), engine().begin() as c:
        c.execute(sa.text("DELETE FROM audit_log"))


def test_samples_dir_safe(client):
    r = client.get("/api/samples/..%2F..%2Fetc%2Fpasswd")
    assert r.status_code == 404


def test_tmp_cleanup():
    assert Path(_TMP).exists()
