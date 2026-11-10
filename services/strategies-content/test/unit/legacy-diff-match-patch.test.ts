// Fidelity of the diff_match_patch port: reference vectors, outputs of the bundled jar on Java 17, and captured carch.loaddiff bodies.
import { describe, expect, it } from 'vitest';
import {
  computeDiff,
  type Diff,
  DiffOp,
  diffCleanupSemantic,
  diffMain,
  diffPrettyHtml,
  diffText1,
  diffText2,
} from '../../src/legacy/diff-match-patch.js';

const { DELETE, INSERT, EQUAL } = DiffOp;
const ins = (text: string): string => `<ins style="background:#e6ffe6;">${text}</ins>`;
const del = (text: string): string => `<del style="background:#ffe6e6;">${text}</del>`;
const span = (text: string): string => `<span>${text}</span>`;
const copy = (diffs: Diff[]): Diff[] => diffs.map(([op, text]): Diff => [op, text]);

describe('diffMain', () => {
  it.each<[string, string, string, number | undefined, Diff[]]>([
    ['null case', '', '', undefined, []],
    ['equality', 'abc', 'abc', undefined, [[EQUAL, 'abc']]],
    ['simple insertion', 'abc', 'ab123c', undefined, [[EQUAL, 'ab'], [INSERT, '123'], [EQUAL, 'c']]],
    ['simple deletion', 'a123bc', 'abc', undefined, [[EQUAL, 'a'], [DELETE, '123'], [EQUAL, 'bc']]],
    ['two insertions', 'abc', 'a123b456c', undefined, [[EQUAL, 'a'], [INSERT, '123'], [EQUAL, 'b'], [INSERT, '456'], [EQUAL, 'c']]],
    ['two deletions', 'a123b456c', 'abc', undefined, [[EQUAL, 'a'], [DELETE, '123'], [EQUAL, 'b'], [DELETE, '456'], [EQUAL, 'c']]],
    ['simple case #1', 'a', 'b', 0, [[DELETE, 'a'], [INSERT, 'b']]],
    ['simple case #2', 'Apples are a fruit.', 'Bananas are also fruit.', 0, [[DELETE, 'Apple'], [INSERT, 'Banana'], [EQUAL, 's are a'], [INSERT, 'lso'], [EQUAL, ' fruit.']]],
    ['simple case #3', 'ax\t', '\u0680x\u0000', 0, [[DELETE, 'a'], [INSERT, '\u0680'], [EQUAL, 'x'], [DELETE, '\t'], [INSERT, '\u0000']]],
    ['overlap #1', '1ayb2', 'abxab', 0, [[DELETE, '1'], [EQUAL, 'a'], [DELETE, 'y'], [EQUAL, 'b'], [DELETE, '2'], [INSERT, 'xab']]],
    ['overlap #2', 'abcy', 'xaxcxabc', 0, [[INSERT, 'xaxcx'], [EQUAL, 'abc'], [DELETE, 'y']]],
    [
      'overlap #3',
      'ABCDa=bcd=efghijklmnopqrsEFGHIJKLMNOefg',
      'a-bcd-efghijklmnopqrs',
      0,
      [[DELETE, 'ABCD'], [EQUAL, 'a'], [DELETE, '='], [INSERT, '-'], [EQUAL, 'bcd'], [DELETE, '='], [INSERT, '-'], [EQUAL, 'efghijklmnopqrs'], [DELETE, 'EFGHIJKLMNOefg']],
    ],
    ['large equality', 'a [[Pennsylvania]] and [[New', ' and [[Pennsylvania]]', 0, [[INSERT, ' '], [EQUAL, 'a'], [INSERT, 'nd'], [EQUAL, ' [[Pennsylvania]]'], [DELETE, ' and [[New']]],
    ['single edit shifted over the next equality', 'ba', 'abaa', undefined, [[INSERT, 'a'], [EQUAL, 'ba'], [INSERT, 'a']]],
    ['half match, second quarter seed', '1234567890', 'a345678z', undefined, [[DELETE, '12'], [INSERT, 'a'], [EQUAL, '345678'], [DELETE, '90'], [INSERT, 'z']]],
    ['half match, shorter first', 'abc56789z', '1234567890', undefined, [[DELETE, 'abc'], [INSERT, '1234'], [EQUAL, '56789'], [DELETE, 'z'], [INSERT, '0']]],
    ['half match, multiple seeds', '121231234123451234123121', 'a1234123451234z', undefined, [[DELETE, '12123'], [INSERT, 'a'], [EQUAL, '1234123451234'], [DELETE, '123121'], [INSERT, 'z']]],
    ['half match, non-optimal', 'qHilloHelloHew', 'xHelloHeHulloy', undefined, [[DELETE, 'qHillo'], [INSERT, 'x'], [EQUAL, 'HelloHe'], [DELETE, 'w'], [INSERT, 'Hulloy']]],
    [
      'no half match without a timeout',
      'qHilloHelloHew',
      'xHelloHeHulloy',
      0,
      [[DELETE, 'q'], [INSERT, 'x'], [EQUAL, 'H'], [DELETE, 'i'], [INSERT, 'e'], [EQUAL, 'lloHe'], [INSERT, 'Hu'], [EQUAL, 'llo'], [DELETE, 'Hew'], [INSERT, 'y']],
    ],
  ])('%s', (_name, text1, text2, timeoutMs, expected) => {
    const options = timeoutMs === undefined ? { checklines: false } : { checklines: false, timeoutMs };
    expect(diffMain(text1, text2, options)).toEqual(expected);
  });

  it.each<[string, string, string]>([
    ['simple line-mode', '1234567890\n'.repeat(13), 'abcdefghij\n'.repeat(13)],
    ['single line-mode', '1234567890'.repeat(13), 'abcdefghij'.repeat(13)],
  ])('%s gives the character-mode result', (_name, text1, text2) => {
    expect(diffMain(text1, text2, { timeoutMs: 0 })).toEqual(diffMain(text1, text2, { checklines: false, timeoutMs: 0 }));
  });

  it('overlap line-mode rebuilds the same texts as character mode', () => {
    const text1 = '1234567890\n'.repeat(13);
    const text2 = 'abcdefghij\n1234567890\n1234567890\n1234567890\n'.repeat(3) + 'abcdefghij\n';
    const lineMode = diffMain(text1, text2, { timeoutMs: 0 });
    expect([diffText1(lineMode), diffText2(lineMode)]).toEqual([text1, text2]);
    expect(diffText2(diffMain(text1, text2, { checklines: false, timeoutMs: 0 }))).toBe(text2);
  });

  it('bails out of diff_bisect once the injected clock passes the deadline', () => {
    let calls = 0;
    const lateClock = (): number => (calls++ === 0 ? 0 : 5000);
    expect(diffMain('1a2b3c4d', 'a5b6c7d8', { checklines: false, now: lateClock })).toEqual([
      [DELETE, '1a2b3c4d'],
      [INSERT, 'a5b6c7d8'],
    ]);
    expect(diffMain('1a2b3c4d', 'a5b6c7d8', { checklines: false, timeoutMs: 0 })).toHaveLength(12);
  });

  it('keeps large inputs reconstructible when the deadline cuts the diff short', () => {
    const text1 = '`Twas brillig, and the slithy toves\nDid gyre and gimble in the wabe:\n'.repeat(1024);
    const text2 = 'I am the very model of a modern major general,\nI know the kings of England.\n'.repeat(1024);
    let calls = 0;
    const diffs = diffMain(text1, text2, { now: () => (calls++ === 0 ? 0 : 5000) });
    expect([diffText1(diffs), diffText2(diffs)]).toEqual([text1, text2]);
    expect(diffs.map(([op]) => op)).toEqual([DELETE, INSERT, EQUAL]);
  });

  it('works on UTF-16 code units as Java does', () => {
    expect(diffMain('\uD83D\uDE00', '\uD83D\uDE01')).toEqual([
      [EQUAL, '\uD83D'],
      [DELETE, '\uDE00'],
      [INSERT, '\uDE01'],
    ]);
    expect(diffMain('ab', 'a\uD83D\uDE00b')).toEqual([
      [EQUAL, 'a'],
      [INSERT, '\uD83D\uDE00'],
      [EQUAL, 'b'],
    ]);
  });

  it('indexes more than 65535 distinct lines with wrapped codes, as Java does', () => {
    const lines = Array.from({ length: 70000 }, (_, i) => `L${i.toString(36)}`);
    const text1 = lines.join('\n');
    const text2 = [...lines.slice(0, 40000), 'CHANGED', ...lines.slice(40001)].join('\n');
    const diffs = diffMain(text1, text2);
    expect([diffText1(diffs), diffText2(diffs)]).toEqual([text1, text2]);
  });
});

