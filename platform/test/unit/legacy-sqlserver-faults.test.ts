// Tests SQL Server's failures of Masa's statements, held to the legacy oracle's debug pages and SQL Server 2022's own messages.
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  LegacyFaultError,
  LegacyQueryFault,
  intConversionFault,
  intOverflowFault,
  nullInsertFault,
  numericPrecisionFault,
  primaryKeyFault,
  queryFaultResponse,
  sqlServerFloatText,
  statementFault,
  statementValues,
  truncationFault,
  type InlineNumber,
  type StatementColumn,
  type StatementValue,
} from '../../src/legacy-compat/index.js';
import { answeringQueryFault } from '../../src/service-kit/index.js';

const DRIVER = '[Macromedia][SQLServer JDBC Driver][SQLServer]';
const DATABASE = 'muradb_c60';
const ENV = { MURA_DATABASE: DATABASE, MURA_DATASOURCE: 'muradb' };
const DATA_EXCEPTION = 'java.sql.SQLDataException';
const MINUS_VARBINARY = 'Invalid operator for data type. Operator equals minus, type equals varbinary.';
const VARBINARY_METHOD = 'Cannot call methods on varbinary.';

describe('sqlServerFloatText', () => {
  // Own oracle: the value Msg 232 printed for each float rate posted to saveRate.cfm (scratch captures saverate-e_*, -f_*, -exp*).
  it.each<[string, string]>([
    ['1e10', '10000000000.000000'],
    ['1e+10', '10000000000.000000'],
    ['-1e10', '-10000000000.000000'],
    ['2.1474836485E9', '2147483648.500000'],
    ['3.3e9', '3300000000.000000'],
    ['1e30', '1000000000000000000000000000000.000000'],
    [`1${'0'.repeat(40)}e0`, `1${'0'.repeat(40)}.000000`],
    ['1.2345678901234567890e30', '1234567890123456800000000000000.000000'],
    ['9007199254740993e0', '9007199254740992.000000'],
    ['2147483648.123456789e0', '2147483648.123457'],
    ['1e308', `1${'0'.repeat(308)}.000000`],
    ['1.7976931348623157e308', `17976931348623157${'0'.repeat(292)}.000000`],
    ['0.000001e16', '10000000000.000000'],
    ['1.23456789012345678e15', '1234567890123456.700000'],
    ['123456789.987654321e3', '123456789987.654330'],
    ['2147483647.9999999e0', '2147483648.000000'],
    ['2147483647.99999999999e0', '2147483648.000000'],
    ['140737488355328.15625e0', '140737488355328.160000'],
    ['140737488355328.375e0', '140737488355328.370000'],
    ['140737488355328.125e0', '140737488355328.120000'],
    ['140737488355328.21875e0', '140737488355328.220000'],
    ['-1234567890123456.75e0', '-1234567890123456.700000'],
    ['2147483648.1234567e0', '2147483648.123457'],
    ['2147483648.0000005e0', '2147483648.000001'],
    ['9999999999.9999999e0', '10000000000.000000'],
    ['-2147483649e0', '-2147483649.000000'],
  ])('prints the float %s as %s', (literal, expected) => {
    expect(sqlServerFloatText(Number(literal))).toBe(expected);
  });
});

