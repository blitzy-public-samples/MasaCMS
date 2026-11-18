import { describe, expect, it } from 'vitest';
import {
  DEBUGGING_ENABLED_TEMPLATE,
  LEGACY_ERROR_PAGE_HTML,
  LegacyFaultError,
  UNSET_USER_BEAN_FAULT,
  debuggingEnabledOf,
  legacyDebugPageHtml,
  legacyDebuggingEnabled,
  legacyErrorResponse,
  legacyFaultOf,
  legacyRuntimeErrorResponse,
} from '../../src/legacy-compat/index.js';

// Own oracle, debugging on: GET saveRate.cfm with no form fields, up to its `<pre>` stack trace, then the closing `</div>`.
const SAVE_RATE_PAGE =
  '<style type=""text/css"">\n\t\t.errorBox {\n\t\t\tmargin: 10px auto 10px auto;\n\t\t\twidth: 90%;\n\t\t}\n\n' +
  '\t\t.errorBox h1 {\n\t\t\tfont-size: 100px;\n\t\t\tmargin: 5px 0px 5px 0px;\n\t\t}\n\n\t</style>\n' +
  '\t<div class=""errorBox"">\n\t\t<h1>500 Error</h1><h2>Element CONTENTID is undefined in FORM.<br /></h2>' +
  '<h3>Type:Expression<br /></h3></div>';

/** A stand-in encoder that marks what it encoded. */
const marked = (text: string): string => `[${text}]`;

describe('legacyDebugPageHtml', () => {
  it("writes onError's style, errorBox and headings for a fault byte for byte, without the stack trace", () => {
    expect(legacyDebugPageHtml(new LegacyFaultError('Element CONTENTID is undefined in FORM.'), (text) => text)).toBe(SAVE_RATE_PAGE);
  });

  it.each<[string, string, string]>([
    ['Element X is undefined in RC.', 'Expression', '<h2>[Element X is undefined in RC.]<br /></h2><h3>Type:[Expression]<br /></h3></div>'],
    ['', 'Expression', '<h3>Type:[Expression]<br /></h3></div>'],
    ['Element X is undefined in RC.', '', '<h2>[Element X is undefined in RC.]<br /></h2></div>'],
    ['', '', '</div>'],
  ])('encodes message %j and type %j, writing a heading only for a non-empty value', (message, type, tail) => {
    const page = legacyDebugPageHtml({ message, type }, marked);
    expect(page.endsWith(`<h1>500 Error</h1>${tail}`)).toBe(true);
  });
});

describe('debuggingEnabledOf', () => {
  it.each<[string, boolean]>([
    ['true', true],
    ['false', false],
    ['no', false],
    ['NO', false],
    ['0', false],
    ['0.0', false],
    ['yes', true],
    ['1', true],
    ['', true],
    ['abc', true],
    ['${x}', true],
  ])('reads %j as %s', (value, enabled) => {
    expect(debuggingEnabledOf(value)).toBe(enabled);
  });

  it.each<[Record<string, string>, boolean]>([
    [{}, true],
    [{ MURA_DEBUGGINGENABLED: 'false' }, false],
    [{ MURA_DEBUGGINGENABLED: 'true' }, true],
    [{ MURA_DEBUGGINGENABLED: '' }, true],
  ])('reads the variables %j as %s, the settings template giving %j', (env, enabled) => {
    expect(DEBUGGING_ENABLED_TEMPLATE).toBe('true');
    expect(legacyDebuggingEnabled(env)).toBe(enabled);
  });
});

describe('LegacyFaultError', () => {
  it('is an Expression unless told otherwise and round-trips through its stacktrace', () => {
    const fault = new LegacyFaultError('Element HOUR1 is undefined in RC.');
    expect(fault).toBeInstanceOf(Error);
    expect(fault).toMatchObject({ name: 'LegacyFaultError', message: 'Element HOUR1 is undefined in RC.', type: 'Expression' });
    expect(fault.trace()).toStrictEqual({ Message: 'Element HOUR1 is undefined in RC.', Type: 'Expression' });
    expect(LegacyFaultError.fromTrace({ Message: 'm', Type: 'Application' })).toMatchObject({ message: 'm', type: 'Application' });
  });

  it("names cusers.cfc's unset user bean", () => {
    expect(Object.isFrozen(UNSET_USER_BEAN_FAULT)).toBe(true);
    expect(UNSET_USER_BEAN_FAULT).toStrictEqual({ Message: 'Element RC.userBean is undefined in ARGUMENTS.', Type: 'Expression' });
  });
});

describe('legacyFaultOf', () => {
  it('reads the fault of the stacktrace legacyErrorResponse writes', () => {
    const body: unknown = JSON.parse(legacyErrorResponse('server_error', { stacktrace: UNSET_USER_BEAN_FAULT }).body);
    expect(legacyFaultOf(body)).toMatchObject({ name: 'LegacyFaultError', message: UNSET_USER_BEAN_FAULT.Message, type: 'Expression' });
  });

  it('reads the envelope keys in any case, as CFML reads a struct', () => {
    expect(legacyFaultOf({ ERROR: { StackTrace: { Message: 'm', TYPE: 'Application' } } })).toMatchObject({ message: 'm', type: 'Application' });
  });

  it.each<[string, unknown]>([
    ['no body', undefined],
    ['a text body', 'Unhandled Exception'],
    ['an envelope without an error', { apiversion: 'v1' }],
    ['an error without a stacktrace', { error: { message: 'Unhandled Exception', code: 'server_error' } }],
    ['a text stacktrace', { error: { stacktrace: 'trace' } }],
    ['a stacktrace without a Type', { error: { stacktrace: { Message: 'm' } } }],
    ['a stacktrace whose Message is not text', { error: { stacktrace: { Message: 1, Type: 'Expression' } } }],
  ])('reads no fault from %s', (_label, body) => {
    expect(legacyFaultOf(body)).toBeUndefined();
  });
});

describe('legacyRuntimeErrorResponse', () => {
  const fault = new LegacyFaultError('Element CONTENTID is undefined in FORM.');

  it.each<[string, LegacyFaultError | undefined, boolean, string]>([
    ['a fault with debugging on', fault, true, SAVE_RATE_PAGE],
    ['a fault with debugging off', fault, false, LEGACY_ERROR_PAGE_HTML],
    ['an error the target cannot name, debugging on', undefined, true, LEGACY_ERROR_PAGE_HTML],
  ])('answers %s at 500 An Error Occurred', (_label, error, debuggingEnabled, body) => {
    expect(legacyRuntimeErrorResponse(error, { debuggingEnabled, encodeHtml: (text) => text })).toStrictEqual({
      status: 500,
      statusText: 'An Error Occurred',
      headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      body,
    });
  });
});
