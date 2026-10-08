/**
 * Lightweight vendor-name similarity used for live previews in the UI.
 * The backend owns the authoritative score; this mirrors its behaviour
 * closely enough for "what would this threshold do?" previews.
 */

const NOISE = new Set([
  "pvt", "ltd", "private", "limited", "llp", "inc", "india", "co", "corp", "corporation",
  "mktp", "mktplace", "us", "in", "the", "and", "neft", "rtgs", "imps", "upi", "nach", "ach",
  "dr", "cr", "pos", "payment", "pay", "services", "svc",
]);

export function normalizeVendor(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !NOISE.has(t) && !/\d/.test(t));
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aM = new Array<boolean>(a.length).fill(false);
  const bM = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(i + range + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (!bM[j] && a[i] === b[j]) {
        aM[i] = bM[j] = true;
        matches++;
        break;
      }
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aM[i]) continue;
    while (!bM[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - t / 2) / m) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** First letter + consonants: "amazon" → "amzn" — catches bank abbreviations. */
function skeleton(t: string): string {
  return t[0] + t.slice(1).replace(/[aeiou]/g, "");
}

export function vendorSimilarity(a: string, b: string): number {
  const ta = normalizeVendor(a);
  const tb = normalizeVendor(b);
  if (!ta.length || !tb.length) return 0;
  const full = jaroWinkler(ta.join(" "), tb.join(" "));
  let best = 0;
  for (const x of ta) {
    for (const y of tb) {
      let s = jaroWinkler(x, y);
      if (x.length >= 3 && y.length >= 3 && (skeleton(x) === skeleton(y) || skeleton(x) === y || x === skeleton(y))) {
        s = Math.max(s, 0.92);
      }
      best = Math.max(best, s);
    }
  }
  // Token-level evidence counts for more when the first tokens agree.
  const score = Math.max(full, best * 0.97);
  return Math.round(score * 100) / 100;
}
