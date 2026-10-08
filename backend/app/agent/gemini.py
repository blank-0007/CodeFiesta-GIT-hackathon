"""Gemini investigation agent (the only LLM use in ReconAI).

Per item: function-calling rounds (max 4) over our deterministic tools, then one structured-output
call validated with Pydantic (retry once). temperature=0. Evidence ids are filtered to ids we
actually know; no evidence => confidence capped at 0.5. Account/card numbers are masked before
anything is sent. Responses are cached by a hash of the case file. Rate limits (429/503) back off
exponentially. Any failure falls back to the deterministic template so the pipeline never blocks.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import random
import time
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from app.agent.fallback import Verdict, prior_category, template
from app.agent.tools import DECLARATIONS, Snapshot, execute
from app.core.config import get_settings
from app.detect.detectors import Sig
from app.matching.score import MTxn
from app.normalize.vendors import mask_numbers

log = logging.getLogger("reconai.agent")

MAX_TOOL_ROUNDS = 4
# USD per 1M tokens (input, output) — used only for the cost estimate shown in Settings.
PRICES = {"flash": (0.30, 2.50), "pro": (1.25, 10.0)}
USD_INR = 88.0

SYSTEM = """You are ReconAI's investigation agent for Indian bank reconciliation.
You receive ONE unmatched transaction plus detector signals computed by deterministic code.
Your job: decide WHY it is unmatched and classify it as exactly one of:
duplicate | missing | timing | potential_fraud | unknown.
Rules:
- Use the tools to gather evidence. Never invent transaction ids — cite only ids returned by tools or given in the case.
- Do not compute totals or match math yourself; rely on tool outputs.
- 'timing' = counterpart exists just across the month cut-off. 'duplicate' = same amount & counterparty posted twice.
  'missing' = legitimate item booked on one side only (bank charges, interest, unbooked expense, wrong bank GL).
  'potential_fraud' = risk pattern (just-below approval limit, new beneficiary, weekend high-value transfer, no support).
  'unknown' = cannot determine the purpose from the data.
