"""Run orchestration: Ingest → Normalize → Match P1/P2/P3 → Detect → AI Investigate → Verify → Done.

Deterministic stages run in a worker thread (asyncio.to_thread) so the event loop keeps serving SSE;
the AI stage is natively async (concurrency-limited). Progress is written to the DB as RunEvents and
stage states, which the SSE endpoint streams.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from sqlalchemy import select

from app.agent import proposals as proposal_miner
from app.agent.fallback import FALLBACK_MODEL, Verdict, prior_category, template
from app.agent.gemini import AiUnavailable, GeminiAgent
from app.agent.tools import Snapshot
from app.core.config import get_settings
from app.core.money import ZERO, D, fmt, inr
from app.db.models import (
    AiCacheRow,
    DetectorRow,
    EventRow,
    FindingRow,
    PairRow,
    ProposedRuleRow,
    RuleRow,
    RunRow,
    TxnRow,
    UploadRow,
    utcnow,
)
from app.db.session import session_scope
from app.detect.detectors import (
    DetectContext,
    DetectorCfg,
    Sig,
    cross_account,
    month_bounds,
    noisy_or,
    run_detectors,
    weighted,
)
from app.ingest.parsers import CanonRow, mapping_complete, resolve_mapping, to_canonical
from app.matching.engine import P4, Matcher, PassSpec, default_passes
from app.matching.rules import Compiled, compile_rules
from app.matching.score import MTxn
from app.normalize.fuzzy import js_round
from app.normalize.vendors import VendorResolver, channel_of, extract_counterparty, title_case, unique
from app.services.audit import add_audit
from app.services.repo import next_finding_seq, next_pair_seq, next_proposed_seq, next_txn_seq, settings_data, ym

log = logging.getLogger("reconai.pipeline")

STAGES = ["Ingest", "Normalize", "Match P1", "Match P2", "Match P3", "Detect", "AI Investigate", "Verify", "Done"]


class PipelineError(Exception):
    pass


@dataclass
class Candidate:
    txn: MTxn
    sigs: list[Sig]
    covered: list[str]
    verdict: Verdict | None = None
    rule_id: str | None = None


@dataclass
class State:
    run_id: str
    period: str = ""
    created_by: str = ""
    accounts: list[str] = field(default_factory=list)
    config: dict = field(default_factory=dict)
    request: dict = field(default_factory=dict)
    settings: dict = field(default_factory=dict)
    rows: list[tuple[str, CanonRow, str, int | None, str]] = field(default_factory=list)  # side, row, file, page, account
    openings: dict[str, Decimal] = field(default_factory=dict)
    txns: dict[str, MTxn] = field(default_factory=dict)
    external: list[MTxn] = field(default_factory=list)
    compiled: Compiled | None = None
    matcher: Matcher | None = None
    candidates: list[Candidate] = field(default_factory=list)
    ctx: DetectContext | None = None
    proposals: list[dict] = field(default_factory=list)
    usage: dict = field(default_factory=dict)
    ai_note: str | None = None
    rule_hits: dict[str, int] = field(default_factory=dict)
    ledger_rows: int = 0
    ledger_unlabeled: int = 0  # ledger rows whose bank account was guessed (no Ledger/account column)


# ----------------------------------------------------------------------------- progress helpers
def emit(run_id: str, level: str, stage: str, message: str) -> None:
    with session_scope() as db:
        last = db.execute(select(EventRow.seq).where(EventRow.run_id == run_id).order_by(EventRow.seq.desc()).limit(1)).scalar()
        db.add(EventRow(run_id=run_id, seq=(last or 0) + 1, ts=utcnow(), level=level, stage=stage, message=message))


def set_stage(run_id: str, name: str, state: str, count: int | None = None, ms: int | None = None, status: str | None = None) -> None:
    with session_scope() as db:
        run = db.get(RunRow, run_id)
        stages = [dict(s) for s in (run.stages or [])]
        for s in stages:
            if s["name"] == name:
                s["state"] = state
                if count is not None:
                    s["count"] = count
                if ms is not None:
                    s["ms"] = ms
        run.stages = stages
        if status:
            run.status = status


# ----------------------------------------------------------------------------- stages
def stage_ingest(st: State) -> int:
    with session_scope() as db:
        run = db.get(RunRow, st.run_id)
        st.period, st.accounts, st.config, st.request = run.period, list(run.accounts), dict(run.config), dict(run.request or {})
        st.created_by = run.created_by
        st.settings = settings_data(db)
        file_ids = list(run.file_ids or [])
        if not file_ids:
            raise PipelineError("No files were provided for this run")
        ls = st.request.get("ledgerSource") or {}
        if ls.get("type") == "api":
            raise PipelineError(f"Ledger connector '{ls.get('connector')}' is not configured on this server — upload the ledger export as CSV instead")
        accts = st.settings["organization"]["accounts"]
        user_maps = st.request.get("columnMapping") or {}
        sign = st.request.get("signConvention")
        kinds = set()
        for fid in file_ids:
            up = db.get(UploadRow, fid)
            if not up:
                raise PipelineError(f"Upload {fid} not found")
            meta = up.meta
            if meta.get("status") == "error":
                raise PipelineError(f"{meta['name']}: {meta.get('error') or 'could not be parsed'}")
            m = None
            if fid in user_maps:
                m = resolve_mapping(user_maps[fid], up.columns)
            if not m:
                for um in user_maps.values():  # client-local keys: match by header set
                    cand = resolve_mapping(um, up.columns)
                    if cand and mapping_complete(cand) and len(cand) == len([v for v in um.values() if v]):
                        m = cand
                        break
            if not m or not mapping_complete(m):
                m = up.mapping
            if not m or not mapping_complete(m):
                raise PipelineError(f"{meta['name']} needs a column mapping (date, description and amount or debit+credit)")
            meta_rows = [{k: v for k, v in r.items() if k.startswith("_")} for r in up.rows]
            clean_rows = [{k: v for k, v in r.items() if not k.startswith("_")} for r in up.rows]
            canon = to_canonical(clean_rows, m, up.detected, sign, meta_rows)
            kinds.add(up.kind)
            default_acct = meta.get("accountId") or _guess_account(meta["name"], accts) or (st.accounts[0] if st.accounts else accts[0]["id"])
            if up.kind == "bank" and meta.get("sanity"):
                st.openings[default_acct] = D(meta["sanity"]["openingBalance"])
                if not meta["sanity"].get("ok", True):
                    emit(st.run_id, "warn", "Ingest", f"{meta['name']}: balance sanity check failed — {meta['sanity'].get('explanation', '')}")
            n = 0
            for c in canon:
                acct = default_acct
                labeled = False
                if c.account_label and (la := _account_from_label(c.account_label, accts)):
                    acct, labeled = la, True
                if acct not in st.accounts:
                    if up.kind == "ledger":
                        continue  # ledger rows for other bank accounts are out of scope
                    acct = st.accounts[0]
                if up.kind == "ledger":
                    st.ledger_rows += 1
                    st.ledger_unlabeled += 0 if labeled else 1
                page = c.raw.get("_page")
                st.rows.append((up.kind, c, meta["name"], page, acct))
                n += 1
            fmt_label = meta.get("detectedFormat", up.detected)
            emit(st.run_id, "info", "Ingest", f"Parsed {n} {up.kind} rows from {meta['name']} ({fmt_label})")
            for w in meta.get("warnings", []):
                emit(st.run_id, "warn", "Ingest", f"{meta['name']}: {w['message']}")
        if "bank" not in kinds:
            raise PipelineError("At least one bank statement is required")
        if "ledger" not in kinds:
            raise PipelineError("A ledger export is required")
    return len(st.rows)


def _guess_account(name: str, accts: list[dict]) -> str | None:
    up = name.upper()
    for a in accts:
        if a["bank"].split()[0].upper() in up or a["last4"] in up:
            return a["id"]
    return None


def _account_from_label(label: str, accts: list[dict]) -> str | None:
    for a in accts:
        if a["last4"] in label or a["bank"].split()[0].upper() in label.upper():
            return a["id"]
    return None


def stage_normalize(st: State) -> int:
    start, end = month_bounds(st.period)
    accts = {a["id"]: a for a in st.settings["organization"]["accounts"]}
    with session_scope() as db:
        rules = list(db.execute(select(RuleRow)).scalars())
        st.compiled = compile_rules(rules, st.config, list(accts.values()))
        # Every ledger line names its bank ledger -> reconcile per account (a voucher booked against the
        # wrong bank GL surfaces as a finding instead of silently matching the other statement).
        st.compiled.ruleset.same_account = st.ledger_rows > 0 and st.ledger_unlabeled == 0
        hist_ledger_vendors = set(db.execute(
            select(TxnRow.vendor_norm).join(RunRow, RunRow.id == TxnRow.run_id)
            .where(TxnRow.source == "ledger", RunRow.status.in_(["completed", "awaiting_review"]), RunRow.id != st.run_id)
        ).scalars())
    ledger_names = unique([c.vendor for side, c, *_ in st.rows if side == "ledger" and c.vendor])
    resolver = VendorResolver(master=unique(ledger_names + sorted(hist_ledger_vendors)), aliases=st.compiled.aliases)

    def vendor_for(side: str, c: CanonRow, acct: str) -> str:
        if side == "ledger" and c.vendor:
            return c.vendor.strip()
        bank_name = accts.get(acct, {}).get("bank", "Bank")
        return resolver.resolve(c.description, extract_counterparty(c.description, bank_name))

    # Stable order: side, date, file order
    indexed = list(enumerate(st.rows))
    indexed.sort(key=lambda x: (x[1][0] != "bank", x[1][1].date, x[0]))
    prefix_next: dict[str, int] = {}
    built: list[tuple[MTxn, CanonRow, str, int | None, bool]] = []
    with session_scope() as db:
        for _, (side, c, fname, page, acct) in indexed:
            ext = not (start <= c.date <= end)
            p = f"{'B' if side == 'bank' else 'L'}-{c.date.strftime('%y%m') if ext else ym(st.period)}-"
            if p not in prefix_next:
                prefix_next[p] = next_txn_seq(db, p)
            prefix_next[p] += 1
            tid = f"{p}{prefix_next[p]:04d}"
            v = vendor_for(side, c, acct)
            t = MTxn(tid, side, c.date, c.amount, v, c.description, c.reference, acct, channel_of(c.description) if side == "bank" else None)
            built.append((t, c, fname, page, ext))
        for i, (t, c, fname, page, ext) in enumerate(built):
            if ext:
                st.external.append(t)
            else:
                st.txns[t.id] = t
            db.add(TxnRow(
                id=t.id, run_id=st.run_id, source=t.source, date=t.date.isoformat(), amount=fmt(t.amount), description_raw=c.description,
                vendor_norm=t.vendor, reference=c.reference, account_id=t.account_id, gl_code=c.gl, source_file=fname,
                source_page=int(page) if page else None, raw_row={k: v for k, v in c.raw.items()}, external=ext, ord=i,
            ))
    for rid, n in resolver.hits.items():
        st.rule_hits[rid] = st.rule_hits.get(rid, 0) + n
    n_alias = len({t.vendor for t in st.txns.values() if t.source == "bank"})
    emit(st.run_id, "info", "Normalize", f"Normalized {len(st.txns)} transactions ({len(st.external)} outside the period kept as evidence); {n_alias} counterparties resolved")
    if st.config.get("maskAccountNumbers", True) or st.settings["ai"].get("maskAccountNumbers"):
        emit(st.run_id, "info", "Normalize", "Account numbers masked before AI analysis")
    return len(st.txns)


def _specs(st: State) -> list[PassSpec]:
    specs = default_passes(st.compiled.config)
    for s in specs:
        if s.kind == "group":
            s.max_group = st.compiled.max_group
    return specs


def stage_match(st: State, which: str) -> int:
    if st.matcher is None:
        st.matcher = Matcher([t for t in st.txns.values() if t.source == "bank"], [t for t in st.txns.values() if t.source == "ledger"], st.compiled.ruleset)
        if st.matcher.held:
            emit(st.run_id, "warn", "Match P1", f"{len(st.matcher.held)} weekend RTGS payment(s) held for review by rule")
    specs = _specs(st)
    made = 0
    pr = st.compiled.ruleset.pass_rules
    if which == "P1":
        for s in specs:
            if s.kind == "exact":
                n = st.matcher.run_pass(s)
                made += n
                if pr.get(1):
                    st.rule_hits[pr[1]] = st.rule_hits.get(pr[1], 0) + n
        emit(st.run_id, "info", "Match P1", f"Pass 1 (exact amount + date): {made} pairs")
    elif which == "P2":
        g = 0
        for s in specs:
            if s.kind == "date":
                n = st.matcher.run_pass(s)
                made += n
                if pr.get(2):
                    st.rule_hits[pr[2]] = st.rule_hits.get(pr[2], 0) + n
        for s in specs:
            if s.kind == "group":
                g += st.matcher.run_pass(s)
        made += g
        emit(st.run_id, "info", "Match P2", f"Pass 2 (date ±{next((s.date_tol for s in specs if s.kind == 'date'), 3)}d): {made - g} pairs; group-sum (1:N / N:1): {g} groups")
    else:
        for s in specs:
            if s.kind in ("fuzzy", "relaxed"):
                n = st.matcher.run_pass(s)
                made += n
                if s.kind == "fuzzy" and pr.get(3):
                    st.rule_hits[pr[3]] = st.rule_hits.get(pr[3], 0) + n
        vthr = next((s.vendor_threshold for s in specs if s.kind == "fuzzy"), 0.55)
        emit(st.run_id, "info", "Match P3", f"Pass 3 (fuzzy vendor ≥ {round(vthr * 100)}%): {made} pairs")
        _persist_pairs(st)
    return made


def _persist_pairs(st: State) -> None:
    res = st.matcher.result()
    for rid, n in res.hits.items():
        st.rule_hits[rid] = st.rule_hits.get(rid, 0) + n
    with session_scope() as db:
        prefix = f"M-{ym(st.period)}-"
        seq = next_pair_seq(db, prefix)
        for i, p in enumerate(res.pairs):
            seq += 1
            db.add(PairRow(id=f"{prefix}{seq:04d}", run_id=st.run_id, bank_txn_ids=[t.id for t in p.bank], ledger_txn_ids=[t.id for t in p.ledger],
                           score=p.score, pass_name=p.pass_name, breakdown=p.breakdown, status="auto", note=p.note, ord=i))
    matched = len({t.id for p in res.pairs for t in p.bank})
    bank_n = sum(1 for t in st.txns.values() if t.source == "bank")
    emit(st.run_id, "info", "Match P3", f"{matched} of {bank_n} bank transactions matched ({len(res.pairs)} pairs)")


def stage_detect(st: State) -> int:
    start, end = month_bounds(st.period)
    unmatched = {i for i in st.txns if i not in st.matcher.matched}
    with session_scope() as db:
        dets = {d.id: DetectorCfg(d.id, d.enabled, d.threshold, d.weight) for d in db.execute(select(DetectorRow)).scalars()}
        hist_rows = db.execute(
            select(TxnRow.source, TxnRow.vendor_norm, TxnRow.date, TxnRow.amount).join(RunRow, RunRow.id == TxnRow.run_id)
            .where(RunRow.period < st.period, RunRow.status.in_(["completed", "awaiting_review"]), TxnRow.external.is_(False))
        ).all()
    dets.setdefault("amount_mismatch", DetectorCfg("amount_mismatch", True, 0.05, 1.0))
    history: dict = {}
    first_seen: dict[str, date] = {}
    known: set[str] = set()
    for side, vendor, d, a in hist_rows:
        dd = date.fromisoformat(d)
        history.setdefault((side, vendor), []).append((dd, D(a)))
        if vendor not in first_seen or dd < first_seen[vendor]:
            first_seen[vendor] = dd
        if side == "ledger":
            known.add(vendor)
    for t in st.txns.values():
        if t.source == "ledger":
            known.add(t.vendor)
            if t.vendor not in first_seen or t.date < first_seen[t.vendor]:
                first_seen[t.vendor] = t.date
    org = st.settings["organization"]
    st.ctx = DetectContext(
        period_start=start, period_end=end, txns=st.txns, unmatched=unmatched, external=st.external, history=history,
        known_vendors=known, vendor_first_seen=first_seen,
        approval_limit=D(st.config.get("approvalLimit") or org["approvalLimit"]),
        high_value=D(st.config.get("highValueThreshold") or org["highValueThreshold"]),
        cfg=dets, run_enabled=dict(st.config.get("detectors") or {}),
        same_account=st.compiled.ruleset.same_account,
        account_names={a["id"]: f"{a['bank']} ••{a['last4']}" for a in org["accounts"]},
    )
    covered: set[str] = set()
    # Ledger vouchers booked against the wrong bank account are investigated from the ledger side and
    # their counterpart statement line is covered by the same finding.
    xfirst = {i for i in unmatched if st.txns[i].source == "ledger" and cross_account(st.txns[i], st.ctx)}
    order = sorted(unmatched, key=lambda i: (i not in xfirst, st.txns[i].source != "bank", st.txns[i].date, i))
    for tid in order:
        if tid in covered:
            continue
        t = st.txns[tid]
        cand = Candidate(t, [], [tid])
        for cr in st.compiled.classify:
            if cr.pattern.search(t.desc) and (cr.max_amount is None or abs(t.amount) <= cr.max_amount):
                cand.rule_id = cr.rule_id
                st.rule_hits[cr.rule_id] = st.rule_hits.get(cr.rule_id, 0) + 1
                cand.verdict = Verdict(cr.category, f"{t.desc} ({inr(t.amount)}) matches approved rule {cr.rule_id} “{cr.name}”. {cr.description}",
                                       [], f"Post to GL {cr.suggested_gl}." if cr.suggested_gl else "Book per rule.", 0.95,
                                       [{"tool": "rules_engine", "input": {"rule": cr.rule_id}, "outputSummary": f"Pattern {cr.pattern.pattern} matched; classified without AI", "ms": 0}],
                                       {"name": "rules-engine", "version": cr.rule_id})
                cand.sigs = [Sig("no_counterpart", 0.3, [], {"side": "ledger"}, "No ledger entry; classified by an approved rule")]
                break
        if cand.verdict is None:
            cand.sigs = run_detectors(t, st.ctx)
            for s in cand.sigs:
                pairs_with = s.detector == "amount_mismatch" or (s.detector == "no_counterpart" and s.details.get("otherAccountTxn"))
                if pairs_with and s.evidence and s.evidence[0] not in covered and s.evidence[0] in unmatched and s.evidence[0] not in cand.covered:
                    cand.covered.append(s.evidence[0])
                    break
        covered.update(cand.covered)
        st.candidates.append(cand)
    n_sig = sum(1 for c in st.candidates if c.sigs)
    emit(st.run_id, "info", "Detect", f"{sum(1 for d in dets.values() if d.enabled)} detectors produced signals on {n_sig} of {len(unmatched)} unmatched items")
    return len(st.candidates)


async def stage_ai(st: State) -> int:
    ai = st.settings["ai"]
    mask = bool(st.config.get("maskAccountNumbers", True) or ai.get("maskAccountNumbers"))
    snap = Snapshot(st.ctx, st.openings, mask)
    agent: GeminiAgent | None = None
    if not ai.get("sendDataToAi", True):
        st.ai_note = "sendDataToAi is off — using deterministic explanations"
    else:
        try:
            agent = GeminiAgent(ai.get("defaultModel", "gemini-2.5-flash"), ai.get("escalationModel", "gemini-2.5-pro"), mask, _cache_get, _cache_put,
                                concurrency=get_settings().ai_concurrency)
        except AiUnavailable as e:
            st.ai_note = f"{e} — using deterministic explanations"
    todo = [c for c in st.candidates if c.verdict is None]
    if agent:
        emit(st.run_id, "ai", "AI Investigate", f"Agent investigating {len(todo)} items with {agent.default_model}")
        n_esc = sum(1 for c in todo if prior_category(c.sigs) == "potential_fraud" or abs(c.txn.amount) >= st.ctx.high_value)
        if n_esc:
            emit(st.run_id, "ai", "AI Investigate", f"Escalating {n_esc} potential-fraud / high-value items to {agent.escalation_model}")
    else:
        emit(st.run_id, "warn", "AI Investigate", f"AI unavailable: {st.ai_note}")

    async def one(c: Candidate):
        nonlocal agent
        if agent and not agent.disabled_reason:
            try:
                c.verdict = await agent.investigate(c.txn, c.sigs, snap, abs(c.txn.amount) >= st.ctx.high_value)
                return
            except AiUnavailable as e:
                if not st.ai_note:
                    st.ai_note = str(e)
                    emit(st.run_id, "warn", "AI Investigate", f"{e} — falling back to deterministic explanations")
            except Exception as e:  # never block the pipeline on the LLM
                log.warning("AI error on %s: %s", c.txn.id, type(e).__name__)
                agent.usage.errors += 1
        c.verdict = template(c.txn, c.sigs, st.ctx.period_end)

    await asyncio.gather(*(one(c) for c in todo))
    if agent:
        st.usage = agent.usage.as_dict()
        emit(st.run_id, "ai", "AI Investigate", f"Agent finished: {st.usage['calls']} model calls, {st.usage['inputTokens'] + st.usage['outputTokens']} tokens (≈ ₹{st.usage['costInr']}), {st.usage['cacheHits']} cache hits")

    # Rule proposals (deterministic mining + replay simulation; AI may polish the wording only)
    with session_scope() as db:
        existing = [r.params or {} for r in db.execute(select(RuleRow)).scalars()]
        existing += [p.params or {} for p in db.execute(select(ProposedRuleRow).where(ProposedRuleRow.status == "proposed")).scalars()]
    st.proposals = proposal_miner.mine(st.txns, st.ctx.unmatched, st.matcher.pairs, existing, same_account=st.compiled.ruleset.same_account)
    if agent and st.proposals and not agent.disabled_reason:
        texts = await agent.polish_rules(st.proposals)
        for tx in texts or []:
            if 0 <= tx["index"] < len(st.proposals):
                st.proposals[tx["index"]].update(title=tx["title"], description=tx["description"], confidence=round(tx["confidence"], 2), polished=True)
    if st.proposals:
        emit(st.run_id, "ai", "AI Investigate", f"Proposed {len(st.proposals)} matching rule(s) — pending human approval")
    return len(todo)


def _cache_get(h: str) -> dict | None:
    with session_scope() as db:
        row = db.get(AiCacheRow, h)
        return dict(row.response) if row else None


def _cache_put(h: str, model: str, resp: dict) -> None:
    with session_scope() as db:
        if not db.get(AiCacheRow, h):
            db.add(AiCacheRow(hash=h, model=model, response=resp))


def route(category: str, confidence: float, amount: Decimal, high_value: Decimal) -> tuple[str, str | None]:
    if category == "potential_fraud":
        return "human_review", "Potential fraud"
    if abs(amount) >= high_value:
        return "human_review", "High value"
    if confidence < 0.7:
        return "human_review", "Low AI confidence"
    if category == "unknown":
        return "human_review", "Unknown category"
    return "auto_resolve", None


def stage_verify(st: State) -> int:
    now = utcnow()
    auto = human = 0
    with session_scope() as db:
        prefix = f"F-{ym(st.period)}-"
        seq = next_finding_seq(db, prefix)
        for i, c in enumerate(st.candidates):
            v = c.verdict
            seq += 1
            signals = [{"txnId": c.txn.id, "detector": s.detector, "score": weighted(s, st.ctx), "evidenceIds": s.evidence,
                        "details": {**s.details, "rawScore": s.raw, "weight": st.ctx.cfg.get(s.detector).weight if s.detector in st.ctx.cfg else 1.0},
                        "humanText": s.text} for s in c.sigs]
            risk = js_round(noisy_or(s["score"] for s in signals), 3) if signals else 0.0
            routing, reason = route(v.category, v.confidence, c.txn.amount, st.ctx.high_value)
            status = "auto_resolved" if routing == "auto_resolve" else "open"
            if routing == "auto_resolve":
                auto += 1
            else:
                human += 1
            fid = f"{prefix}{seq:03d}"
            evidence = [e for e in v.evidence_txn_ids if e != c.txn.id]
            db.add(FindingRow(
                id=fid, run_id=st.run_id, txn_id=c.txn.id, category=v.category, risk_score=risk, signals=signals, explanation=v.explanation,
                evidence_txn_ids=evidence, suggested_action=v.suggested_action, confidence=round(float(v.confidence), 2), routing=routing,
                routing_reason=reason, status=status, assignee=st.created_by if routing == "human_review" else None, agent_trace=v.trace, model_name=v.model["name"], model_version=v.model["version"],
                created_at=now, updated_at=now, covered_txn_ids=c.covered, ai_prompt=v.prompt, ai_response=v.response, ord=i,
            ))
            db.flush()
            add_audit(db, actor_type="ai" if v.model["name"].startswith("gemini") else "system",
                      actor_name="Investigation agent" if v.model["name"].startswith("gemini") else ("rules-engine" if c.rule_id else "deterministic-classifier"),
                      action="finding.classified", target=fid, after={"category": v.category, "confidence": round(float(v.confidence), 2), "riskScore": risk},
                      run_id=st.run_id, model_version=f"{v.model['name']}@{v.model['version']}")
            if status == "auto_resolved":
                add_audit(db, actor_type="system", actor_name="verifier", action="finding.auto_resolved", target=fid,
                          before={"status": "open"}, after={"status": "auto_resolved"}, run_id=st.run_id)
        # proposed rules
        pprefix = f"PR-{ym(st.period)}-"
        pseq = next_proposed_seq(db, pprefix)
        polished_model = st.settings["ai"].get("defaultModel", "gemini-2.5-flash")
        for p in st.proposals:
            pseq += 1
            model = {"name": polished_model, "version": "api"} if p.get("polished") else dict(FALLBACK_MODEL)
            row = ProposedRuleRow(id=f"{pprefix}{pseq}", run_id=st.run_id, title=p["title"], description=p["description"], scope=p["scope"],
                                  params=p["params"], supporting_txn_ids=[t.id for t in p["supporting"]], simulation=p["simulation"],
                                  confidence=round(p["confidence"], 2), status="proposed", model_name=model["name"], model_version=model["version"])
            db.add(row)
            db.flush()
            add_audit(db, actor_type="ai", actor_name="Investigation agent", action="rule.proposed", target=row.id,
                      after={"title": row.title, "params": row.params}, run_id=st.run_id, model_version=f"{model['name']}@{model['version']}")
        # rule hit counters
        for rid, n in st.rule_hits.items():
            r = db.get(RuleRow, rid)
            if r and n:
                r.hit_count = (r.hit_count or 0) + n
                r.last_triggered = now
        run = db.get(RunRow, st.run_id)
        run.ai_usage = st.usage
        if st.usage.get("calls"):
            from app.db.models import SettingsRow

            srow = db.get(SettingsRow, 1)
            data = dict(srow.data)
            data["ai"] = {**data["ai"], "estCostPerRun": fmt(Decimal(str(st.usage["costInr"])))}
            srow.data = data
    # integrity: every unmatched txn is explained by exactly one finding
    unmatched = st.ctx.unmatched
    covered = [t for c in st.candidates for t in c.covered]
    ok = set(covered) == unmatched and len(covered) == len(set(covered))
    bank_total = sum((t.amount for t in st.txns.values() if t.source == "bank"), ZERO)
    ledger_total = sum((t.amount for t in st.txns.values() if t.source == "ledger"), ZERO)
    emit(st.run_id, "info", "Verify", f"Scoring & routing: {auto} auto-resolved, {human} to human review")
    emit(st.run_id, "info" if ok else "error", "Verify",
         f"Integrity check: bank − ledger = {inr(bank_total - ledger_total)} {'= Σ explained + unexplained ✓' if ok else '— coverage mismatch'}")
    return len(st.candidates)


# ----------------------------------------------------------------------------- orchestration
async def run_pipeline(run_id: str) -> None:
    st = State(run_id)
    t_start = time.perf_counter()
    current = "Ingest"

    async def stage(name: str, fn, *args):
        nonlocal current
        current = name
        set_stage(run_id, name, "active", status="running")
        t0 = time.perf_counter()
        count = await fn(*args) if asyncio.iscoroutinefunction(fn) else await asyncio.to_thread(fn, *args)
        set_stage(run_id, name, "done", count=count, ms=int((time.perf_counter() - t0) * 1000))

    try:
        await stage("Ingest", stage_ingest, st)
        await stage("Normalize", stage_normalize, st)
        await stage("Match P1", stage_match, st, "P1")
        await stage("Match P2", stage_match, st, "P2")
        await stage("Match P3", stage_match, st, "P3")
        await stage("Detect", stage_detect, st)
        await stage("AI Investigate", stage_ai, st)
        await stage("Verify", stage_verify, st)
        set_stage(run_id, "Done", "done")
        emit(run_id, "info", "Done", "Run complete — items routed to human review")
        with session_scope() as db:
            run = db.get(RunRow, run_id)
            run.status = "awaiting_review"
            run.duration_ms = int((time.perf_counter() - t_start) * 1000)
            n_pairs = len(st.matcher.pairs) if st.matcher else 0
            add_audit(db, actor_type="system", actor_name="pipeline", action="run.completed", target=run_id,
                      after={"pairs": n_pairs, "findings": len(st.candidates)}, run_id=run_id)
    except Exception as e:
        msg = str(e) if isinstance(e, PipelineError) else f"Internal error in {current}: {type(e).__name__}: {e}"
        if not isinstance(e, PipelineError):
            log.exception("Pipeline failed for %s", run_id)
        try:
            emit(run_id, "error", current, msg)
            set_stage(run_id, current, "failed", status="failed")
            with session_scope() as db:
                run = db.get(RunRow, run_id)
                run.status = "failed"
                run.error = msg
                run.duration_ms = int((time.perf_counter() - t_start) * 1000)
                add_audit(db, actor_type="system", actor_name="pipeline", action="run.failed", target=run_id, after={"stage": current, "error": msg[:300]}, run_id=run_id)
        except Exception:  # pragma: no cover
            log.exception("Could not record failure for %s", run_id)


def run_name(period: str, accounts: list[str], settings: dict) -> str:
    y, m = period.split("-")
    month = date(int(y), int(m), 1).strftime("%B %Y")
    banks = {a["id"]: a["bank"].split()[0] for a in settings["organization"]["accounts"]}
    return f"{month} — {' + '.join(banks.get(a, a) for a in accounts)}"


__all__ = ["run_pipeline", "route", "run_name", "STAGES", "P4", "title_case"]
