"""Demo data: a deterministic statement / ledger generator, seeded through the REAL pipeline.

    cd backend && python -m scripts.seed_demo [--if-empty] [--months 6] [--use-ai] [--out data/samples]

For every month (Apr 2026 … Sep 2026 by default) it writes three files exactly as a customer would
upload them — an HDFC text PDF statement, an ICICI iBizz CSV and a Tally day book CSV — uploads them
through `create_upload` (the API code path), creates a run and executes `run_pipeline`. Months before
September are reviewed and finalized; September 2026 is left awaiting review as the showcase run.
The September files (+ a partially scanned copy of the HDFC PDF) are also written to `data/samples/`
for the wizard's "Use sample files" button.
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import csv
import io
import json
import random
import sys
import time
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from unittest import mock

CENT = Decimal("0.01")
ACCOUNTS = {
    "acc_hdfc": {"ledger": "HDFC Bank A/c 4521", "last4": "4521", "card": "4521"},
    "acc_icici": {"ledger": "ICICI Bank A/c 8834", "last4": "8834", "card": "4893"},
}
OPENING = {"acc_hdfc": Decimal("4825310.45"), "acc_icici": Decimal("1240880.00")}
ANCHOR = {"acc_hdfc": Decimal("5000000"), "acc_icici": Decimal("2000000")}  # balances the generator steers towards
CREDIT_SHARE = 0.15  # customer receipts are fewer but larger than vendor payments; keeps balances stable
SPILL_DAYS = 5  # ICICI CSV and Tally export run into the first days of the next month
SHOWCASE = "2026-09"
# Narration formats that first appear in the showcase month (so its run proposes fresh alias rules).
SEP_NEW_ALIASES = {"RJIL POSTPAID", "BANGALORE ELEC SUPPLY", "MMT INDIA"}


# ----------------------------------------------------------------------------- reference data
@dataclass(frozen=True)
class Party:
    name: str
    alias: str
    fuzzy: tuple[str, ...]
    gl: str
    channels: tuple[str, ...]
    lo: int
    hi: int
    weight: float
    memo: str
    credit: bool = False
    paise: bool = False


PARTIES = [
    Party("ACME Traders Pvt Ltd", "ACME TRADERS", ("ACME TRDRS", "ACME TRADING CO"), "5010 Raw Materials", ("NEFT",), 40000, 300000, 6, "Raw material purchase"),
    Party("Sharma Steel Industries", "SHARMA STEEL IND", ("SHARMA STL INDS",), "5010 Raw Materials", ("RTGS", "NEFT"), 120000, 480000, 3, "Steel coils"),
    Party("Amazon Web Services India", "AMAZON WEB SERVICES", ("AWS INDIA", "AMZN WEB SVCS"), "6200 Cloud & Software", ("NACH",), 45000, 120000, 2, "Cloud hosting", paise=True),
    Party("Zoho Corporation", "ZOHO CORP", ("ZOHOCORP",), "6200 Cloud & Software", ("NACH",), 8000, 25000, 2, "Zoho One subscription"),
    Party("Google Cloud India", "GOOGLE CLOUD INDIA", ("GOOGLE INDIA DIGITAL",), "6200 Cloud & Software", ("NACH",), 12000, 60000, 2, "Workspace & GCP", paise=True),
    Party("Reliance Jio Infocomm", "RELIANCE JIO", ("RJIL POSTPAID", "JIO PLATFORMS"), "6400 Telecom", ("UPI", "NACH"), 2000, 15000, 4, "Postpaid & leased line"),
    Party("Bharti Airtel Ltd", "BHARTI AIRTEL", ("AIRTEL BB",), "6400 Telecom", ("NACH",), 3000, 12000, 3, "Broadband"),
    Party("BESCOM", "BESCOM BANGALORE", ("BANGALORE ELEC SUPPLY",), "6300 Utilities", ("NACH",), 18000, 60000, 2, "Electricity", paise=True),
    Party("Blue Dart Express", "BLUEDART EXPRESS", ("BLUE DART EXP LTD",), "6500 Logistics", ("NEFT",), 5000, 40000, 6, "Courier charges"),
    Party("Delhivery Ltd", "DELHIVERY", ("DLVRY LOGISTICS",), "6500 Logistics", ("NEFT",), 6000, 55000, 6, "Freight"),
    Party("Mahindra Logistics", "MAHINDRA LOGISTICS", ("MLL SUPPLY CHAIN",), "6500 Logistics", ("RTGS", "NEFT"), 60000, 250000, 3, "Warehousing"),
    Party("MakeMyTrip India", "MAKEMYTRIP", ("MMT INDIA", "MAKE MY TRIP"), "6600 Travel", ("UPI", "POS"), 4000, 45000, 5, "Business travel"),
    Party("Uber India", "UBER INDIA", ("UBER TRIP",), "6600 Travel", ("UPI",), 200, 2000, 9, "Local conveyance", paise=True),
    Party("Swiggy", "SWIGGY", ("BUNDL TECHNOLOGIES", "SWIGGY INSTAMART"), "6610 Staff Welfare", ("UPI",), 300, 4000, 9, "Team meals", paise=True),
    Party("Office Mart Supplies", "OFFICEMART", ("OFFICE MART SUPP",), "6800 Office Supplies", ("UPI", "IMPS"), 1000, 12000, 5, "Stationery"),
    Party("Quess Corp", "QUESS CORP", ("QUESS CORP LTD",), "7200 Contract Staff", ("NEFT",), 100000, 300000, 1.5, "Contract staffing"),
    Party("Khaitan & Co", "KHAITAN AND CO", ("KHAITAN CO LLP",), "6700 Professional Fees", ("NEFT",), 60000, 200000, 0.6, "Legal retainer"),
    Party("Godrej Interio", "GODREJ INTERIO", ("GODREJ AND BOYCE",), "1500 Furniture & Fixtures", ("NEFT",), 25000, 150000, 0.6, "Office furniture"),
    # customers (credits)
    Party("Flipkart Internet Pvt Ltd", "FLIPKART INTERNET", ("FKRT INTERNET",), "4000 Revenue — Sales", ("RTGS", "NEFT"), 150000, 900000, 4, "Customer receipt", credit=True),
    Party("Tata Motors Ltd", "TATA MOTORS LTD", ("TATA MOTORS PASS VEH",), "4000 Revenue — Sales", ("RTGS",), 300000, 1200000, 2, "Customer receipt", credit=True),
    Party("Larsen & Toubro", "LARSEN AND TOUBRO", ("LARSEN TOUBRO LTD",), "4000 Revenue — Sales", ("NEFT", "RTGS"), 200000, 800000, 2, "Customer receipt", credit=True),
    Party("Asian Paints Ltd", "ASIAN PAINTS LTD", ("ASIANPAINTS",), "4000 Revenue — Sales", ("NEFT",), 100000, 600000, 2, "Customer receipt", credit=True),
    Party("Hindustan Unilever", "HINDUSTAN UNILEVER", ("HUL MUMBAI",), "4000 Revenue — Sales", ("RTGS",), 250000, 900000, 1.5, "Customer receipt", credit=True),
    Party("Razorpay Software", "RAZORPAY SOFTWARE", ("RZP SETTLEMENT",), "4010 Revenue — Online", ("NEFT",), 20000, 150000, 10, "Gateway settlement", credit=True, paise=True),
]
BY_NAME = {p.name: p for p in PARTIES}
PAYEES = [p for p in PARTIES if not p.credit]
PAYERS = [p for p in PARTIES if p.credit]
IFSC = ["HDFC0000123", "ICIC0000456", "UTIB0000789", "SBIN0001234", "KKBK0000958", "YESB0000221"]
VPA_BANKS = ["okhdfcbank", "ybl", "paytm", "okaxis"]
DEPTS = ["Engineering", "Sales", "Operations", "Finance", "Design"]


# ----------------------------------------------------------------------------- rows
@dataclass
class BankLine:
    d: date
    desc: str
    ref: str
    amount: Decimal
    acct: str
    k: float = 0.0  # intra-day sort key


@dataclass
class LedgerLine:
    d: date
    vno: str
    party: str
    acct: str
    amount: Decimal  # + = money into the bank (Tally Debit), - = out (Tally Credit)
    gl: str
    narration: str


@dataclass
class Month:
    period: str
    start: date
    end: date
    bank: list[BankLine] = field(default_factory=list)
    ledger: list[LedgerLine] = field(default_factory=list)
    opening: dict[str, Decimal] = field(default_factory=dict)
    closing: dict[str, Decimal] = field(default_factory=dict)
    anomalies: list[str] = field(default_factory=list)


def month_bounds(period: str) -> tuple[date, date]:
    y, m = (int(x) for x in period.split("-"))
    start = date(y, m, 1)
    nxt = date(y + (m == 12), m % 12 + 1, 1)
    return start, nxt - timedelta(days=1)


def money(rupees: int, paise: int = 0) -> Decimal:
    return (Decimal(rupees) + Decimal(paise) / 100).quantize(CENT)


def indian(a: Decimal) -> str:
    """1245000.5 -> 12,45,000.50"""
    s = f"{abs(a):.2f}"
    i, f = s.split(".")
    if len(i) > 3:
        head, tail = i[:-3], i[-3:]
        groups = []
        while len(head) > 2:
            groups.insert(0, head[-2:])
            head = head[:-2]
        if head:
            groups.insert(0, head)
        i = ",".join(groups) + "," + tail
    return ("-" if a < 0 else "") + i + "." + f


# ----------------------------------------------------------------------------- generator
class Gen:
    def __init__(self, period: str, opening: dict[str, Decimal], showcase: bool):
        y, m = (int(x) for x in period.split("-"))
        self.rng = random.Random(20260000 + y * 100 + m)
        self.mo = Month(period, *month_bounds(period), opening=dict(opening))
        self.showcase = showcase
        self.y, self.m = y, m
        self.voucher = self.rng.randint(100, 400)
        self.invoice = 1800 + (m * 97) % 600 + self.rng.randint(0, 50)
        self.pairs: list[tuple[BankLine, LedgerLine, Party, str]] = []

    # -- helpers
    def digits(self, n: int) -> str:
        return "".join(str(self.rng.randint(0, 9)) for _ in range(n))

    def day(self, n: int) -> date:
        return self.mo.start + timedelta(days=min(n, self.mo.end.day) - 1)

    def business_day(self) -> date:
        while True:
            d = self.day(self.rng.randint(1, self.mo.end.day))
            if d.weekday() < 5 or self.rng.random() < 0.06:
                return d

    def last_business_day(self) -> date:
        d = self.mo.end
        while d.weekday() >= 5:
            d -= timedelta(days=1)
        return d

    def amount(self, p: Party) -> Decimal:
        r = self.rng.randint(p.lo, p.hi)
        if r > 20000:
            r = round(r / 10) * 10
        a = money(r, self.rng.randint(0, 99) if p.paise else 0)
        return a if p.credit else -a

    def weighted(self, ps: list[Party]) -> Party:
        return self.rng.choices(ps, weights=[p.weight for p in ps])[0]

    def vno(self, credit: bool) -> str:
        self.voucher += 1
        return f"{'RV' if credit else 'PV'}-{self.m:02d}-{self.voucher:04d}"

    def next_inv(self) -> str:
        self.invoice += 1
        return f"INV-{self.invoice}"

    def narration(self, ch: str, alias: str, credit: bool, acct: str, inv: str = "", vpa: str | None = None) -> tuple[str, str]:
        rng = self.rng
        ifsc = rng.choice(IFSC)
        if ch == "NEFT":
            return f"NEFT {'CR' if credit else 'DR'}-{ifsc}-{alias}" + (f"-{inv.replace('-', '')}" if inv else ""), f"{ifsc[:4]}N{self.digits(11)}"
        if ch == "RTGS":
            utr = f"{ifsc[:4]}R{self.digits(15)}"
            return f"RTGS {'CR' if credit else 'DR'}-{ifsc}-{alias}-" + (inv.replace("-", "") if inv else utr[-8:]), utr
        if ch == "UPI":
            rrn = self.digits(12)
            handle = vpa or alias.split(" ")[0].lower()
            return f"UPI/{rrn}/{alias}/{handle}@{rng.choice(VPA_BANKS)}", rrn
        if ch == "NACH":
            umrn = f"{ifsc[:4]}{self.digits(14)}"
            return f"NACH-DR-{alias}-{umrn[-10:]}", umrn
        if ch == "IMPS":
            rrn = self.digits(12)
            return f"IMPS/P2A/{rrn}/{alias}", rrn
        if ch == "POS":
            return f"POS {ACCOUNTS[acct]['card']}XXXXXXXX{self.digits(4)} {alias} BANGALORE", self.digits(6)
        raise ValueError(ch)

    def add_bank(self, d: date, desc: str, ref: str, amount: Decimal, acct: str) -> BankLine:
        b = BankLine(d, desc, ref, amount, acct, self.rng.random())
        self.mo.bank.append(b)
        return b

    def add_ledger(self, d: date, p: Party | None, amount: Decimal, acct: str, ref: str = "", narration: str | None = None,
                   party: str | None = None, gl: str | None = None) -> LedgerLine:
        credit = amount > 0
        name = party or (p.name if p else "Suspense")
        narr = narration or f"{'Receipt from' if credit else 'Payment to'} {name}{f' against {ref}' if ref.startswith('INV') else ''} · {p.memo if p else ''}".rstrip(" ·")
        line = LedgerLine(d, ref or self.vno(credit), name, acct, amount, gl or (p.gl if p else "2999 Suspense"), narr)
        self.mo.ledger.append(line)
        return line

    def pair(self, p: Party, ledger_date: date, kind: str, acct: str | None = None, ch: str | None = None,
             amount: Decimal | None = None, alias: str | None = None) -> tuple[BankLine, LedgerLine]:
        rng = self.rng
        acct = acct or ("acc_hdfc" if rng.random() < (0.6 if p.credit else 0.72) else "acc_icici")
        amount = amount if amount is not None else self.amount(p)
        ch = ch or rng.choice(p.channels)
        inv = self.next_inv() if not p.credit and ch in ("NEFT", "RTGS") and rng.random() < 0.7 else ""
        lag = 0 if kind == "p1" else rng.randint(1, 3) if kind == "p2" else rng.randint(0, 2)
        bank_date = ledger_date + timedelta(days=lag)
        if bank_date > self.mo.end:
            bank_date = ledger_date
        alias = alias or (rng.choice(p.fuzzy) if kind == "p3" else p.alias)
        vpa = p.alias.split(" ")[0].lower() if ch == "UPI" else None  # VPA handles carry the brand
        desc, ref = self.narration(ch, alias, p.credit, acct, "" if kind == "p3" else inv, vpa)
        bank_amount = amount
        if p.name == "Amazon Web Services India" and rng.random() < 0.3:
            bank_amount = amount + Decimal("0.50")  # USD-billed: FX rounding (rule R-008)
        b = self.add_bank(bank_date, desc, ref, bank_amount, acct)
        l = self.add_ledger(ledger_date, p, amount, acct, inv)
        self.pairs.append((b, l, p, kind))
        return b, l

    # -- the month
    def build(self, n_pairs: int = 580, n_fuzzy: int = 40) -> Month:
        rng, mo = self.rng, self.mo
        dates = sorted(self.business_day() for _ in range(n_pairs))
        # Steer the mix so balances mean-revert towards their anchors: receipts vs payments by the total
        # balance, then the account (≈70/30 split) by which account is further below its anchor.
        # Month-end payroll (~₹25L) is reserved on HDFC up front.
        bal = {"acc_hdfc": mo.opening["acc_hdfc"] - Decimal(2500000), "acc_icici": mo.opening["acc_icici"]}
        # Abbreviated / fuzzy narration aliases: picked alias-first so every alias shows up a few times.
        # Some vendors only switch to a new narration format in the showcase month.
        pool = [(p, a) for p in PARTIES for a in p.fuzzy if self.showcase or a not in SEP_NEW_ALIASES]
        if self.showcase:
            pool += [(p, a) for p in PARTIES for a in p.fuzzy if a in SEP_NEW_ALIASES] * 2
        for d in dates:
            alias = None
            r = rng.random()
            if r < n_fuzzy / n_pairs:
                kind, (p, alias) = "p3", rng.choice(pool)
            else:
                kind = "p2" if r < n_fuzzy / n_pairs + 0.2 else "p1"
                low = sum(bal.values()) < sum(ANCHOR.values())
                p = self.weighted(PAYERS) if rng.random() < (0.22 if low else 0.1) else self.weighted(PAYEES)
            hdfc_low = (bal["acc_hdfc"] - ANCHOR["acc_hdfc"]) / Decimal("0.7") < (bal["acc_icici"] - ANCHOR["acc_icici"]) / Decimal("0.3")
            p_hdfc = (0.85 if hdfc_low else 0.45) if p.credit else (0.6 if hdfc_low else 0.88)
            acct = "acc_hdfc" if rng.random() < p_hdfc else "acc_icici"
            b, _ = self.pair(p, d, kind, acct=acct, alias=alias)
            bal[acct] += b.amount
        self.groups()
        self.anomalies()
        self.spill()
        mo.bank.sort(key=lambda b: (b.d, b.k))
        mo.ledger.sort(key=lambda l: (l.d, l.vno))
        for acct in ACCOUNTS:
            mo.closing[acct] = mo.opening[acct] + sum((b.amount for b in mo.bank if b.acct == acct and b.d <= mo.end), Decimal(0))
        return mo

    def include(self, p: float = 0.5) -> bool:
        return self.showcase or self.rng.random() < p

    def groups(self) -> None:
        rng, mo = self.rng, self.mo
        tag = mo.start.strftime("%b%Y").upper()
        # 1:N — one Flipkart settlement clears three invoices
        if self.include(0.6):
            fk = BY_NAME["Flipkart Internet Pvt Ltd"]
            d = self.day(12)
            parts = [Decimal("248000.00"), Decimal("312850.00"), Decimal("181500.00")] if self.showcase else \
                [money(round(rng.randint(150000, 350000), -2)) for _ in range(3)]
            invs = [f"INV-{self.y}-{871 + 4 * i + self.m * 20:04d}" for i in range(3)]
            self.add_bank(d, f"NEFT CR-HDFC0000999-FLIPKART INTERNET-SETTL {invs[0].replace('-', '')}", f"HDFCN{self.digits(11)}", sum(parts), "acc_hdfc")
            for v, inv in zip(parts, invs, strict=True):
                self.add_ledger(d, fk, v, "acc_hdfc", inv)
            mo.anomalies.append("1:N Flipkart settlement")
        # 1:20 — payroll
        pay = self.last_business_day()
        sal = [money(round(rng.randint(45000, 210000), -2)) for _ in range(20)]
        self.add_bank(pay, f"BULK NEFT DR-SALARY {tag}-BATCH 42", f"HDFCB{self.digits(10)}", -sum(sal), "acc_hdfc")
        for i, s in enumerate(sal):
            self.add_ledger(pay, None, -s, "acc_hdfc", f"SAL-{self.y % 100:02d}{self.m:02d}-{i + 1:02d}",
                            f"Salary {mo.start.strftime('%b %Y')} — EMP-{1040 + i} ({DEPTS[i % len(DEPTS)]})", party="Payroll — Bulk salary", gl="7100 Salaries")
        # N:1 — Sharma Steel invoice paid in two RTGS tranches
        if self.include(0.6):
            ss = BY_NAME["Sharma Steel Industries"]
            inv = f"INV-SS-{3391 + self.m}"
            d1 = self.day(10)
            while d1.weekday() >= 5:
                d1 += timedelta(days=1)
            self.add_ledger(d1, ss, Decimal("-600000.00"), "acc_hdfc", inv)
            for i, d in enumerate((d1, d1 + timedelta(days=1))):
                self.add_bank(d, f"RTGS DR-SBIN0001234-SHARMA STEEL IND-{inv.replace('-', '')} T{i + 1}", f"HDFCR{self.digits(15)}", Decimal("-300000.00"), "acc_hdfc")
            mo.anomalies.append("N:1 Sharma Steel tranches")

    def anomalies(self) -> None:
        mo, end = self.mo, self.mo.end
        tag = mo.start.strftime("%b%y").upper()
        # -- duplicates: same payee + amount, 0–1 day apart, different reference
        for i, vendor in enumerate(["Blue Dart Express", "Amazon Web Services India", "Zoho Corporation"]):
            if not self.include(0.4):
                continue
            src = next((b for b, l, p, k in self.pairs if p.name == vendor and k != "p3" and b.amount == l.amount and b.d < end), None)
            if src:
                d = src.d + timedelta(days=0 if i == 1 else 1)
                self.add_bank(d, src.desc, f"{src.ref[:-4]}{self.digits(4)}", src.amount, src.acct)
                mo.anomalies.append(f"duplicate {vendor}")
        # -- missing in ledger (bank-only)
        if self.include(0.9):
            self.add_bank(end, f"CHRG: NEFT/RTGS CHGS {tag}", self.digits(10), Decimal("-1180.00"), "acc_hdfc")
            self.add_bank(end, "GST ON CHGS", self.digits(10), Decimal("-212.40"), "acc_hdfc")
            mo.anomalies.append("bank charges")
        if self.include(0.5):
            yy = self.y % 100
            self.add_bank(end, f"INT.PD:01-{self.m:02d}-{yy} TO {end.day}-{self.m:02d}-{yy}", self.digits(10), Decimal("4318.00"), "acc_icici")
            mo.anomalies.append("interest credit")
        if self.include(0.3):
            self.add_bank(self.day(14), "DEBIT CARD ANNUAL FEE", self.digits(10), Decimal("-590.00"), "acc_icici")
            mo.anomalies.append("card fee")
        if self.m % 3 == 0:  # quarterly keyman-insurance premium
            self.add_bank(self.day(18), f"NACH-DR-LIC OF INDIA-POL{self.digits(6)}", f"HDFC{self.digits(14)}", Decimal("-48250.00"), "acc_hdfc")
            mo.anomalies.append("LIC premium")
        # -- missing in bank (ledger-only)
        if self.include(0.4):
            self.add_ledger(self.day(21), BY_NAME["Quess Corp"], Decimal("-186400.00"), "acc_hdfc", self.next_inv())
            mo.anomalies.append("Quess payment not in bank")
        if self.include(0.4):
            self.add_ledger(self.day(19), BY_NAME["Larsen & Toubro"], Decimal("295000.00"), "acc_hdfc")
            mo.anomalies.append("L&T receipt not in bank")
        # -- booked against the wrong bank account (ledger says HDFC, money moved in ICICI)
        if self.include(0.3):
            p, d, inv = BY_NAME["Delhivery Ltd"], self.day(11), self.next_inv()
            self.add_ledger(d, p, Decimal("-22815.00"), "acc_hdfc", inv)
            desc, ref = self.narration("NEFT", p.alias, False, "acc_icici", inv)
            self.add_bank(d, desc, ref, Decimal("-22815.00"), "acc_icici")
            mo.anomalies.append("Delhivery wrong account")
        if self.include(0.3):
            p, d = BY_NAME["Hindustan Unilever"], self.day(23)
            self.add_ledger(d, p, Decimal("420000.00"), "acc_hdfc")
            desc, ref = self.narration("RTGS", p.alias, True, "acc_icici")
            self.add_bank(d, desc, ref, Decimal("420000.00"), "acc_icici")
            mo.anomalies.append("HUL wrong account")
        # -- month-end timing, bank side (HDFC, last business day; ledger books it next month)
        lbd = self.last_business_day()
        nxt = end + timedelta(days=1)
        for name, amt, ch, booked in (("Razorpay Software", "124500.00", "NEFT", 1), ("MakeMyTrip India", "-32400.00", "POS", 2),
                                      ("Tata Motors Ltd", "680000.00", "RTGS", 1)):
            if not self.include(0.5):
                continue
            p = BY_NAME[name]
            desc, ref = self.narration(ch, p.alias, p.credit, "acc_hdfc")
            self.add_bank(lbd, desc, ref, Decimal(amt), "acc_hdfc")
            self.add_ledger(nxt + timedelta(days=booked - 1), p, Decimal(amt), "acc_hdfc")
            mo.anomalies.append(f"timing (bank) {name}")
        # -- month-end timing, ledger side (ICICI cheques / deposit; bank clears next month)
        for name, amt, dd, chq, clears in (("Sharma Steel Industries", "-245000.00", end.day - 1, "004512", 3),
                                            ("Khaitan & Co", "-118000.00", end.day, "004513", 4),
                                            ("Larsen & Toubro", "340000.00", end.day, "004514", 1)):
            if not self.include(0.5):
                continue
            p = BY_NAME[name]
            label = "Cheque deposited" if p.credit else f"Cheque #{chq} issued"
            self.add_ledger(self.day(dd), p, Decimal(amt), "acc_icici", narration=f"{label} — {p.name} · {p.memo}")
            desc = f"CLG CHQ DEP-{chq}-{p.alias}" if p.credit else f"CHQ PAID-{chq}-{p.alias}"
            self.add_bank(nxt + timedelta(days=clears - 1), desc, chq, Decimal(amt), "acc_icici")
            mo.anomalies.append(f"timing (ledger) {name}")
        if not self.showcase:
            return
        # -- potential fraud (showcase month only)
        d = self.day(24)
        while d.weekday() >= 5:
            d += timedelta(days=1)
        self.add_bank(d, "NEFT DR-YESB0000221-NOVA INFRA SOLUTIONS-INV0007", f"HDFCN{self.digits(11)}", Decimal("-49900.00"), "acc_hdfc")
        sunday = next(self.day(n) for n in range(27, 0, -1) if self.day(n).weekday() == 6)
        self.add_bank(sunday, "RTGS DR-ICIC0000456-GLOBAL TECH VENTURES-RTGS77120", f"ICICR{self.digits(15)}", Decimal("-875000.00"), "acc_icici")
        mo.anomalies += ["fraud Nova Infra", "fraud Global Tech"]
        # -- amount mismatches (TDS 2% / transposition)
        for name, b_amt, l_amt, dd in (("Mahindra Logistics", "-147000.00", "-150000.00", 15), ("Blue Dart Express", "-9680.00", "-9860.00", 8)):
            p, inv = BY_NAME[name], self.next_inv()
            desc, ref = self.narration("NEFT", p.alias, False, "acc_hdfc", inv)
            self.add_bank(self.day(dd), desc, ref, Decimal(b_amt), "acc_hdfc")
            self.add_ledger(self.day(dd), p, Decimal(l_amt), "acc_hdfc", inv)
            mo.anomalies.append(f"amount mismatch {name}")

    def spill(self) -> None:
        """Normal traffic in the first days of the next month (ICICI CSV + Tally export only)."""
        rng, nxt = self.rng, self.mo.end + timedelta(days=1)
        for _ in range(24):
            p = self.weighted(PAYERS) if rng.random() < CREDIT_SHARE else self.weighted(PAYEES)
            d = nxt + timedelta(days=rng.randint(0, SPILL_DAYS - 1))
            acct = "acc_hdfc" if rng.random() < 0.7 else "acc_icici"
            amount = self.amount(p)
            self.add_ledger(d, p, amount, acct)
            if acct == "acc_icici":
                desc, ref = self.narration(rng.choice(p.channels), p.alias, p.credit, acct)
                self.add_bank(d, desc, ref, amount, acct)


# ----------------------------------------------------------------------------- writers
def write_icici_csv(mo: Month) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["Txn Date", "Value Date", "Description", "Ref No", "Debit", "Credit", "Balance"])
    bal = mo.opening["acc_icici"]
    for b in (x for x in mo.bank if x.acct == "acc_icici"):
        bal += b.amount
        ds = b.d.strftime("%d/%m/%Y")
        w.writerow([ds, ds, b.desc, b.ref, f"{-b.amount:.2f}" if b.amount < 0 else "", f"{b.amount:.2f}" if b.amount > 0 else "", f"{bal:.2f}"])
    return buf.getvalue().encode()


def write_tally_csv(mo: Month) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["Voucher Date", "Vch Type", "Vch No.", "Particulars", "Ledger", "Debit", "Credit", "Cost Centre", "Narration"])
    for l in mo.ledger:
        w.writerow([l.d.strftime("%d-%b-%Y"), "Receipt" if l.amount > 0 else "Payment", l.vno, l.party, ACCOUNTS[l.acct]["ledger"],
                    f"{l.amount:.2f}" if l.amount > 0 else "", f"{-l.amount:.2f}" if l.amount < 0 else "", l.gl, l.narration])
    return buf.getvalue().encode()


HDFC_HEADER = ["Date", "Narration", "Chq./Ref.No.", "Value Dt", "Withdrawal Amt.", "Deposit Amt.", "Closing Balance"]
HDFC_WIDTHS = [48, 300, 118, 48, 82, 82, 92]
ROWS_PER_PAGE = 26


def _hdfc_rows(mo: Month) -> list[list[str]]:
    rows, bal = [], mo.opening["acc_hdfc"]
    for b in (x for x in mo.bank if x.acct == "acc_hdfc" and x.d <= mo.end):
        bal += b.amount
        ds = b.d.strftime("%d/%m/%y")
        rows.append([ds, b.desc, b.ref, ds, indian(-b.amount) if b.amount < 0 else "", indian(b.amount) if b.amount > 0 else "", indian(bal)])
    return rows


def _scan_image(rows: list[list[str]], page: int, size: tuple[float, float]) -> io.BytesIO:
    """Render one statement page as a slightly skewed, noisy greyscale 'scan' (no text layer)."""
    from PIL import Image, ImageDraw, ImageFilter, ImageFont

    scale = 2.0
    w, h = int(size[0] * scale), int(size[1] * scale)
    img = Image.new("L", (w, h), 250)
    dr = ImageDraw.Draw(img)
    font = ImageFont.load_default(size=int(7.5 * scale))
    big = ImageFont.load_default(size=int(14 * scale))
    x0, y = int(36 * scale), int(30 * scale)
    dr.text((x0, y), "HDFC BANK", fill=20, font=big)
    dr.text((x0, y + int(20 * scale)), f"Statement of account  —  Current A/c XXXXXXXX4521  —  Page {page}", fill=40, font=font)
    y += int(44 * scale)
    rh = int(14 * scale)
    widths = [int(x * scale) for x in HDFC_WIDTHS]
    for r_i, r in enumerate([HDFC_HEADER, *rows]):
        x = x0
        for c_i, (cell, cw) in enumerate(zip(r, widths, strict=True)):
            dr.rectangle([x, y, x + cw, y + rh], outline=90, width=1)
            tw = dr.textlength(cell, font=font)
            tx = x + cw - tw - 6 if c_i >= 4 and r_i else x + 5
            dr.text((tx, y + int(3 * scale)), cell, fill=25, font=font)
            x += cw
        y += rh
    rnd = random.Random(page)
    for _ in range(1800):
        dr.point((rnd.randrange(w), rnd.randrange(h)), fill=rnd.randint(150, 215))
    img = img.rotate(0.35, resample=Image.Resampling.BICUBIC, fillcolor=245).filter(ImageFilter.GaussianBlur(0.5))
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=62)
    out.seek(0)
    return out


def write_hdfc_pdf(mo: Month, scanned_pages: frozenset[int] = frozenset()) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import Image, PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    rows = _hdfc_rows(mo)
    pages = [rows[i:i + ROWS_PER_PAGE] for i in range(0, len(rows), ROWS_PER_PAGE)] or [[]]
    size = landscape(A4)
    buf = io.BytesIO()
    period = f"{mo.start.strftime('%d/%m/%Y')} To {mo.end.strftime('%d/%m/%Y')}"

    def on_page(canvas, doc):
        if doc.page in scanned_pages:
            return
        canvas.saveState()
        canvas.setFont("Helvetica-Bold", 14)
        canvas.setFillColor(colors.HexColor("#004c8f"))
        canvas.drawString(36, size[1] - 34, "HDFC BANK")
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(colors.black)
        canvas.drawRightString(size[0] - 36, size[1] - 30, f"Statement of account  |  Statement From : {period}")
        canvas.drawRightString(size[0] - 36, size[1] - 40, "Current A/c XXXXXXXX4521  |  Acme Manufacturing Pvt Ltd")
        canvas.drawString(36, 20, "This is a computer generated statement and does not require a signature.")
        canvas.drawRightString(size[0] - 36, 20, f"Page {doc.page}")
        canvas.restoreState()

    style = TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#7a7a7a")),
        ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 7),
        ("FONT", (0, 1), (-1, -1), "Helvetica", 7),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e6eef7")),
        ("ALIGN", (4, 1), (6, -1), "RIGHT"),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
    ])
    p_style = ParagraphStyle("s", fontName="Helvetica", fontSize=8.5, leading=12)
    total_dr = sum((-b.amount for b in mo.bank if b.acct == "acc_hdfc" and b.amount < 0 and b.d <= mo.end), Decimal(0))
    total_cr = sum((b.amount for b in mo.bank if b.acct == "acc_hdfc" and b.amount > 0 and b.d <= mo.end), Decimal(0))
    story = [
        Paragraph("<b>Statement Summary</b> — Account No : XXXXXXXX4521 (Current A/c) · Branch : Koramangala, Bengaluru · IFSC : HDFC0000123", p_style),
        Paragraph(f"Statement Period : {period} · Currency : INR", p_style),
        Paragraph(f"Opening Balance: {indian(mo.opening['acc_hdfc'])} &nbsp;&nbsp; Total Withdrawals: {indian(total_dr)} &nbsp;&nbsp; "
                  f"Total Deposits: {indian(total_cr)} &nbsp;&nbsp; Closing Balance: {indian(mo.closing['acc_hdfc'])}", p_style),
        Spacer(1, 8),
    ]
    for i, chunk in enumerate(pages, start=1):
        if i > 1:
            story.append(PageBreak())
        if i in scanned_pages:
            story.append(Image(_scan_image(chunk, i, size), width=700, height=700 * size[1] / size[0]))
        else:
            story.append(Table([HDFC_HEADER, *chunk], colWidths=HDFC_WIDTHS, style=style, repeatRows=0))
    doc = SimpleDocTemplate(buf, pagesize=size, leftMargin=24, rightMargin=24, topMargin=52, bottomMargin=32,
                            title=f"HDFC Statement {mo.start.strftime('%b %Y')}", author="HDFC Bank")
    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    return buf.getvalue()


def month_files(mo: Month) -> dict[str, tuple[bytes, str, str | None]]:
    tag = mo.start.strftime("%b%Y")
    return {
        f"HDFC_Statement_{tag}.pdf": (write_hdfc_pdf(mo), "bank", "acc_hdfc"),
        f"ICICI_Statement_{tag}.csv": (write_icici_csv(mo), "bank", "acc_icici"),
        f"Tally_DayBook_{tag}.csv": (write_tally_csv(mo), "ledger", None),
    }


def generate(period: str, opening: dict[str, Decimal]) -> Month:
    return Gen(period, opening, showcase=period == SHOWCASE).build()


# ----------------------------------------------------------------------------- seeding helpers
def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


class SimClock:
    """utcnow() replacement while seeding: starts at the run's simulated creation time, advances in real time."""

    def __init__(self, start: datetime):
        self.start, self.t0 = start, time.perf_counter()

    def __call__(self) -> str:
        return iso(self.start + timedelta(seconds=time.perf_counter() - self.t0))


