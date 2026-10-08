"""Reference data: settings, detectors and rules (mirrors seedSettings/seedDetectors/seedRules in seed.ts)."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db.models import DetectorRow, RuleRow, SettingsRow

DEFAULT_SETTINGS = {
    "organization": {
        "name": "Acme Manufacturing Pvt Ltd",
        "accounts": [
            {"id": "acc_hdfc", "name": "HDFC Bank Current A/c", "bank": "HDFC Bank", "last4": "4521", "parserTemplate": "HDFC PDF v3", "currency": "INR"},
            {"id": "acc_icici", "name": "ICICI Bank Current A/c", "bank": "ICICI Bank", "last4": "8834", "parserTemplate": "ICICI CSV (iBizz)", "currency": "INR"},
        ],
        "connector": {"type": "csv", "provider": "Tally Prime", "status": "connected"},
        "approvalLimit": "50000.00",
        "highValueThreshold": "500000.00",
    },
    "ai": {
        "provider": "gemini",
        "defaultModel": "gemini-2.5-flash",
        "escalationModel": "gemini-2.5-pro",
        "sendDataToAi": True,
        "maskAccountNumbers": True,
        "maskPersonalNames": False,
        "retentionDays": 30,
        "estCostPerRun": "0.00",
    },
    "notifications": {"email": True, "slack": False, "slackChannel": "#finance-close", "digest": "daily"},
}

DETECTORS = [
    ("duplicate_detector", "Duplicate detector", "Flags transactions with identical amount and counterparty within a time window.", "Two ₹18,450 NEFT debits to Blue Dart one day apart.", 0.8, 1),
    ("approval_limit", "Just-below approval limit", "Flags payments within X% below the approval limit — a common way to avoid second-level approval.", "₹49,900 when the limit is ₹50,000.", 0.02, 1),
    ("new_vendor", "New vendor", "Flags payments to vendors first seen within N days.", "Vendor created 3 days before a ₹49,900 payment.", 30, 0.9),
    ("weekend_payment", "Weekend / off-hours payment", "Flags payments initiated on weekends or outside treasury hours.", "₹8.75L RTGS initiated on a Sunday.", 0.5, 0.8),
    ("high_value", "High value", "Flags transactions above the high-value threshold.", "Any item > ₹5,00,000.", 500000, 0.7),
    ("period_boundary", "Period boundary", "Looks for counterparts just across the cut-off date (timing differences).", "Cheque issued 30 Sep, cleared 3 Oct.", 5, 0.5),
    ("amount_outlier", "Amount outlier", "Flags amounts more than k standard deviations from the vendor's history.", "₹2.4L to a vendor whose median is ₹18K.", 3, 0.6),
    ("round_amount", "Round amount", "Flags suspiciously round amounts on vendor payments.", "₹50,000.00 to a logistics vendor.", 0.5, 0.3),
    ("no_counterpart", "No counterpart", "Baseline signal for any item with no candidate on the other side.", "Bank charge with no ledger entry.", 0.5, 0.5),
]

RULES = [
    ("R-001", "Exact amount + date + reference", "Pass 1: match when amount, value date and reference agree exactly.", "global", None, {"pass": 1, "dateToleranceDays": 0, "amountTolerance": "0.00"}, True, {"type": "human", "name": "Rahul Mehta"}),
    ("R-002", "Date tolerance ±3 business days", "Pass 2: allow posting-date lag of up to 3 business days.", "global", None, {"pass": 2, "dateToleranceDays": 3, "amountTolerance": "1.00"}, True, {"type": "human", "name": "Rahul Mehta"}),
    ("R-003", "Fuzzy vendor ≥ 55%", "Pass 3: fuzzy vendor similarity with amount exact and date ±3d.", "global", None, {"pass": 3, "vendorThreshold": 0.55}, True, {"type": "human", "name": "Rahul Mehta"}),
    ("R-004", "Group-sum matching (1:N, N:1)", "Match one bank txn to up to 25 ledger lines whose sum is exact (payroll, settlements).", "global", None, {"maxGroupSize": 25, "dateToleranceDays": 2}, True, {"type": "human", "name": "Priya Sharma"}),
    ("R-005", "Mahindra Logistics posts ~2 days late", "Vendor-specific date tolerance of 5 days.", "vendor", "Mahindra Logistics", {"dateToleranceDays": 5}, True, {"type": "ai", "name": "gemini-2.5-flash"}),
    ("R-006", "Razorpay settlement alias", "Treat 'RZP SETTLEMENT' as Razorpay Software.", "vendor", "Razorpay Software", {"aliases": ["RZP SETTLEMENT"]}, True, {"type": "ai", "name": "gemini-2.5-flash"}),
    ("R-007", "ICICI CSV amount precision", "ICICI CSV exports round to 2 dp; allow ₹0.01 tolerance on this account.", "account", "ICICI ••8834", {"amountTolerance": "0.01"}, True, {"type": "human", "name": "Priya Sharma"}),
    ("R-008", "USD-billed cloud: ₹1 FX tolerance", "Allow up to ₹1.00 difference on AWS & Google Cloud due to FX rounding.", "vendor", "Amazon Web Services India", {"amountTolerance": "1.00"}, True, {"type": "ai", "name": "gemini-2.5-flash"}),
    ("R-009", "Weekend payment hold", "Never auto-match RTGS payments initiated on weekends.", "global", None, {"channel": "RTGS", "weekdays": ["Sat", "Sun"], "action": "route_to_review"}, False, {"type": "human", "name": "Rahul Mehta"}),
]


def ensure_reference_data(db: Session) -> None:
    if not db.get(SettingsRow, 1):
        db.add(SettingsRow(id=1, data=DEFAULT_SETTINGS))
    if not db.execute(select(DetectorRow.id).limit(1)).first():
        for i, (did, name, desc, ex, thr, w) in enumerate(DETECTORS):
            db.add(DetectorRow(id=did, name=name, description=desc, example=ex, enabled=True, threshold=thr, weight=w, ord=i))
    if not db.execute(select(RuleRow.id).limit(1)).first():
        for rid, name, desc, scope, sv, params, enabled, by in RULES:
            db.add(RuleRow(id=rid, name=name, description=desc, scope=scope, scope_value=sv, params=params, enabled=enabled,
                           created_by=by, hit_count=0, version=1))
    db.commit()
