/**
 * Display-name blocklist shared by the server (RunSubmit / transfer names →
 * 400 'bad-name') and, when it wants it, the client. Environment-free: no
 * Node or DOM APIs, so it bundles anywhere the protocol does.
 *
 * Matching is by normalised substring. A name is normalised with NFKC, lower
 * case and every space / punctuation / symbol removed, then checked in three
 * shapes: letters only (digits and symbols dropped, so `시1발` → `시발`), a
 * leet-mapped shape (`sh!t` → `shit`, `5hit` → `shit`) and a run-collapsed
 * shape (`fuuuck` → `fuck`). The built-in list below is curated for a 12
 * code-point nickname field: short fragments that live inside ordinary words
 * (ass, sex, 시바, 니미 …) are deliberately absent, longer compounds stand in
 * for them. `names.blocklist.json` is the operator's extension — the admin CLI
 * (`ban-name`) appends to it and a redeploy ships it; it is read once at load.
 */
import extra from './names.blocklist.json';

/** Terms shipped in code. Korean first, then English. */
export const BUILTIN_BLOCKLIST: readonly string[] = [
  // Korean profanity and its common spellings
  '씨발', '시발', '씨바', '씨빨', '시빨', '씨불', '시불', '씨부럴', '시부럴', '씨부랄', '시부랄',
  '씹년', '씹놈', '씹새', '씹창', '씹할', '씹쌔', '씹탱',
  '병신', '븅신', '빙신', '병쉰',
  '좆', '좃', '존나', '졸라', '존니',
  '지랄', '지럴', '썅', '쌍놈', '쌍년',
  '새끼', '새키', '섀끼', '쉐끼', '개새끼', '개새기', '개쉑', '개색기', '개색끼', '개쉐리',
  '개년', '개놈', '개같은',
  '미친년', '미친놈', '미친새',
  '니애미', '니에미', '니엄마', '니미럴', '니미랄', '느금', '엠창', '앰창', '애미', '니년', '니놈',
  '창녀', '창년', '걸레', '보지', '자지', '섹스', '야동', '강간', '딸딸이', '후장', '젖까', '엿먹',
  '호로새끼', '호로자식', '뻑큐', '뻐큐',
  // Korean slurs
  '짱깨', '짱개', '쪽바리', '쪽발이', '김치녀', '된장녀', '맘충', '틀딱', '한남충', '급식충',
  // jamo shorthand
  'ㅅㅂ', 'ㅆㅂ', 'ㅂㅅ', 'ㅄ', 'ㅈㄹ', 'ㅗㅗ',
  // English profanity
  'fuck', 'fck', 'fvck', 'shit', 'bitch', 'cunt', 'asshole', 'motherfucker', 'bastard', 'wanker',
  'twat', 'whore', 'slut', 'skank', 'douche', 'dickhead', 'cocksucker', 'blowjob', 'handjob',
  'jerkoff', 'dildo', 'cumshot', 'jizz', 'penis', 'vagina', 'tits', 'porn',
  // English slurs and hate
  'nigger', 'nigga', 'faggot', 'fagot', 'retard', 'tranny', 'kike', 'chink', 'wetback',
  'pedophile', 'paedophile', 'nazi', 'hitler',
];

/** Leet / symbol substitutions applied before the letters-only pass. */
const LEET: Readonly<Record<string, string>> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', '$': 's', '!': 'i', '|': 'l', '+': 't', '€': 'e', '£': 'l',
};

const LETTER = /[\p{L}\p{M}]/u;

/** NFKC, lower case, no whitespace. The starting point of every variant. */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

/** Letters only (digits, punctuation and symbols dropped). */
function lettersOnly(s: string): string {
  let out = '';
  for (const ch of s) if (LETTER.test(ch)) out += ch;
  return out;
}

/** Leet characters mapped to letters, then letters only. */
function leetMapped(s: string): string {
  let out = '';
  for (const ch of s) out += LEET[ch] ?? ch;
  return lettersOnly(out);
}

/**
 * Runs of one character shortened: `keep` = 1 collapses every run to one
 * character (`fuuuck` → `fuck`), `keep` = 2 only shortens runs of three or
 * more to a double (`niggga` → `nigga`) so doubled letters in a term survive.
 * Only names are collapsed, never terms — otherwise `niga` (a Korean
 * romanisation) would meet the collapsed `nigga`.
 */
export function collapseRuns(s: string, keep: 1 | 2 = 1): string {
  return keep === 1 ? s.replace(/(.)\1+/gu, '$1') : s.replace(/(.)\1{2,}/gu, '$1$1');
}

/** The shapes a name is matched in (deduplicated, never empty strings). */
export function nameVariants(name: string): string[] {
  const base = normalizeName(name);
  const shapes = [base, lettersOnly(base), leetMapped(base)];
  const out: string[] = [];
  for (const s of shapes) if (s && !out.includes(s)) out.push(s);
  return out;
}

/** A term as it is compared: normalised the same way as the name, punctuation kept out. */
function normalizeTerm(term: string): string {
  return lettersOnly(normalizeName(term));
}

/**
 * Parse an operator blocklist file: JSON `{ "words": [...] }` (the shipped
 * format) or one term per line (`#` comments allowed). Unusable input → [].
 */
export function parseBlocklist(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const list = Array.isArray(parsed) ? parsed : (parsed as { words?: unknown } | null)?.words;
      return Array.isArray(list) ? list.filter((w): w is string => typeof w === 'string' && w.trim().length > 0) : [];
    } catch {
      return [];
    }
  }
  return trimmed.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

/** Operator additions read from names.blocklist.json at load. */
export const EXTRA_BLOCKLIST: readonly string[] = parseBlocklist(JSON.stringify(extra));

/**
 * The blocked term a name contains, or null. `extra` defaults to the file's
 * words; tests and the admin CLI pass their own.
 */
export function badNameMatch(name: string, extra: Iterable<string> = EXTRA_BLOCKLIST): string | null {
  const variants = nameVariants(name);
  if (!variants.length) return null;
  // the name in every shape: as is, runs of 3+ shortened to 2, every run shortened to 1
  const shapes = [...variants, ...variants.map((v) => collapseRuns(v, 2)), ...variants.map((v) => collapseRuns(v, 1))];
  for (const term of [...BUILTIN_BLOCKLIST, ...extra]) {
    const t = normalizeTerm(term);
    if (!t) continue;
    if (shapes.some((v) => v.includes(t))) return term;
  }
  return null;
}

/** True when the name must be refused (400 'bad-name'). */
export function isBadName(name: string, extra: Iterable<string> = EXTRA_BLOCKLIST): boolean {
  return badNameMatch(name, extra) !== null;
}