describe('diffCleanupSemantic', () => {
  it.each<[string, Diff[], Diff[]]>([
    ['null case', [], []],
    ['no elimination #1', [[DELETE, 'ab'], [INSERT, 'cd'], [EQUAL, '12'], [DELETE, 'e']], [[DELETE, 'ab'], [INSERT, 'cd'], [EQUAL, '12'], [DELETE, 'e']]],
    ['no elimination #2', [[DELETE, 'abc'], [INSERT, 'ABC'], [EQUAL, '1234'], [DELETE, 'wxyz']], [[DELETE, 'abc'], [INSERT, 'ABC'], [EQUAL, '1234'], [DELETE, 'wxyz']]],
    ['simple elimination', [[DELETE, 'a'], [EQUAL, 'b'], [DELETE, 'c']], [[DELETE, 'abc'], [INSERT, 'b']]],
    ['backpass elimination', [[DELETE, 'ab'], [EQUAL, 'cd'], [DELETE, 'e'], [EQUAL, 'f'], [INSERT, 'g']], [[DELETE, 'abcdef'], [INSERT, 'cdfg']]],
    [
      'multiple elimination',
      [[INSERT, '1'], [EQUAL, 'A'], [DELETE, 'B'], [INSERT, '2'], [EQUAL, '_'], [INSERT, '1'], [EQUAL, 'A'], [DELETE, 'B'], [INSERT, '2']],
      [[DELETE, 'AB_AB'], [INSERT, '1A2_1A2']],
    ],
    ['word boundaries', [[EQUAL, 'The c'], [DELETE, 'ow and the c'], [EQUAL, 'at.']], [[EQUAL, 'The '], [DELETE, 'cow and the '], [EQUAL, 'cat.']]],
    ['no overlap elimination', [[DELETE, 'abcxx'], [INSERT, 'xxdef']], [[DELETE, 'abcxx'], [INSERT, 'xxdef']]],
    ['overlap elimination', [[DELETE, 'abcxxx'], [INSERT, 'xxxdef']], [[DELETE, 'abc'], [EQUAL, 'xxx'], [INSERT, 'def']]],
    ['reverse overlap elimination', [[DELETE, 'xxxabc'], [INSERT, 'defxxx']], [[INSERT, 'def'], [EQUAL, 'xxx'], [DELETE, 'abc']]],
    [
      'two overlap eliminations',
      [[DELETE, 'abcd1212'], [INSERT, '1212efghi'], [EQUAL, '----'], [DELETE, 'A3'], [INSERT, '3BC']],
      [[DELETE, 'abcd'], [EQUAL, '1212'], [INSERT, 'efghi'], [EQUAL, '----'], [DELETE, 'A'], [EQUAL, '3'], [INSERT, 'BC']],
    ],
    [
      'blank lines',
      [[EQUAL, 'AAA\r\n\r\nBBB'], [INSERT, '\r\nDDD\r\n\r\nBBB'], [EQUAL, '\r\nEEE']],
      [[EQUAL, 'AAA\r\n\r\n'], [INSERT, 'BBB\r\nDDD\r\n\r\n'], [EQUAL, 'BBB\r\nEEE']],
    ],
    ['line boundaries', [[EQUAL, 'AAA\r\nBBB'], [INSERT, ' DDD\r\nBBB'], [EQUAL, ' EEE']], [[EQUAL, 'AAA\r\n'], [INSERT, 'BBB DDD\r\n'], [EQUAL, 'BBB EEE']]],
    ['alphanumeric boundaries', [[EQUAL, 'The-c'], [INSERT, 'ow-and-the-c'], [EQUAL, 'at.']], [[EQUAL, 'The-'], [INSERT, 'cow-and-the-'], [EQUAL, 'cat.']]],
    ['hitting the start', [[EQUAL, 'a'], [DELETE, 'a'], [EQUAL, 'ax']], [[DELETE, 'a'], [EQUAL, 'aax']]],
    ['hitting the end', [[EQUAL, 'xa'], [DELETE, 'a'], [EQUAL, 'a']], [[EQUAL, 'xaa'], [DELETE, 'a']]],
    ['sentence boundaries', [[EQUAL, 'The xxx. The '], [INSERT, 'zzz. The '], [EQUAL, 'yyy.']], [[EQUAL, 'The xxx.'], [INSERT, ' The zzz.'], [EQUAL, ' The yyy.']]],
    ['merged edits whose common prefix has no equality before it', [[INSERT, 'abc'], [EQUAL, 'abc'], [INSERT, 'acb'], [DELETE, 'bcc']], [[EQUAL, 'abc'], [DELETE, 'bcc'], [INSERT, 'abcacb']]],
    // U+0870 is a letter in the JS engine's Unicode tables but not in Java 17's.
    ['letters newer than Java 17 #1', [[EQUAL, '\u0870ab'], [INSERT, 'ab'], [EQUAL, 'aaa']], [[EQUAL, '\u0870'], [INSERT, 'ab'], [EQUAL, 'abaaa']]],
    ['letters newer than Java 17 #2', [[EQUAL, 'a'], [INSERT, '\u0870bb'], [EQUAL, '\u0870b\u0870']], [[EQUAL, 'a\u0870'], [INSERT, 'bb\u0870'], [EQUAL, 'b\u0870']]],
  ])('%s', (_name, input, expected) => {
    const diffs = copy(input);
    expect(diffCleanupSemantic(diffs)).toBe(diffs);
    expect(diffs).toEqual(expected);
  });
});