describe('statementFault', () => {
  // Oracle: SQL Server 2022 16.0.4305.5 converting each literal into the column type, SQLSTATEs as the legacy driver reports
  // them; the Infinity, NaN and hex float literals from the legacy debug pages of identity's and people's user saves.
  it.each<[string, InlineNumber['type'], string, string]>([
    ['300', 'tinyint', '22003', 'Arithmetic overflow error for data type tinyint, value = 300.'],
    ['-1', 'tinyint', '22003', 'Arithmetic overflow error for data type tinyint, value = -1.'],
    ['0300', 'tinyint', '22003', 'Arithmetic overflow error for data type tinyint, value = 300.'],
    ['+300', 'tinyint', '22003', 'Arithmetic overflow error for data type tinyint, value = 300.'],
    ['256', 'tinyint', '22003', 'Arithmetic overflow error for data type tinyint, value = 256.'],
    ['2147483647', 'tinyint', '22003', 'Arithmetic overflow error for data type tinyint, value = 2147483647.'],
    ['-2147483648', 'tinyint', '22003', 'Arithmetic overflow error for data type tinyint, value = -2147483648.'],
    ['2147483648', 'tinyint', '22001', 'Arithmetic overflow error converting expression to data type tinyint.'],
    ['-2147483649', 'tinyint', '22001', 'Arithmetic overflow error converting expression to data type tinyint.'],
    ['300.5', 'tinyint', '22001', 'Arithmetic overflow error converting expression to data type tinyint.'],
    ['256.0', 'tinyint', '22001', 'Arithmetic overflow error converting expression to data type tinyint.'],
    ['-1.0', 'tinyint', '22001', 'Arithmetic overflow error converting expression to data type tinyint.'],
    ['1e3', 'tinyint', '22003', 'Arithmetic overflow error for type tinyint, value = 1000.000000.'],
    ['2.56e2', 'tinyint', '22003', 'Arithmetic overflow error for type tinyint, value = 256.000000.'],
    ['-1e0', 'tinyint', '22003', 'Arithmetic overflow error for type tinyint, value = -1.000000.'],
    ['-2.565e2', 'tinyint', '22003', 'Arithmetic overflow error for type tinyint, value = -256.500000.'],
    ['3.001e2', 'tinyint', '22003', 'Arithmetic overflow error for type tinyint, value = 300.100000.'],
    ['256.0000005e0', 'tinyint', '22003', 'Arithmetic overflow error for type tinyint, value = 256.000001.'],
    ['256.0000004e0', 'tinyint', '22003', 'Arithmetic overflow error for type tinyint, value = 256.000000.'],
    ['256.0000015e0', 'tinyint', '22003', 'Arithmetic overflow error for type tinyint, value = 256.000002.'],
    ['256.1234565e0', 'tinyint', '22003', 'Arithmetic overflow error for type tinyint, value = 256.123456.'],
    ['1e20', 'tinyint', '22003', 'Arithmetic overflow error for type tinyint, value = 100000000000000000000.000000.'],
    ['1.23456789012345678e25', 'tinyint', '22003', 'Arithmetic overflow error for type tinyint, value = 12345678901234568000000000.000000.'],
    ['1e300', 'tinyint', '22003', `Arithmetic overflow error for type tinyint, value = 10000000000000001${'0'.repeat(284)}.000000.`],
    ['3e9', 'int', '22003', 'Arithmetic overflow error for type int, value = 3000000000.000000.'],
    ['2147483648', 'int', '22001', 'Arithmetic overflow error converting expression to data type int.'],
    [`1${'0'.repeat(39)}`, 'tinyint', '22003', `The number '1${'0'.repeat(39)}' is out of the range for numeric representation (maximum precision 38).`],
    ['', 'int', 'HY000', "Incorrect syntax near ','."],
    ['Infinity', 'tinyint', '42S22', "Invalid column name 'Infinity'."],
    ['-Infinity', 'tinyint', '42S22', "Invalid column name 'Infinity'."],
    ['+NaN', 'tinyint', '42S22', "Invalid column name 'NaN'."],
    ['NaN', 'int', '42S22', "Invalid column name 'NaN'."],
    ['0x1p3', 'tinyint', 'HY000', "Incorrect syntax near 'p3'."],
    ['0X1P3', 'tinyint', 'HY000', "Incorrect syntax near 'P3'."],
    ['0x1p-2', 'tinyint', 'HY000', "Incorrect syntax near 'p'."],
    ['+0x1p+2', 'tinyint', 'HY000', "Incorrect syntax near 'p'."],
    ['0x1p1024', 'tinyint', 'HY000', "Incorrect syntax near 'p1024'."],
    ['0x1p3', 'float', 'HY000', "Incorrect syntax near 'p3'."],
    ['-0x1p3', 'tinyint', 'HY000', MINUS_VARBINARY],
    ['0x1.8p1', 'int', 'HY000', "Incorrect syntax near '.8'."],
    ['0x.8p1', 'tinyint', 'HY000', "Incorrect syntax near '.8'."],
    ['-0x1.8p1', 'tinyint', 'HY000', "Incorrect syntax near '.8'."],
    ['0x1.8ep1', 'tinyint', 'HY000', "Incorrect syntax near '.8e'."],
    ['0xa.Bp0', 'tinyint', 'HY000', VARBINARY_METHOD],
    ['-0xa.Bp0', 'tinyint', 'HY000', VARBINARY_METHOD],
    ['0x1.p1', 'tinyint', 'HY000', VARBINARY_METHOD],
  ])('fails the inline %s into a %s column as SQL Server does', (text, type, errorCode, message) => {
    expect(statementFault('SQL', 't', [{ type, text }], ENV)).toMatchObject({ sql: 'SQL', errorCode, detail: `${DRIVER}${message}` });
  });

  it.each(['255', '255.9', '-0.5', '.5', '1.', '1.5', '1e2', '2.55e2', '255.5e0', '-0.5e0', '1e-2', '-1e-300', '0.0e0'])(
    'stores the inline %s in a tinyint column, as SQL Server truncates it',
    (text) => {
      expect(statementFault('SQL', 't', [{ type: 'tinyint', text }], ENV)).toBeUndefined();
    },
  );

  // Oracle: the legacy debug pages of identity's group saves inlining several such literals.
  it.each<[string, StatementValue[], string]>([
    ['an empty inline value after a text value its column cannot hold', [{ column: 'a', width: 1, value: 'xx' }, { type: 'int', text: '' }], "Incorrect syntax near ','."],
    ['a hex float it cannot parse after an Infinity it cannot bind', [{ type: 'tinyint', text: 'Infinity' }, { type: 'int', text: '0x1p3' }], "Incorrect syntax near 'p3'."],
    ['a hex float it cannot parse after one it cannot bind', [{ type: 'tinyint', text: '0xa.Bp0' }, { type: 'int', text: '0x1p3' }], "Incorrect syntax near 'p3'."],
    ['the first of two hex floats it cannot parse', [{ type: 'tinyint', text: '-0x1p3' }, { type: 'int', text: '0x1p3' }], MINUS_VARBINARY],
    ['an empty value after an Infinity', [{ type: 'tinyint', text: 'Infinity' }, { type: 'tinyint', text: '' }], "Incorrect syntax near ','."],
    ['an Infinity after a value its column cannot hold', [{ type: 'tinyint', text: '300' }, { type: 'tinyint', text: 'Infinity' }], "Invalid column name 'Infinity'."],
    ['the first of an Infinity and a NaN', [{ type: 'tinyint', text: 'Infinity' }, { type: 'int', text: 'NaN' }], "Invalid column name 'Infinity'."],
  ])('fails on the parse, then the binding, then the conversion of its values: %s', (_label, values, message) => {
    expect(statementFault('SQL', 't', values, ENV)?.detail).toBe(`${DRIVER}${message}`);
  });

  it.each<[string | null, number]>([
    [null, 3],
    ['abc   ', 3],
  ])('stores the text %j in a column of %i characters, as ANSI_WARNINGS cuts trailing spaces', (value, width) => {
    expect(statementFault('SQL', 't', [{ column: 'a', width, value }], ENV)).toBeUndefined();
  });

  // Oracle: people's legacy debug page of an addressURL of 250 characters, which quotes 100.
  it.each<[string, number, string]>([
    ['abc  x', 3, 'abc'],
    ['u'.repeat(250), 200, 'u'.repeat(100)],
  ])('fails the text %j in a column of %i characters, quoting %j', (value, width, quoted) => {
    expect(statementFault('SQL', 't', [{ column: 'a', width, value }], ENV)).toMatchObject({
      errorCode: 'HY000',
      detail: `${DRIVER}String or binary data would be truncated in table '${DATABASE}.dbo.t', column 'a'. Truncated value: '${quoted}'.`,
    });
  });
});

