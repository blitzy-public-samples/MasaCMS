import { readFileSync } from 'node:fs';
import { Ajv2020, type AnySchemaObject, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

export interface LogRecordValidation {
  valid: boolean;
  errors: string[];
}

let compiled: ValidateFunction | undefined;

// The contract constrains every value with pattern, enum or range and uses no `format` keyword, so no formats are registered.
function validator(): ValidateFunction {
  if (compiled === undefined) {
    const schema = JSON.parse(
      readFileSync(new URL('../../contracts/log-record.v1.json', import.meta.url), 'utf8'),
    ) as AnySchemaObject;
    compiled = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  }
  return compiled;
}

function formatError(error: ErrorObject): string {
  const text = `${error.instancePath || '/'} ${error.message}`;
  return error.keyword === 'additionalProperties'
    ? `${text} (${String(error.params.additionalProperty)})`
    : text;
}

/** Validates one parsed log line against log-record.v1; errors are "<instancePath> <message>" strings. */
export function validateLogRecord(record: unknown): LogRecordValidation {
  const validate = validator();
  if (validate(record)) {
    return { valid: true, errors: [] };
  }
  return { valid: false, errors: (validate.errors ?? []).map(formatError) };
}