describe('output', () => {
  it('diffPrettyHtml escapes text and wraps each operation like the Java build', () => {
    expect(diffPrettyHtml([[EQUAL, 'a\n'], [DELETE, '<B>b</B>'], [INSERT, 'c&d']])).toBe(
      '<span>a&para;<br></span><del style="background:#ffe6e6;">&lt;B&gt;b&lt;/B&gt;</del><ins style="background:#e6ffe6;">c&amp;d</ins>',
    );
  });

  it('diffText1 and diffText2 rebuild the source and destination texts', () => {
    const diffs: Diff[] = [[EQUAL, 'jump'], [DELETE, 's'], [INSERT, 'ed'], [EQUAL, ' over '], [DELETE, 'the'], [INSERT, 'a'], [EQUAL, ' lazy']];
    expect([diffText1(diffs), diffText2(diffs)]).toEqual(['jumps over the lazy', 'jumped over a lazy']);
  });
});

describe('computeDiff', () => {
  // Expected HTML is the output of core/mura/lib/diff_match_patch.jar on Java 17 for the same inputs.
  it.each<[string, string, string]>([
    ['Hello world.\n\nGoodbye world.', 'Hello world.\n\nGoodbye cruel world.', span('Hello world.&para;<br>&para;<br>Goodbye ') + ins('cruel ') + span('world.')],
    ['one two\r\n\r\nthree', 'one two\r\n\r\nfour three', span('one two\r&para;<br>\r&para;<br>') + ins('four ') + span('three')],
    ['The cat sat on the mat.', 'The dog sat on the log.', span('The ') + del('cat') + ins('dog') + span(' sat on the ') + del('mat') + ins('log') + span('.')],
    ['a & b < c > d\n', 'a & b <= c >= d\n', span('a &amp; b &lt;') + ins('=') + span(' c &gt;') + ins('=') + span(' d&para;<br>')],
    ['\uD83D\uDE00', '\uD83D\uDE01', span('\uD83D') + del('\uDE00') + ins('\uDE01')],
  ])('matches the Java build for %j', (text1, text2, html) => {
    const result = computeDiff(text1, text2);
    expect(result.html).toBe(html);
    expect([result.text1, result.text2]).toEqual([text1, text2]);
    expect(result.diffs).toEqual(diffCleanupSemantic(diffMain(text1, text2)));
  });

  // Inputs are the javaCast('string') property values of two content versions and the body is the legacy
  // carch.loaddiff response for them, both captured from Masa 7.6.1 on ACF 2023.
  const statusRows: [string, string, string][] = [
    ['STATUS', 'Archived', 'Published'],
    ['STATUSID', '3', '2'],
  ];
  const statusHtml = '<h3>STATUS</h3>' + del('Archiv') + ins('Publish') + span('ed') + '<h3>STATUSID</h3>' + del('3') + ins('2');
  it.each<[string, [string, string, string][], string]>([
    [
      'about us page',
      [
        ...statusRows,
        ['TITLE', 'About Us', 'About Our Team'],
        ['BODY', '<p>Welcome to the tenant A.</p>\n<p>Contact us today.</p>', '<p>Welcome to the Tenant A program.</p>\n<p>Contact us today.</p>'],
      ],
      statusHtml +
        '<h3>TITLE</h3>' + span('About ') + del('Us') + ins('Our Team') +
        '<h3>BODY</h3>' + span('&lt;p&gt;Welcome to the ') + del('t') + ins('T') + span('enant A') + ins(' program') +
        span('.&lt;/p&gt;&para;<br>&lt;p&gt;Contact us today.&lt;/p&gt;'),
    ],
    [
      'multi-line CRLF body in line mode',
      [
        ...statusRows,
        ['TITLE', 'Programs & Services <2026>', 'Programs and Services (2026) \u2014 Tenant A'],
        [
          'BODY',
          '<h2>Our programs</h2>\r\n<p>Tenant A runs three programs for families &amp; carers.</p>\r\n<ul>\r\n<li>Early years</li>\r\n<li>School holidays</li>\r\n<li>Youth mentoring</li>\r\n</ul>\r\n<p>Call 555-0100 to enrol. Caf\u00e9 opens at 9am.</p>',
          '<h2>Our programs</h2>\r\n<p>Tenant A now runs four programs for families &amp; carers ??.</p>\r\n<ul>\r\n<li>Early years</li>\r\n<li>Youth mentoring</li>\r\n<li>Adult learning</li>\r\n</ul>\r\n\r\n<p>Call 555-0199 to enrol. Caf\u00e9 opens at 8am.</p>',
        ],
      ],
      statusHtml +
        '<h3>TITLE</h3>' + span('Programs ') + del('&amp;') + ins('and') + span(' Services ') + del('&lt;') + ins('(') + span('2026') +
        del('&gt;') + ins(') \u2014 Tenant A') +
        '<h3>BODY</h3>' + span('&lt;h2&gt;Our programs&lt;/h2&gt;\r&para;<br>&lt;p&gt;Tenant A ') + ins('now ') + span('runs ') +
        del('three') + ins('four') + span(' programs for families &amp;amp; carers') + ins(' ??') +
        span('.&lt;/p&gt;\r&para;<br>&lt;ul&gt;\r&para;<br>&lt;li&gt;Early years&lt;/li&gt;\r&para;<br>&lt;li&gt;') +
        del('School holidays&lt;/li&gt;\r&para;<br>&lt;li&gt;Youth mentor') +
        ins('Youth mentoring&lt;/li&gt;\r&para;<br>&lt;li&gt;Adult learn') +
        span('ing&lt;/li&gt;\r&para;<br>&lt;/ul&gt;\r&para;<br>') + ins('\r&para;<br>') + span('&lt;p&gt;Call 555-01') + del('00') +
        ins('99') + span(' to enrol. Caf\u00e9 opens at ') + del('9') + ins('8') + span('am.&lt;/p&gt;'),
    ],
    [
      'line removed and line added',
      [
        ...statusRows,
        ['TITLE', 'The quick brown fox', 'The quick brown fox jumps'],
        [
          'BODY',
          'Line one of the page body that is long enough.\nLine two stays the same in both versions here.\nLine three will be removed entirely now.\nLine four is common.',
          'Line one of the page body that is long enough!\nLine two stays the same in both versions here.\nLine four is common.\nA brand new line five, added at the end.',
        ],
      ],
      statusHtml +
        '<h3>TITLE</h3>' + span('The quick brown fox') + ins(' jumps') +
        '<h3>BODY</h3>' + span('Line one of the page body that is long enough') + del('.') + ins('!') +
        span('&para;<br>Line two stays the same in both versions here.&para;<br>Line ') +
        del('three will be removed entirely now.&para;<br>Line four is common') +
        ins('four is common.&para;<br>A brand new line five, added at the end') + span('.'),
    ],
  ])('reproduces the legacy carch.loaddiff body for the %s', (_name, properties, body) => {
    const rendered = properties.map(([name, older, newer]) => `<h3>${name}</h3>${computeDiff(older, newer).html}`).join('');
    expect(rendered).toBe(body);
  });
});