describe('statementValues', () => {
  const COLUMNS: readonly StatementColumn[] = [
    ['text', 'Name', 'name', 50],
    ['inline', 'flag', 'tinyint'],
  ];

  it.each<[Record<string, string | null>, StatementValue[]]>([
    [{ name: 'n', flag: '1' }, [{ column: 'Name', width: 50, value: 'n' }, { type: 'tinyint', text: '1' }]],
    [{ name: null }, [{ column: 'Name', width: 50, value: null }]],
  ])('reads %j in column order, skipping an absent inline value', (values, expected) => {
    expect(statementValues(COLUMNS, values)).toEqual(expected);
  });
});

describe('query faults', () => {
  it('fails a duplicate primary key with SQLSTATE 23000 quoting the key as stored', () => {
    expect(primaryKeyFault('INSERT', 'PK_t', 't', 'a, b')).toMatchObject({
      name: 'LegacyQueryFault',
      message: 'Error Executing Database Query.',
      type: 'Database',
      sql: 'INSERT',
      errorCode: '23000',
      detail: `${DRIVER}Violation of PRIMARY KEY constraint 'PK_t'. Cannot insert duplicate key in object 'dbo.t'. The duplicate key value is (a, b).`,
    });
  });

  it.each<[string, Record<string, string>, string]>([
    ['the datasource the environment names', ENV, ENV.MURA_DATASOURCE],
    ['no datasource heading without MURA_DATASOURCE', {}, ''],
  ])('answers a query fault with the legacy server_error naming its cfcatch fields: %s', (_label, env, dataSource) => {
    const response = queryFaultResponse(new LegacyQueryFault('INSERT', 'HY000', 'detail'), env);
    expect(response.status).toBe(500);
    expect(response.headers['Content-Type']).toBe('application/json;charset=utf-8');
    expect(JSON.parse(response.body)).toEqual({
      apiversion: 'v1',
      method: 'invalid',
      error: {
        message: 'Unhandled Exception',
        code: 'server_error',
        // The API serializer lower-cases the struct's keys.
        stacktrace: { message: 'Error Executing Database Query.', type: 'Database', datasource: dataSource, sql: 'INSERT', errorcode: 'HY000', detail: 'detail' },
      },
    });
  });

  it('answers a route whose write SQL Server fails with that 500, and passes its answer or any other error through', async () => {
    const fault = new LegacyQueryFault('INSERT', 'HY000', 'detail');
    const app = Fastify();
    app.get('/fault', async (_request, reply) => answeringQueryFault(reply, () => Promise.reject(fault)));
    app.get('/ok', async (_request, reply) => answeringQueryFault(reply, () => Promise.resolve({ ok: true })));
    app.get('/other', async (_request, reply) => answeringQueryFault(reply, () => Promise.reject(new Error('boom'))));
    try {
      const failed = await app.inject({ url: '/fault' });
      expect(failed.statusCode).toBe(500);
      expect(failed.headers['content-type']).toBe('application/json;charset=utf-8');
      expect(failed.body).toBe(queryFaultResponse(fault).body);
      expect((await app.inject({ url: '/ok' })).json()).toEqual({ ok: true });
      const other = await app.inject({ url: '/other' });
      expect(other.statusCode).toBe(500);
      expect(other.json()).toMatchObject({ message: 'boom' });
    } finally {
      await app.close();
    }
  });
});

