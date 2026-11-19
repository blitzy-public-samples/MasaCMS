import { describe, expect, it } from 'vitest';
import {
  DEBUGGING_ENABLED_TEMPLATE,
  EMPTY_WDDX_PACKET_FAULT,
  LEGACY_ERROR_PAGE_HTML,
  LegacyFaultError,
  type LegacyFaultFields,
  UNSET_USER_BEAN_FAULT,
  debuggingEnabledOf,
  legacyDebugPageHtml,
  legacyDebuggingEnabled,
  legacyErrorResponse,
  legacyFaultOf,
  legacyFaultOfTrace,
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

  it.each<[string, LegacyFaultFields, string]>([
    [
      'every field',
      { dataSource: 'muradb', sql: 'INSERT', errorCode: 'HY000', detail: 'cut', extendedInfo: 'more' },
      '<h2>[m]<br /></h2><h3>Datasource:[muradb]<br /></h3><h4>SQL:[INSERT]<br /></h4><h3>Code:[HY000]<br /></h3>' +
        '<h3>Type:[Database]<br /></h3><h3>[cut]<br /></h3><h3>[more]<br /></h3></div>',
    ],
    ['a code alone', { errorCode: '2628' }, '<h2>[m]<br /></h2><h3>Code:[2628]<br /></h3><h3>Type:[Database]<br /></h3></div>'],
    ['a detail alone', { detail: 'd' }, '<h2>[m]<br /></h2><h3>Type:[Database]<br /></h3><h3>[d]<br /></h3></div>'],
    ['empty fields', { dataSource: '', sql: '', errorCode: '', detail: '', extendedInfo: '' }, '<h2>[m]<br /></h2><h3>Type:[Database]<br /></h3></div>'],
  ])("prints %s in onError's heading order", (_label, fields, tail) => {
    const page = legacyDebugPageHtml(new LegacyFaultError('m', 'Database', fields), marked);
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

  it('carries its other fields through its stacktrace in heading order, leaving out the ones it lacks', () => {
    const fault = new LegacyFaultError('m', 'Database', { detail: 'd', errorCode: '515', sql: 'S' });
    expect(Object.entries(fault.trace())).toStrictEqual([
      ['Message', 'm'],
      ['Type', 'Database'],
      ['Sql', 'S'],
      ['ErrorCode', '515'],
      ['Detail', 'd'],
    ]);
    expect(LegacyFaultError.fromTrace(fault.trace())).toEqual(fault);
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

  it('reads each other field the stacktrace legacyErrorResponse writes, and of any key case, as text only', () => {
    const fault = new LegacyFaultError('m', 'Database', { dataSource: 'muradb', sql: 'S', errorCode: 'HY000', detail: 'd', extendedInfo: 'x' });
    const written: unknown = JSON.parse(legacyErrorResponse('server_error', { stacktrace: fault.trace() }).body);
    expect(legacyFaultOf(written)).toEqual(fault);
    const lower = { error: { stacktrace: { message: 'm', type: 'Database', datasource: 'muradb', errorcode: 2628, DETAIL: 'd' } } };
    expect(legacyFaultOf(lower)).toEqual(new LegacyFaultError('m', 'Database', { dataSource: 'muradb', detail: 'd' }));
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

  it('reads a bare stacktrace struct as the envelope reads it, and none from a value that is not one', () => {
    expect(legacyFaultOfTrace(EMPTY_WDDX_PACKET_FAULT)).toEqual(LegacyFaultError.fromTrace(EMPTY_WDDX_PACKET_FAULT));
    expect(legacyFaultOfTrace({ message: 'm', TYPE: 'Application', sql: 'S' })).toEqual(new LegacyFaultError('m', 'Application', { sql: 'S' }));
    expect([undefined, null, 'trace', { Message: 'm' }].map(legacyFaultOfTrace)).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe('legacyRuntimeErrorResponse', () => {
  const fault = new LegacyFaultError('Element CONTENTID is undefined in FORM.');

  const htmlHead = '<script type="text/javascript">var dtExample="11/315/2024";</script>';

  it.each<[string, LegacyFaultError | undefined, boolean, string | undefined, string]>([
    ['a fault with debugging on', fault, true, undefined, SAVE_RATE_PAGE],
    ['a fault with debugging off', fault, false, undefined, LEGACY_ERROR_PAGE_HTML],
    ['an error the target cannot name, debugging on', undefined, true, undefined, LEGACY_ERROR_PAGE_HTML],
    // Own oracle datamanager-edit-valid-nohour1: the view's cfhtmlhead text precedes the page.
    ['a fault after cfhtmlhead with debugging on', fault, true, htmlHead, htmlHead + SAVE_RATE_PAGE],
    // cfcontent reset discards it (probe: cfhtmlhead, then a fault whose onError resets and includes error.html).
    ['a fault after cfhtmlhead with debugging off', fault, false, htmlHead, LEGACY_ERROR_PAGE_HTML],
    ['an error the target cannot name after cfhtmlhead', undefined, true, htmlHead, LEGACY_ERROR_PAGE_HTML],
  ])('answers %s at 500 An Error Occurred', (_label, error, debuggingEnabled, head, body) => {
    const opts = { debuggingEnabled, encodeHtml: (text: string) => text, ...(head === undefined ? {} : { htmlHead: head }) };
    expect(legacyRuntimeErrorResponse(error, opts)).toStrictEqual({
      status: 500,
      statusText: 'An Error Occurred',
      headers: { 'Content-Type': 'text/html;charset=UTF-8' },
      body,
    });
  });
});
