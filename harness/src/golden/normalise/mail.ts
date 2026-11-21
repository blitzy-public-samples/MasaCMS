// Mailpit side effects: To, From, Subject, text body and HTML body text; dropped headers never reach the output.
import type { MailRules, NormaliseRules } from './rules.js';
import { normaliseText } from './values.js';
import type { MailMessage } from '../side-effects.js';

// Not exported: the normaliser's index re-exports ids.ts, which owns the name.
type IdOrdinals = Parameters<typeof normaliseText>[1];

/** One Mailpit message as compared; `headers` is present only when `mail.compare` keeps headers by name. */
export interface NormalisedMail {
  /** Recipients as written (display names included), sorted. */
  to: string[];
  from: string;
  subject: string;
  text: string;
  htmlText: string;
  headers?: Record<string, string[]>;
}

type SortKey = (mail: NormalisedMail) => string;

const byRecipient: SortKey = (mail) => mail.to.join(',');
const byFrom: SortKey = (mail) => mail.from;
const bySubject: SortKey = (mail) => mail.subject;
const byText: SortKey = (mail) => mail.text;
const byHtmlText: SortKey = (mail) => mail.htmlText;
const byHeaders: SortKey = (mail) => JSON.stringify(mail.headers ?? {});

// `mail.order` names, lower-cased.
const SORT_KEYS: ReadonlyMap<string, SortKey> = new Map([
  ['recipient', byRecipient],
  ['to', byRecipient],
  ['from', byFrom],
  ['subject', bySubject],
  ['text', byText],
  ['htmltext', byHtmlText],
]);

// Ties after `mail.order` fall through every field, so the order is total.
const TIE_BREAKS: readonly SortKey[] = [byRecipient, bySubject, byText, byHtmlText, byFrom, byHeaders];

// The five message fields are always compared, whatever `mail.compare` lists; any other name in it keeps that header.
const MESSAGE_FIELDS: ReadonlySet<string> = new Set(['to', 'from', 'subject', 'text', 'htmltext']);

const lowerCase = (value: string): string => value.toLowerCase();

function sortKey(name: string): SortKey {
  const key = SORT_KEYS.get(lowerCase(name));
  if (key === undefined) {
    throw new Error(`normalise rules mail.order: unknown sort key ${name}; expected one of ${[...SORT_KEYS.keys()].join(', ')}`);
  }
  return key;
}

function comparator(order: readonly string[]): (a: NormalisedMail, b: NormalisedMail) => number {
  const keys = [...order.map(sortKey), ...TIE_BREAKS];
  return (a, b) => {
    for (const key of keys) {
      const x = key(a);
      const y = key(b);
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };
}

/** Header names `mail.compare` keeps, sorted, minus `mail.dropHeaders` and a scenario's dropped headers. */
function keptHeaders(mail: MailRules, droppedByScenario: readonly string[]): string[] {
  const dropped = new Set([...mail.dropHeaders, ...droppedByScenario].map(lowerCase));
  const kept = new Map<string, string>();
  for (const name of mail.compare) {
    const folded = lowerCase(name);
    if (!MESSAGE_FIELDS.has(folded) && !dropped.has(folded) && !kept.has(folded)) kept.set(folded, name);
  }
  return [...kept.values()].sort();
}

// SMTP encoders differ in line endings and trailing whitespace only.
function bodyLines(body: string): string {
  return body.replaceAll('\r\n', '\n').replace(/[^\S\n]+$/gm, '').trimEnd();
}

function headerValues(
  headers: Readonly<Record<string, readonly string[]>>,
  kept: readonly string[],
  text: (s: string) => string,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const name of kept) {
    const folded = lowerCase(name);
    const values = Object.entries(headers)
      .filter(([key]) => lowerCase(key) === folded)
      .flatMap(([, value]) => value);
    if (values.length > 0) out[name] = values.map(text);
  }
  return out;
}

// Fields in a fixed order, so ids are numbered by position. Reset links (userUtility.cfc:511-568) carry a fresh
// returnID and the user id, which normaliseText turns into tokens and ordinals rather than stripping.
function normaliseOne(
  message: MailMessage,
  kept: readonly string[],
  state: IdOrdinals,
  rules: NormaliseRules,
): NormalisedMail {
  const text = (s: string): string => normaliseText(s, state, rules);
  const mail: NormalisedMail = {
    to: [...message.to].sort(),
    from: message.from,
    subject: text(message.subject),
    text: text(bodyLines(message.text)),
    htmlText: text(bodyLines(message.htmlText)),
  };
  if (kept.length > 0) mail.headers = headerValues(message.headers, kept, text);
  return mail;
}

/**
 * Messages normalised for comparison and sorted by `mail.order`, every other field breaking ties, so Mailpit
 * arrival order never matters.
 * @param state The scenario side's id ordinals; numbering continues from the steps.
 */
export function normaliseMail(
  messages: readonly MailMessage[],
  state: IdOrdinals,
  rules: NormaliseRules,
): NormalisedMail[] {
  const kept = keptHeaders(rules.mail, rules.overrides.applied.dropHeaders);
  const compare = comparator(rules.mail.order);
  // Each message is first normalised from a copy of the state, so the numbering order follows content, not arrival.
  return messages
    .map((message) => ({ message, key: normaliseOne(message, kept, structuredClone(state), rules) }))
    .sort((a, b) => compare(a.key, b.key))
    .map(({ message }) => normaliseOne(message, kept, state, rules))
    .sort(compare);
}