- Be concise and specific: mention amounts in ₹ with Indian grouping, dates, and the ids you relied on.
- Confidence is your probability the category is right (0-1). If you have no supporting evidence ids, keep it <= 0.5."""


class AgentVerdict(BaseModel):
    category: Literal["duplicate", "missing", "timing", "potential_fraud", "unknown"]
    explanation: str = Field(min_length=10, max_length=1200)
    evidenceTxnIds: list[str] = Field(default_factory=list)
    suggestedAction: str = Field(min_length=3, max_length=600)
    confidence: float = Field(ge=0, le=1)


@dataclass
class Usage:
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float = 0.0
    cache_hits: int = 0
    errors: int = 0
    by_model: dict[str, int] = field(default_factory=dict)

    def add(self, model: str, inp: int, out: int) -> None:
        self.calls += 1
        self.input_tokens += inp
        self.output_tokens += out
        self.by_model[model] = self.by_model.get(model, 0) + 1
        pi, po = PRICES["pro" if "pro" in model else "flash"]
        self.cost_usd += inp / 1e6 * pi + out / 1e6 * po

    def as_dict(self) -> dict:
        return {"calls": self.calls, "inputTokens": self.input_tokens, "outputTokens": self.output_tokens,
                "costUsd": round(self.cost_usd, 4), "costInr": round(self.cost_usd * USD_INR, 2),
                "cacheHits": self.cache_hits, "errors": self.errors, "byModel": self.by_model}


class AiUnavailable(Exception):
    pass


class GeminiAgent:
    def __init__(self, default_model: str, escalation_model: str, mask: bool, cache_get, cache_put, concurrency: int = 2):
        settings = get_settings()
        if not settings.has_gemini_key:
            raise AiUnavailable("GEMINI_API_KEY is not set")
        from google import genai

        self._genai = genai
        self.client = genai.Client(api_key=settings.gemini_api_key.get_secret_value())  # key never logged
        self.default_model = default_model
        self.escalation_model = escalation_model
        self.mask = mask
        self.sem = asyncio.Semaphore(concurrency)
        self.usage = Usage()
        self.cache_get = cache_get
        self.cache_put = cache_put
        self.timeout = settings.ai_timeout_s
        self.disabled_reason: str | None = None

    # ------------------------------------------------------------------ low level
    def _config(self, model: str, *, tools: bool, schema: type[BaseModel] | None = None):
        from google.genai import types

        kw: dict = {"temperature": 0, "system_instruction": SYSTEM}
        if "flash" in model:
            kw["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
        if tools:
            kw["tools"] = [types.Tool(function_declarations=[types.FunctionDeclaration(**d) for d in DECLARATIONS])]
            kw["automatic_function_calling"] = types.AutomaticFunctionCallingConfig(disable=True)
        if schema is not None:
            kw["response_mime_type"] = "application/json"
            kw["response_schema"] = schema
        return types.GenerateContentConfig(**kw)

    async def _call(self, model: str, contents, config):
        delay = 2.0
        for attempt in range(5):
            try:
                resp = await asyncio.wait_for(self.client.aio.models.generate_content(model=model, contents=contents, config=config), timeout=self.timeout)
                um = getattr(resp, "usage_metadata", None)
                self.usage.add(model, getattr(um, "prompt_token_count", 0) or 0, getattr(um, "candidates_token_count", 0) or 0)
                return resp
            except Exception as e:  # google.genai.errors.APIError carries .code
                code = getattr(e, "code", None) or getattr(e, "status_code", None)
                if code in (401, 403) or (code == 400 and "API key" in str(e)):
                    self.disabled_reason = "Gemini API key rejected"
                    raise AiUnavailable(self.disabled_reason) from e
                if code == 404:
                    raise AiUnavailable(f"Model {model} is not available") from e
                if code in (429, 500, 503) or isinstance(e, asyncio.TimeoutError):
                    if attempt == 4:
                        raise
                    await asyncio.sleep(delay + random.random())
                    delay = min(delay * 2, 30)
                    continue
                raise
        raise RuntimeError("unreachable")

    # ------------------------------------------------------------------ public
    def case_file(self, t: MTxn, sigs: list[Sig], snap: Snapshot, prior: str) -> dict:
        desc = mask_numbers(t.desc) if self.mask else t.desc
        return {
            "transaction": {**snap.describe(t), "description": desc},
            "period": {"start": snap.ctx.period_start.isoformat(), "end": snap.ctx.period_end.isoformat()},
            "approvalLimit": str(snap.ctx.approval_limit), "highValueThreshold": str(snap.ctx.high_value),
            "detectorSignals": [{"detector": s.detector, "strength": s.raw, "evidence": s.evidence, "text": s.text} for s in sigs],
            "detectorPriorCategory": prior,
        }

    async def investigate(self, t: MTxn, sigs: list[Sig], snap: Snapshot, high_value: bool) -> Verdict:
        prior = prior_category(sigs)
        escalate = prior == "potential_fraud" or high_value
        model = self.escalation_model if escalate else self.default_model
        case = self.case_file(t, sigs, snap, prior)
        case_json = json.dumps(case, sort_keys=True, ensure_ascii=False)
        h = hashlib.sha256((model + "|" + case_json).encode()).hexdigest()
        cached = self.cache_get(h)
        if cached:
            self.usage.cache_hits += 1
            return self._to_verdict(cached["verdict"], cached.get("trace", []), model, case_json, t, sigs, snap, from_cache=True)
        async with self.sem:
            verdict, trace = await self._run_agent(model, case_json, t, snap)
        self.cache_put(h, model, {"verdict": verdict, "trace": trace})
        return self._to_verdict(verdict, trace, model, case_json, t, sigs, snap)

    async def _run_agent(self, model: str, case_json: str, t: MTxn, snap: Snapshot) -> tuple[dict, list[dict]]:
        from google.genai import types

        contents = [types.Content(role="user", parts=[types.Part(text=f"Case file (JSON):\n{case_json}\n\nInvestigate using the tools, then stop calling tools.")])]
        trace: list[dict] = []
        for _ in range(MAX_TOOL_ROUNDS):
            resp = await self._call(model, contents, self._config(model, tools=True))
            calls = resp.function_calls or []
            if not calls:
                break
            contents.append(resp.candidates[0].content)
            parts = []
            for fc in calls:
                args = dict(fc.args or {})
                out, summary, ms = execute(snap, fc.name, args, t)
                trace.append({"tool": fc.name, "input": args, "outputSummary": summary, "ms": ms})
                parts.append(types.Part.from_function_response(name=fc.name, response={"result": out}))
            contents.append(types.Content(role="user", parts=parts))
        contents.append(types.Content(role="user", parts=[types.Part(text="Return your final verdict as JSON matching the schema.")]))
        last_err = None
        for _attempt in range(2):  # validate, retry once
            resp = await self._call(model, contents, self._config(model, tools=False, schema=AgentVerdict))
            try:
                parsed = resp.parsed if isinstance(resp.parsed, AgentVerdict) else AgentVerdict.model_validate_json(resp.text or "")
                return parsed.model_dump(), trace
            except (ValidationError, ValueError) as e:
                last_err = e
                contents.append(types.Content(role="user", parts=[types.Part(text=f"That was not valid ({str(e)[:200]}). Return ONLY valid JSON for the schema.")]))
        log.warning("Agent output invalid after retry for %s: %s", t.id, last_err)
        return {"category": "unknown", "explanation": "The AI agent did not return a valid verdict; routed to human review.",
                "evidenceTxnIds": [], "suggestedAction": "Review manually.", "confidence": 0.0, "_invalid": True}, trace

    def _to_verdict(self, v: dict, trace: list[dict], model: str, case_json: str, t: MTxn, sigs: list[Sig], snap: Snapshot, from_cache: bool = False) -> Verdict:
        known = set(snap.ctx.txns) | {x.id for x in snap.ctx.external}
        ev = [i for i in v.get("evidenceTxnIds", []) if i in known and i != t.id]
        conf = float(v.get("confidence", 0))
        if not ev:
            conf = min(conf, 0.5)
        if v.get("_invalid"):
            fb = template(t, sigs, snap.ctx.period_end)
            fb.category, fb.confidence = "unknown", 0.0
            fb.explanation = "The AI agent did not return a valid verdict after one retry. " + fb.explanation
            fb.trace = trace + fb.trace
            fb.model = {"name": model, "version": "invalid-output"}
            return fb
        return Verdict(
            category=v["category"], explanation=v["explanation"], evidence_txn_ids=ev, suggested_action=v["suggestedAction"],
            confidence=round(conf, 2), trace=trace + ([{"tool": "cache", "input": {}, "outputSummary": "Served from case-file cache", "ms": 0}] if from_cache else []),
            model={"name": model, "version": "api"}, prompt=case_json, response=json.dumps(v, ensure_ascii=False),
        )

    async def polish_rules(self, candidates: list[dict]) -> list[dict] | None:
        """Ask the model to write titles/descriptions for mined rule candidates (params stay deterministic)."""
        if not candidates:
            return []

        class RuleText(BaseModel):
            index: int
            title: str = Field(max_length=90)
            description: str = Field(max_length=400)
            confidence: float = Field(ge=0, le=1)

        class RuleTexts(BaseModel):
            rules: list[RuleText]

        from google.genai import types

        prompt = ("These matching-rule candidates were mined deterministically from this run's leftovers, with a replay simulation. "
                  "For each, write a short title and a one-paragraph description an accountant can approve, and a confidence. "
                  "Do NOT change parameters.\n" + json.dumps([{k: c[k] for k in ("title", "description", "params", "simulation")} | {"index": i} for i, c in enumerate(candidates)], ensure_ascii=False))
        try:
            async with self.sem:
                resp = await self._call(self.default_model, [types.Content(role="user", parts=[types.Part(text=prompt)])],
                                        self._config(self.default_model, tools=False, schema=RuleTexts))
            parsed = resp.parsed if isinstance(resp.parsed, RuleTexts) else RuleTexts.model_validate_json(resp.text or "")
            return [r.model_dump() for r in parsed.rules]
        except Exception as e:
            log.info("Rule polishing skipped: %s", type(e).__name__)
            return None


async def timed(coro):
    t0 = time.perf_counter()
    r = await coro
    return r, int((time.perf_counter() - t0) * 1000)
