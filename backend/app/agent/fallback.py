"""Deterministic classifier + template explanations — used when AI is disabled/unavailable,
and as the "detector prior" the LLM agent is given. Confidence is capped at 0.6."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from app.core.money import inr
from app.detect.detectors import Sig
from app.matching.score import MTxn

FALLBACK_MODEL = {"name": "deterministic-fallback", "version": "1.0"}


@dataclass
class Verdict:
    category: str
    explanation: str
    evidence_txn_ids: list[str]
    suggested_action: str
    confidence: float
    trace: list[dict] = field(default_factory=list)
    model: dict = field(default_factory=lambda: dict(FALLBACK_MODEL))
    prompt: str | None = None
    response: str | None = None


def prior_category(sigs: list[Sig]) -> str:
    d = {s.detector for s in sigs}
    if "duplicate_detector" in d:
        return "duplicate"
    if "approval_limit" in d or ("weekend_payment" in d and ({"high_value", "new_vendor"} & d)) or ("new_vendor" in d and "round_amount" in d and "high_value" in d):
        return "potential_fraud"
    if "period_boundary" in d:
        return "timing"
    if "amount_mismatch" in d:
        return "unknown"
    if "new_vendor" in d:
        return "unknown"
    return "missing"


def _when(d: date) -> str:
    return d.strftime("%d %b %Y")


def template(t: MTxn, sigs: list[Sig], period_end: date) -> Verdict:
    cat = prior_category(sigs)
    by = {s.detector: s for s in sigs}
    direction = ("debit" if t.amount < 0 else "credit") if t.source == "bank" else ("payment voucher" if t.amount < 0 else "receipt voucher")
    side_other = "ledger" if t.source == "bank" else "bank statement"
    head = f"{'Bank' if t.source == 'bank' else 'Ledger'} {direction} of {inr(t.amount)} on {_when(t.date)} ({t.vendor})"
    evidence: list[str] = []
    for s in sigs:
        for e in s.evidence:
            if e not in evidence:
                evidence.append(e)
    if cat == "duplicate":
        s = by["duplicate_detector"]
        orig = s.evidence[0]
        expl = f"{head} repeats {orig}: {s.text[0].lower() + s.text[1:]}. Only one counterpart exists in the {side_other}, so this is likely a double {'charge' if t.source == 'bank' else 'entry'}."
        action = "Raise a refund / reversal request with the counterparty. Do not book a second expense." if t.source == "bank" else f"Reverse the duplicate ledger voucher {t.reference or t.id}."
        conf = 0.6
    elif cat == "timing":
        s = by["period_boundary"]
        expl = f"{head} has no counterpart in this period, but {s.text[0].lower() + s.text[1:]}. This is a cut-off timing difference that should reverse next period."
        action = "No adjustment needed. Carry forward as a reconciling item; confirm it clears next month."
        conf = 0.6
    elif cat == "potential_fraud":
        reasons = "; ".join(s.text for s in sigs if s.detector != "no_counterpart")
        expl = f"{head} combines several risk signals: {reasons}. No supporting ledger entry was found. This pattern warrants verification before booking."
        action = "Hold further payments to this beneficiary; verify vendor onboarding, the approver and the supporting invoice."
        conf = 0.55
    elif "amount_mismatch" in by:
        s = by["amount_mismatch"]
        expl = f"{head}: {s.text}. Common causes are TDS deducted at source, bank charges netted by the remitter, or a keying/transposition error."
        action = "Confirm the cause with the source documents, then book the difference (TDS payable / bank charges) or correct the voucher."
        conf = 0.5
    elif cat == "unknown":
        expl = f"{head} is with a counterparty that is not in the vendor/customer master and has no {side_other} counterpart. The available data does not identify the purpose."
        action = "Identify the counterparty with the payment initiator and book accordingly, or hold in suspense."
        conf = 0.45
    elif (nc := by.get("no_counterpart")) and nc.details.get("otherAccountTxn"):
        x = nc.details["otherAccountTxn"]
        expl = (f"{head} has no counterpart on the same bank account. {nc.text}. The voucher was most likely posted to the wrong "
                f"bank ledger; once reclassified, it reconciles against {x}.")
        action = f"Reclassify the voucher to the correct bank account ledger; it will then match {x}."
        conf = 0.6
    else:
        nc = by.get("no_counterpart")
        expl = f"{head} has no matching entry in the {side_other}. {nc.text if nc else ''}".strip()
        if t.source == "bank":
            action = "Obtain the supporting document and book the missing ledger entry to the appropriate GL."
        else:
            action = "Check whether the payment/receipt actually went through; reverse or reclassify the voucher if not."
        conf = 0.55
    trace = [{"tool": "detectors", "input": {"txnId": t.id}, "outputSummary": f"{len(sigs)} signal(s): " + ", ".join(s.detector for s in sigs), "ms": 0},
             {"tool": "template_classifier", "input": {"category_prior": cat}, "outputSummary": "AI unavailable or disabled — deterministic template explanation", "ms": 0}]
    return Verdict(cat, expl, evidence, action, min(conf, 0.6), trace)
