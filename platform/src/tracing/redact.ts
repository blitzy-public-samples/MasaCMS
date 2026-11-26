// Telemetry privacy boundary: every exported span and recorded exception passes through here.
import type { Attributes, AttributeValue, Exception } from '@opentelemetry/api';
import { REDACTED, redactText } from '../logging/redact.js';
import { isSafeErrorText, safeErrorMessage, safeErrorStack, safeStackText } from '../logging/safe-error.js';
import type { ReadableSpan, SpanExporter } from './sdk.js';

// Every quantifier stops at a delimiter its own class excludes or runs to the end once, so each pattern is linear.

/** Query of a URL or request target, up to its fragment. */
const URL_QUERY = /\?[^#]*/;

/** One parameter of a query string. */
const QUERY_PARAM = /[^?&]+/g;

/** SQL quoted identifier (`keep`), comment, literal (`'…'`, `E'…'`, `$tag$…$tag$`, number) or unterminated or nesting token to the end. */
const SQL_TOKEN =
  /(?<keep>"(?:[^"]|"")*")|--[^\r\n]*|\/\*(?:[^*/]|\*(?!\/)|\/(?!\*))*\*\/|\/\*[\s\S]*|\b[Ee]'(?:[^'\\]|\\[\s\S]|'')*'?|'(?:[^']|'')*'?|(?<![\w$])\$(?<tag>[A-Za-z_]\w*)?\$[\s\S]*?(?:\$\k<tag>\$|$)|"[\s\S]*|(?<![\w$\x80-\uFFFF])\.?\d(?:[eE][+-]\d|[\w$.\x80-\uFFFF])*/g;

/** Captured credential header attributes. */
const CREDENTIAL_HEADER_KEY =
  /^http\.(?:request|response)\.header\.(?:(?:(?:proxy|x[-_]serverless)[-_])?authorization|(?:set[-_])?cookie)$/i;

/** Bound SQL parameter values. */
const BIND_VALUES_KEY = /^db\.(?:postgresql\.values$|query\.parameter\.)/;