@contextmanager
def sim_clock(start: datetime):
    clock = SimClock(start)
    with mock.patch("app.services.pipeline.utcnow", clock), mock.patch("app.services.audit.utcnow", clock), \
            mock.patch("app.services.actions.utcnow", clock):
        yield clock


@contextmanager
def ai_setting(use_ai: bool):
    from app.db.models import SettingsRow
    from app.db.session import session_scope

    if use_ai:
        yield
        return
    with session_scope() as db:
        row = db.get(SettingsRow, 1)
        data = copy.deepcopy(row.data)
        prev = data["ai"].get("sendDataToAi", True)
        data["ai"]["sendDataToAi"] = False
        row.data = data
    try:
        yield
    finally:
        with session_scope() as db:
            row = db.get(SettingsRow, 1)
            data = copy.deepcopy(row.data)
            data["ai"]["sendDataToAi"] = prev
            row.data = data


def periods(n: int, last: str = SHOWCASE) -> list[str]:
    y, m = (int(x) for x in last.split("-"))
    out = []
    for _ in range(n):
        out.append(f"{y}-{m:02d}")
        y, m = (y - 1, 12) if m == 1 else (y, m - 1)
    return out[::-1]


def write_samples(out: Path, mo: Month, files: dict[str, tuple[bytes, str, str | None]]) -> None:
    out.mkdir(parents=True, exist_ok=True)
    index = []
    for name, (data, kind, acct) in files.items():
        (out / name).write_bytes(data)
        index.append({"name": name, "kind": kind, "accountId": acct})
    scanned = f"HDFC_Statement_{mo.start.strftime('%b%Y')}_scanned.pdf"
    (out / scanned).write_bytes(write_hdfc_pdf(mo, frozenset({3})))
    index.append({"name": scanned, "kind": "bank", "accountId": "acc_hdfc"})
    (out / "index.json").write_text(json.dumps(index, indent=2) + "\n")


