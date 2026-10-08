from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.routers import Router
from app.core.auth import User, require
from app.db.models import DetectorRow, ProposedRuleRow, RuleRow, RuleVersionRow
from app.db.session import get_db
from app.schemas import (
    Detector,
    DetectorTestRequest,
    DetectorTestResponse,
    DetectorUpdate,
    ProposedRule,
    Rule,
    RuleDecisionRequest,
    RulesResponse,
    RuleUpdate,
    RuleVersion,
)
from app.services import actions

router = Router(tags=["rules"])


@router.get("/rules", response_model=RulesResponse)
def get_rules(db: Session = Depends(get_db)):
    rules = list(db.execute(select(RuleRow)).scalars())
    rules.sort(key=lambda r: int(r.id.split("-")[1]) if r.id.split("-")[-1].isdigit() else 0)
    proposed = list(db.execute(select(ProposedRuleRow).order_by(ProposedRuleRow.created_at.desc(), ProposedRuleRow.id)).scalars())
    versions = db.execute(select(RuleVersionRow).order_by(RuleVersionRow.changed_at.desc())).scalars()
    dets = db.execute(select(DetectorRow).order_by(DetectorRow.ord)).scalars()
    return RulesResponse(
        active=[actions.rule_out(r) for r in rules],
        proposed=[actions.proposed_out(db, p) for p in proposed],
        detectors=[actions.detector_out(d) for d in dets],
        versions=[RuleVersion(id=v.id, rule_id=v.rule_id, version=v.version, changed_by=v.changed_by, changed_at=v.changed_at,
                              before=v.before, after=v.after or {}, note=v.note) for v in versions],
    )


@router.post("/rules/{proposed_id}/decision", response_model=ProposedRule)
def decide_rule(proposed_id: str, body: RuleDecisionRequest, user: User = Depends(require("rule.decide")), db: Session = Depends(get_db)):
    return actions.decide_rule(db, proposed_id, body, user)


@router.put("/rules/{rule_id}", response_model=Rule)
def update_rule(rule_id: str, body: RuleUpdate, user: User = Depends(require("rule.toggle")), db: Session = Depends(get_db)):
    return actions.update_rule(db, rule_id, body, user)


@router.put("/detectors/{detector_id}", response_model=Detector)
def update_detector(detector_id: str, body: DetectorUpdate, user: User = Depends(require("detector.configure")), db: Session = Depends(get_db)):
    return actions.update_detector(db, detector_id, body, user)


@router.post("/detectors/{detector_id}/test", response_model=DetectorTestResponse)
def test_detector(detector_id: str, body: DetectorTestRequest, db: Session = Depends(get_db)):
    return actions.test_detector(db, detector_id, body)
