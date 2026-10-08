from fastapi import Depends
from sqlalchemy.orm import Session

from app.api.routers import Router
from app.core.auth import User, current_user, require
from app.core.errors import invalid, not_found
from app.db.models import FindingRow
from app.db.session import get_db
from app.schemas import (
    BulkDecisionRequest,
    Comment,
    CommentRequest,
    DecisionRequest,
    FindingDetail,
    ManualMatchRequest,
    MatchPair,
    Ok,
    ReviewItem,
    UnmatchRequest,
)
from app.services import actions
from app.services.audit import audit_user
from app.services.views import finding_detail, locate_finding, review_queue

router = Router(tags=["findings"])


@router.get("/findings/{finding_id}", response_model=FindingDetail)
def get_finding(finding_id: str, db: Session = Depends(get_db)):
    loc = locate_finding(db, finding_id)
    if not loc:
        raise not_found("Finding")
    return finding_detail(db, *loc)


@router.post("/findings/bulk-decision")
def bulk_decision(body: BulkDecisionRequest, user: User = Depends(require("finding.decide")), db: Session = Depends(get_db)):
    return {"updated": actions.bulk_approve(db, body.ids, user)}


@router.post("/findings/{finding_id}/decision", response_model=FindingDetail)
def decide(finding_id: str, body: DecisionRequest, user: User = Depends(require("finding.decide")), db: Session = Depends(get_db)):
    return actions.decide(db, finding_id, body, user)


@router.post("/findings/{finding_id}/comments", response_model=Comment, status_code=201)
def comment(finding_id: str, body: CommentRequest, user: User = Depends(current_user), db: Session = Depends(get_db)):
    f = db.get(FindingRow, finding_id)
    if not f:
        raise not_found("Finding")
    text = (body.body or "").strip()
    if not text:
        raise invalid("Comment cannot be empty")
    c = actions.add_comment(db, finding_id, user.name, text)
    audit_user(db, user, "finding.commented", finding_id, after={"body": text}, run_id=f.run_id)
    db.commit()
    return actions.comment_out(c)


@router.post("/matches/manual", response_model=MatchPair, status_code=201)
def manual(body: ManualMatchRequest, user: User = Depends(require("match.manual")), db: Session = Depends(get_db)):
    return actions.manual_match(db, body, user)


@router.post("/matches/{pair_id}/unmatch", response_model=Ok)
def unmatch(pair_id: str, body: UnmatchRequest, user: User = Depends(require("match.unmatch")), db: Session = Depends(get_db)):
    actions.unmatch(db, pair_id, body, user)
    return Ok()


@router.get("/review-queue", response_model=list[ReviewItem])
def get_review_queue(db: Session = Depends(get_db)):
    return review_queue(db)