def seed_month(mo: Month, files: dict, created_by: str, created_at: datetime, finalize: bool) -> dict:
    from sqlalchemy import select, update

    from app.db.models import EventRow, PairRow, ProposedRuleRow, RunRow, UploadRow
    from app.db.session import session_scope
    from app.services.audit import add_audit
    from app.services.pipeline import run_pipeline
    from app.services.repo import load_run
    from app.services.runs import approve_all_for_seed, create_run_record
    from app.services.uploads import create_upload
    from app.services.views import run_view, unexplained

    file_ids, ledger_id = [], None
    with session_scope() as db:
        for i, (name, (data, kind, acct)) in enumerate(files.items()):
            up, status = create_upload(db, data=data, name=name, kind=kind, account_id=acct)
            if status != 201 or up.status != "parsed":
                raise SystemExit(f"{name}: upload failed ({status}): {up.error or up.status}")
            if kind == "bank" and up.sanity and not up.sanity.ok:
                raise SystemExit(f"{name}: balance sanity check failed: {up.sanity}")
            db.execute(update(UploadRow).where(UploadRow.id == up.id).values(created_at=iso(created_at - timedelta(minutes=6 - i))))
            file_ids.append(up.id)
            if kind == "ledger":
                ledger_id = up.id
        body = {"period": mo.period, "accounts": list(ACCOUNTS), "fileIds": file_ids, "ledgerSource": {"type": "csv", "fileId": ledger_id},
                "config": {}, "maskAccountNumbers": True}
        run_id = create_run_record(db, body, created_by, created_at=iso(created_at)).id
    t0 = time.perf_counter()
    with sim_clock(created_at + timedelta(seconds=2)):
        asyncio.run(run_pipeline(run_id))
    runtime = time.perf_counter() - t0
    with session_scope() as db:
        run = db.get(RunRow, run_id)
        if run.status != "awaiting_review":
            raise SystemExit(f"{mo.period}: pipeline ended in status {run.status}: {run.error}")
        ts = iso(created_at + timedelta(seconds=4))
        db.execute(update(PairRow).where(PairRow.run_id == run_id).values(created_at=ts))
        db.execute(update(ProposedRuleRow).where(ProposedRuleRow.run_id == run_id).values(created_at=ts))
        if finalize:
            rd = load_run(db, run_id)
            review = created_at + timedelta(days=1, hours=3)
            approve_all_for_seed(db, rd, "Priya Sharma", iso(review))
            before = rd.run.status
            rd.run.status = "completed"
            add_audit(db, actor_type="user", actor_name="Rahul Mehta", action="run.finalized", target=run_id, before={"status": before},
                      after={"status": "completed"}, run_id=run_id, ts=iso(review + timedelta(hours=5)))
            db.flush()
    if finalize:
        decide_proposals(run_id, review + timedelta(hours=6))
    with session_scope() as db:
        rd = load_run(db, run_id)
        view = run_view(rd)
        u = unexplained(view)
        if finalize and u != 0:
            raise SystemExit(f"{mo.period}: unexplained difference {u} after approving every finding")
        events = list(db.execute(select(EventRow).where(EventRow.run_id == run_id).order_by(EventRow.seq)).scalars())
        props = list(db.execute(select(ProposedRuleRow).where(ProposedRuleRow.run_id == run_id)).scalars())
        return {
            "period": mo.period, "run": run_id, "status": rd.run.status, "bank": view.stats.bank_count, "ledger": view.stats.ledger_count,
            "passes": Counter(p.pass_name for p in rd.pairs), "unmatched": (view.stats.unmatched_bank, view.stats.unmatched_ledger),
            "auto": view.stats.auto_match_rate, "cats": Counter(f.category for f in rd.findings),
            "routing": Counter(f.routing_reason or f.routing for f in rd.findings), "findings": len(rd.findings), "unexplained": u,
            "integrity": next((e.message for e in events if e.message.startswith("Integrity")), "—"),
            "proposals": [f"{p.title} [{p.status}]" for p in props], "runtime": runtime, "anomalies": mo.anomalies,
        }


