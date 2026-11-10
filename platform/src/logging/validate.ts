import { readFileSync } from 'node:fs';
import { Ajv2020, type AnySchemaObject, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

export interface LogRecordValidation {
  valid: boolean;
  errors: string[];
}

interface Validators {
  record: ValidateFunction;
  /** One validator per top-level property of the contract. */
  fields: ReadonlyMap<string, ValidateFunction>;
}

let compiled: Validators | undefined;

// The contract constrains every value with pattern, enum or range and uses no `format` keyword, so no formats are registered.
function validators(): Validators {
  if (compiled === undefined) {
    const schema = JSON.parse(
      readFileSync(new URL('../../contracts/log-record.v1.json', import.meta.url), 'utf8'),
    ) as AnySchemaObject;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    const properties = Object.entries(schema.properties as Record<string, AnySchemaObject>);
    compiled = {
      record: ajv.compile(schema),
      fields: new Map(properties.map(([key, property]) => [key, ajv.compile(property)])),
    };
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
  const validate = validators().record;
  if (validate(record)) {
    return { valid: true, errors: [] };
  }
  return { valid: false, errors: (validate.errors ?? []).map(formatError) };
}

/** Whether `value` satisfies the log-record.v1 schema of top-level property `key`; unknown keys are invalid. */
export function isValidLogField(key: string, value: unknown): boolean {
  return validators().fields.get(key)?.(value) === true;
}