/** Path segment after `/sessions/` or `/legacy-sessions/`, where session ids travel. */
const SESSION_SEGMENT = /(\/(?:legacy-)?sessions\/)([^/?#]+)/gi;

/** Session segments naming a resource or a route-template parameter rather than a session. */
const SESSION_RESOURCE = /^(?:current|login|logout)$|^[:{]/;

/** Custom-method suffix of a last path segment, such as `:end` or `:mark-used`. */
const METHOD_SUFFIX = /^:[a-z-]+$/;

const URL_KEYS = new Set(['url.full', 'url.original', 'url.path', 'http.url', 'http.target']);
const SQL_KEYS = new Set(['db.query.text', 'db.statement']);

type Rule = (text: string) => string;

/** Masks each query parameter value; a parameter with no or an empty value (`a`, `a=`) may itself be a value and is masked whole. */
function maskQuery(query: string): string {
  return query.replace(QUERY_PARAM, (param) => {
    const eq = param.indexOf('=');
    return eq < 0 || eq === param.length - 1 ? REDACTED : `${param.slice(0, eq + 1)}${REDACTED}`;
  });
}

/** Masks session ids in `/sessions/` and `/legacy-sessions/` paths, keeping a last segment's custom-method suffix; idempotent. */
function maskSessionPath(text: string): string {
  return text.replace(SESSION_SEGMENT, (match: string, prefix: string, segment: string, offset: number) => {
    if (SESSION_RESOURCE.test(segment)) return match;
    const colon = segment.lastIndexOf(':');
    const suffix = colon < 0 ? '' : segment.slice(colon);
    const last = text[offset + match.length] !== '/';
    return `${prefix}${REDACTED}${last && METHOD_SUFFIX.test(suffix) ? suffix : ''}`;
  });
}

/** Replacement for one `SQL_TOKEN` match: identifiers stay, comments keep only their delimiters, numbers and literals are masked. */
function maskSqlToken(token: string, keep?: string): string {
  if (keep !== undefined) return keep;
  if (token.startsWith('--')) return `-- ${REDACTED}`;
  if (token.startsWith('/*')) return `/* ${REDACTED} */`;
  return /^\.?\d/.test(token) ? REDACTED : `'${REDACTED}'`;
}

const mask: Rule = () => REDACTED;
const sql: Rule = (text) => redactText(text.replace(SQL_TOKEN, maskSqlToken));
const query: Rule = (text) => redactText(maskQuery(text));
const url: Rule = (text) => redactText(maskSessionPath(text).replace(URL_QUERY, maskQuery));
const path: Rule = (text) => redactText(maskSessionPath(text));

/** Keeps error text only when it is a fixed safe text, since arbitrary error text may carry personal data. */
const safeError: Rule = (text) => (isSafeErrorText(text) ? text : REDACTED);

/** Rule for `exception.stacktrace`: its frames under the exception type and safe message beside it in `attributes`. */
function stackRule(attributes: Attributes): Rule {
  const { 'exception.type': type, 'exception.message': message } = attributes;
  const safe = typeof message === 'string' ? safeError(message) : REDACTED;
  const header = typeof type === 'string' ? `${redactText(type)}: ${safe}` : safe;
  return (text) => safeStackText(text, header);
}

/** Masking rule for the attribute named `key`. */
function ruleFor(key: string): Rule {
  if (CREDENTIAL_HEADER_KEY.test(key) || BIND_VALUES_KEY.test(key)) return mask;
  if (key === 'url.query') return query;
  if (URL_KEYS.has(key)) return url;
  if (key === 'exception.message') return safeError;
  return SQL_KEYS.has(key) ? sql : redactText;
}

/** `item` with `rule` applied to a string; `mask` also replaces a number or boolean, which other rules keep. */
function redactItem(item: unknown, rule: Rule): unknown {
  if (typeof item === 'string') return rule(item);
  return rule !== mask || item === null || item === undefined ? item : REDACTED;
}

/** Applies `rule` to a value or to each element of an array value. */
function redactValue(value: AttributeValue | undefined, rule: Rule): AttributeValue | undefined {
  if (!Array.isArray(value)) return redactItem(value, rule) as AttributeValue | undefined;
  return (value as unknown[]).map((item) => redactItem(item, rule)) as AttributeValue;
}

/** Copy of `attributes` with each value masked by the rule for its key. */
function redactAttributes(attributes: Attributes): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    result[key] = redactValue(value, key === 'exception.stacktrace' ? stackRule(attributes) : ruleFor(key));
  }
  return result;
}

/** Copy of `span` with sensitive text masked; ids, parents, kind, timing, resource and scope are unchanged. */
function redactSpan(span: ReadableSpan): ReadableSpan {
  const { status } = span;
  return {
    name: Object.keys(span.attributes).some((key) => SQL_KEYS.has(key)) ? sql(span.name) : path(span.name),
    kind: span.kind,
    spanContext: () => span.spanContext(),
    parentSpanContext: span.parentSpanContext,
    startTime: span.startTime,
    endTime: span.endTime,
    status: status.message === undefined ? status : { ...status, message: safeError(status.message) },
    attributes: redactAttributes(span.attributes),
    links: span.links.map((link) => ({ ...link, attributes: link.attributes && redactAttributes(link.attributes) })),
    events: span.events.map((event) => ({
      ...event,
      name: redactText(event.name),
      attributes: event.attributes && redactAttributes(event.attributes),
    })),
    duration: span.duration,
    ended: span.ended,
    resource: span.resource,
    instrumentationScope: span.instrumentationScope,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
  } satisfies Record<keyof ReadableSpan, unknown>;
}

/** Span exporter that hands `delegate` redacted copies of every span, leaving the originals untouched. */
export class RedactingSpanExporter implements SpanExporter {
  constructor(private readonly delegate: SpanExporter) {}

  export(spans: ReadableSpan[], resultCallback: Parameters<SpanExporter['export']>[1]): void {
    this.delegate.export(spans.map(redactSpan), resultCallback);
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush?.() ?? Promise.resolve();
  }
}

/** `err` as `Span.recordException` input: its name and code, a message of its safe identifiers and only its stack frames. */
export function redactException(err: unknown): Exception {
  const message = safeErrorMessage(err);
  if (!(err instanceof Error)) return message;
  const { code } = err as { code?: unknown };
  return {
    name: err.name,
    message,
    stack: safeErrorStack(err, `${err.name}: ${message}`),
    code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
  };
}