def decide_proposals(run_id: str, when: datetime) -> list[str]:
    """The controller reviews last month's AI rule proposals: narration aliases are approved (they become
    active rules and resolve those payees at Normalize from then on); policy changes are deferred."""
    from sqlalchemy import select

    from app.core.auth import User
    from app.db.models import ProposedRuleRow
    from app.db.session import session_scope
    from app.schemas import RuleDecisionRequest
    from app.services.actions import decide_rule

    controller = User(name="Rahul Mehta", role="admin", ip="10.20.4.22")
    out = []
    with sim_clock(when), session_scope() as db:
        for pr in db.execute(select(ProposedRuleRow).where(ProposedRuleRow.run_id == run_id, ProposedRuleRow.status == "proposed")).scalars():
            if (pr.params or {}).get("aliases"):
                decide_rule(db, pr.id, RuleDecisionRequest(action="approve"), controller)
                out.append(f"approved {pr.title}")
            else:
                reason = "Deferred — keep reviewing these manually until the FY26-27 bank tariff / vendor terms are confirmed"
                decide_rule(db, pr.id, RuleDecisionRequest(action="reject", reason=reason), controller)
                out.append(f"rejected {pr.title}")
    return out


def print_summary(s: dict) -> None:
    passes = ", ".join(f"{k.split(' ·')[0]}={v}" for k, v in sorted(s["passes"].items()))
    print(f"\n{s['period']}  {s['run']}  [{s['status']}]  pipeline {s['runtime']:.1f}s")
    print(f"  bank {s['bank']} / ledger {s['ledger']} · pairs {sum(s['passes'].values())} ({passes}) · auto-match {s['auto'] * 100:.1f}%")
    print(f"  unmatched bank {s['unmatched'][0]} / ledger {s['unmatched'][1]} · findings {s['findings']}: {dict(s['cats'])}")
    print(f"  routing {dict(s['routing'])} · unexplained {s['unexplained']}")
    print(f"  {s['integrity']}")
    for t in s["proposals"]:
        print(f"  proposed rule: {t}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Seed ReconAI with generated statements run through the real pipeline.")
    ap.add_argument("--if-empty", action="store_true", help="do nothing when runs already exist")
    ap.add_argument("--months", type=int, default=6, help="months to seed, ending September 2026 (default 6)")
    ap.add_argument("--use-ai", action="store_true", help="let the investigation agent call the AI provider (off by default)")
    ap.add_argument("--out", default=None, help="where to write the September sample files (default: <DATA_DIR>/samples)")
    args = ap.parse_args(argv)

    from app.core.config import BACKEND_DIR, get_settings
    from app.db.init import init_db
    from app.db.session import session_scope
    from app.services.repo import count_runs

    init_db()
    with session_scope() as db:
        if args.if_empty and count_runs(db):
            print("Runs already exist — skipping seed (--if-empty).")
            return 0
    out = Path(args.out) if args.out else get_settings().data_dir / "samples"
    if not out.is_absolute():
        out = BACKEND_DIR / out
    opening = dict(OPENING)
    summaries = []
    t_all = time.perf_counter()
    with ai_setting(args.use_ai):
        for i, period in enumerate(periods(max(1, args.months))):
            mo = generate(period, opening)
            files = month_files(mo)
            if period == SHOWCASE:
                write_samples(out, mo, files)
            created_at = datetime.combine(mo.end + timedelta(days=2 + i % 3), datetime.min.time(), UTC) + timedelta(hours=4, minutes=7 * i + 11)
            who = "Rahul Mehta" if i % 3 == 1 else "Priya Sharma"
            s = seed_month(mo, files, who, created_at, finalize=period != SHOWCASE)
            summaries.append(s)
            print_summary(s)
            opening = dict(mo.closing)
    print(f"\nSeeded {len(summaries)} run(s) in {time.perf_counter() - t_all:.1f}s; samples in {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
