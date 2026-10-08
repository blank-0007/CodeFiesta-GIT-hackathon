"""Compile enabled active rules into matcher inputs (AI only PROPOSES rules; these are human-approved)."""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field
from decimal import Decimal

from app.core.money import D
from app.db.models import RuleRow
from app.matching.engine import HoldRule, RuleSet, ScopedTolerance, TdsRule
from app.normalize.vendors import AliasRule

DAYS = {"mon": 0, "tue": 1, "wed": 2, "thu": 3, "fri": 4, "sat": 5, "sun": 6}


@dataclass
class ClassifyRule:
    rule_id: str
    name: str
    description: str
    pattern: re.Pattern
    max_amount: Decimal | None
    category: str
    suggested_gl: str | None


@dataclass
class Compiled:
    ruleset: RuleSet
    aliases: list[AliasRule] = field(default_factory=list)
    classify: list[ClassifyRule] = field(default_factory=list)
    config: dict = field(default_factory=dict)  # run config with pass overrides applied
    max_group: int = 25


def compile_rules(rules: list[RuleRow], config: dict, accounts: list[dict]) -> Compiled:
    rs = RuleSet()
    rs.accounts = {a["id"]: [a["id"], a.get("last4", ""), a.get("name", ""), a.get("bank", "")] for a in accounts}
    cfg = copy.deepcopy(config)
    out = Compiled(ruleset=rs, config=cfg)
    passes = cfg.get("passes") or []
    for r in rules:
        if not r.enabled:
            continue
        p = r.params or {}
        if "pass" in p:
            n = int(p["pass"])
            if 1 <= n <= len(passes):
                for k in ("dateToleranceDays", "amountTolerance", "vendorThreshold"):
                    if k in p:
                        passes[n - 1][k] = p[k]
                rs.pass_rules[n] = r.id
            continue
        if "maxGroupSize" in p:
            out.max_group = int(p["maxGroupSize"])
            rs.pass_rules[4] = r.id
            for ps in passes:
                if str(ps.get("name", "")).startswith("P4") and "dateToleranceDays" in p:
                    ps["dateToleranceDays"] = p["dateToleranceDays"]
            continue
        if p.get("aliases"):
            canonical = p.get("canonical") or r.scope_value
            if canonical:
                out.aliases.append(AliasRule(r.id, canonical, [str(a) for a in p["aliases"]]))
            continue
        if p.get("pattern"):
            try:
                pat = re.compile(str(p["pattern"]), re.I)
            except re.error:
                continue
            out.classify.append(ClassifyRule(r.id, r.name, r.description, pat, D(p["maxAmount"]) if p.get("maxAmount") else None,
                                             str(p.get("category", "missing")), p.get("suggestedGl")))
            continue
        if p.get("action") == "route_to_review":
            wd = {DAYS[str(d).lower()[:3]] for d in p.get("weekdays", []) if str(d).lower()[:3] in DAYS}
            rs.holds.append(HoldRule(r.id, p.get("channel"), wd))
            continue
        if p.get("tdsRate") is not None:
            rs.tds.append(TdsRule(r.id, D(p["tdsRate"])))
            continue
        if any(k in p for k in ("dateToleranceDays", "amountTolerance", "vendorThreshold")):
            scope = r.scope if r.scope in ("vendor", "account") else ("vendor" if p.get("vendor") else None)
            value = r.scope_value or p.get("vendor")
            if scope and value:
                rs.scoped.append(ScopedTolerance(
                    r.id, scope, str(value),
                    date_tol=int(p["dateToleranceDays"]) if "dateToleranceDays" in p else None,
                    amount_tol=D(p["amountTolerance"]) if "amountTolerance" in p else None,
                    vendor_threshold=float(p["vendorThreshold"]) if "vendorThreshold" in p else None,
                ))
    return out