describe('driver faults', () => {
  it.each<[string, LegacyFaultError, string, string]>([
    ['1007', numericPrecisionFault(`1${'0'.repeat(39)}`), `The number '1${'0'.repeat(39)}' is out of the range for numeric representation (maximum precision 38).`, DATA_EXCEPTION],
    ['8115', intConversionFault(), 'Arithmetic overflow error converting expression to data type int.', DATA_EXCEPTION],
    ['232', intOverflowFault(1e10), 'Arithmetic overflow error for type int, value = 10000000000.000000.', DATA_EXCEPTION],
    [
      '515',
      nullInsertFault(DATABASE, 'tcontentratings', 'userID'),
      `Cannot insert the value NULL into column 'userID', table '${DATABASE}.dbo.tcontentratings'; column does not allow nulls. INSERT fails.`,
      'java.sql.SQLIntegrityConstraintViolationException',
    ],
  ])('names Msg %s by its number and exception class', (errorCode, fault, message, type) => {
    expect(fault).toEqual(new LegacyFaultError(`${DRIVER}${message}`, type, { errorCode }));
  });

  // Own oracle: the truncated value Msg 2628 quoted for a contentID of 36 UTF-16 units (scratch captures saverate-cid*).
  it.each<[string, string]>([
    ['X'.repeat(36), 'X'.repeat(35)],
    [`A'${'B'.repeat(34)}`, `A''${'B'.repeat(33)}`],
    ['é'.repeat(36), 'é'.repeat(35)],
    [`${'Y'.repeat(34)} Z`, `${'Y'.repeat(34)} `],
    ['漢'.repeat(36), '?'.repeat(35)],
    ['😀'.repeat(18), '?'.repeat(35)],
    [`${'😀'.repeat(17)}ab`, `${'?'.repeat(34)}a`],
    ['€'.repeat(36), '€'.repeat(35)],
    [`${'a'.repeat(34)}漢b`, `${'a'.repeat(34)}?`],
  ])('quotes %j, truncated to its column, as %j', (value, quoted) => {
    expect(truncationFault(DATABASE, 'tcontentratings', 'contentID', value, 35)).toEqual(
      new LegacyFaultError(
        `${DRIVER}String or binary data would be truncated in table '${DATABASE}.dbo.tcontentratings', column 'contentID'. Truncated value: '${quoted}'.`,
        'java.sql.SQLException',
        { errorCode: '2628' },
      ),
    );
  });
});
