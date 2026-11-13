/** Masa bean validation as the JSON API's `validate` runs it on ACF 2023 [legacy: core/mura/bean/beanValidator.cfc:80-480; core/mura/client/api/json/v1/jsonApiUtility.cfc:3657-3700]. */
import {
  LegacyApiError,
  LegacyServiceUnavailableError,
  cfIsDateText,
  cfIsNumeric,
  cfListToArray,
  cfParseDateTimeText,
  cfToNumber,
  isValidVariableName,
  javaTrim,
} from '@opt2/platform/legacy-compat';
import { CF_QUERY, CfNumber, CfStruct, deserializeCfJson, isSimple, simpleText, type CfArray, type CfValue } from './cfml-struct.js';

/** Exceptions-list entry of the validate cases identity cannot reproduce. */
export const VALIDATE_EXCEPTION = 'EX-GROUP-VALIDATE';

/** The legacy 503 of a halted validate case, naming its exceptions entry. */
export function validateHalted(what: string, reason: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(`${what} stays on legacy (${VALIDATE_EXCEPTION})`, 'auto', reason);
}

/** Exceptions-list entry of the validate cases that hang on stored data or settings, which the target refuses. */
export const VALIDATE_DATA_EXCEPTION = 'EX-GROUP-VALIDATE-DATA';

/** The legacy 503 of a validate case the target refuses for its stored data or settings, naming its exceptions entry. */
export function validateRefused(what: string, reason: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(`${what} is refused (${VALIDATE_DATA_EXCEPTION})`, 'auto', reason);
}

/** A CFML runtime error processRequest's `catch (Any e)` answers with the unhandled-exception 500. */
function cfmlError(): LegacyApiError {
  return new LegacyApiError('server_error');
}

/** The bean a validation reads: `getValue`, `hasProperty` and `get` as its class defines them. */
export interface ValidatedBean {
  /** `getValue(property)`, '' for none. */
  value(property: string): CfValue;
  hasProperty(property: string): boolean;
}

/** Validation errors in assignment order, keyed by property as legacy spells it. */
export type ValidationErrors = CfStruct;

// --- CFML values ---

const NUMERIC_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE]-?\d+)?$/;
const BOOLEAN_NUMBER_TEXT = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE]-?\d+)?$/;
const BOOLEAN_WORD = /^(?:true|false|yes|no)$/i;
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

function isComplex(value: CfValue | null | undefined): boolean {
  return value !== null && value !== undefined && !isSimple(value);
}

/** CFML `len()` of a simple value. */
function textLength(value: string | CfNumber | boolean): number {
  return simpleText(value).length;
}

/** CFML `isNumeric(value)`. */
function isNumericValue(value: CfValue): boolean {
  if (value instanceof CfNumber) return true;
  return typeof value === 'string' && cfIsNumeric(value);
}

function numberOf(value: string | CfNumber | boolean): number {
  if (value instanceof CfNumber) return value.value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return cfToNumber(value);
}

/** A number CFML comparison reads as one: a decimal not ending in '.', a number or a boolean. */
function comparisonNumber(value: string | CfNumber | boolean): number | undefined {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof CfNumber) return value.value;
  const trimmed = javaTrim(value);
  if (DECIMAL.test(trimmed) && !trimmed.endsWith('.') && Number.isFinite(Number(trimmed))) return Number(trimmed);
  if (BOOLEAN_WORD.test(value)) return /^(?:true|yes)$/i.test(value) ? 1 : 0;
  return undefined;
}

/** The instant a CFML date comparison reads: a number as a day serial from 1899-12-30, else date text. */
function comparisonInstant(value: string | CfNumber | boolean): number | undefined {
  if (typeof value === 'boolean') return undefined;
  const n = value instanceof CfNumber ? value.value : comparisonNumberText(value);
  if (n !== undefined) return new Date(1899, 11, 30).getTime() + n * 86_400_000;
  const text = value as string;
  return cfIsDateText(text) ? cfParseDateTimeText(text).getTime() : undefined;
}

function comparisonNumberText(text: string): number | undefined {
  const trimmed = javaTrim(text);
  return DECIMAL.test(trimmed) && !trimmed.endsWith('.') && Number.isFinite(Number(trimmed)) ? Number(trimmed) : undefined;
}

/** Java `compareToIgnoreCase`. */
function compareNoCase(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charAt(i);
    const y = b.charAt(i);
    if (x === y) continue;
    const ux = x.toUpperCase();
    const uy = y.toUpperCase();
    if (ux === uy) continue;
    const lx = ux.toLowerCase();
    const ly = uy.toLowerCase();
    if (lx !== ly) return lx.charCodeAt(0) - ly.charCodeAt(0);
  }
  return a.length - b.length;
}

/** CFML comparison of a value with a constraint: numeric, then date, else case-insensitive text. */
function cfCompare(value: string | CfNumber | boolean, constraint: string): number {
  const x = comparisonNumber(value);
  const y = comparisonNumber(constraint);
  if (x !== undefined && y !== undefined) return x - y;
  const dx = comparisonInstant(value);
  const dy = comparisonInstant(constraint);
  if (dx !== undefined && dy !== undefined) return dx - dy;
  return compareNoCase(simpleText(value), constraint);
}

// --- Constraint arguments, as the validate_<type> signatures type them ---

/** A `boolean` argument; a value CFML cannot convert raises. */
function booleanArgument(value: CfValue): boolean {
  if (typeof value === 'boolean') return value;
  if (value instanceof CfNumber) return value.value !== 0;
  if (typeof value === 'string') {
    if (BOOLEAN_WORD.test(value)) return /^(?:true|yes)$/i.test(value);
    if (cfIsNumeric(value)) return cfToNumber(value) !== 0;
  }
  throw cfmlError();
}

/** A `numeric` argument; a value CFML cannot convert raises. */
function numericArgument(value: CfValue): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof CfNumber) return value.value;
  if (typeof value === 'string' && cfIsNumeric(value)) return cfToNumber(value);
  throw cfmlError();
}

/** A `string` argument; a complex value raises. */
function stringArgument(value: CfValue): string {
  if (!isSimple(value)) throw cfmlError();
  return simpleText(value);
}

// --- isValid ---

/** isValid types whose ACF patterns are runtime internals; a complex value raises for those in RAISING_TYPES. */
const RUNTIME_PATTERN_TYPES: ReadonlySet<string> = new Set([
  'creditcard', 'email', 'eurodate', 'ssn', 'social_security_number', 'telephone', 'url', 'usdate', 'zipcode',
]);
const RAISING_TYPES: ReadonlySet<string> = new Set([
  'creditcard', 'eurodate', 'ssn', 'social_security_number', 'telephone', 'url', 'zipcode', 'uuid', 'guid', 'date', 'range',
]);

/** The isValid types validate_dataType checks (beanValidator.cfc:288). */
const ISVALID_TYPES: ReadonlySet<string> = new Set([
  'any', 'array', 'binary', 'boolean', 'component', 'creditcard', 'date', 'time', 'email', 'eurodate', 'float', 'numeric', 'guid',
  'integer', 'query', 'range', 'ssn', 'social_security_number', 'string', 'telephone', 'url', 'uuid', 'usdate', 'zipcode',
]);

function isNumberText(text: string): boolean {
  const trimmed = javaTrim(text);
  return NUMERIC_TEXT.test(trimmed) || /^(?:Infinity|NaN)$/.test(trimmed);
}

/** ACF `isValid(type, value)` of one JSON value (oracle-measured, see legacy-api.test.ts). */
function isValidType(type: string, value: CfValue): boolean {
  if (isComplex(value)) {
    if (RAISING_TYPES.has(type)) throw cfmlError();
    if (type === 'array') return Array.isArray(value);
    if (type === 'query') return value === CF_QUERY;
    return false;
  }
  const simple = value as string | CfNumber | boolean;
  const text = simpleText(simple);
  if (RUNTIME_PATTERN_TYPES.has(type)) {
    if (text === '') return false;
    throw validateHalted(`An isValid('${type}') check`, 'validate-isvalid-pattern');
  }
  switch (type) {
    case 'any':
    case 'string':
      return true;
    case 'numeric':
    case 'float':
      return typeof simple !== 'string' || isNumberText(text);
    case 'integer':
      if (typeof simple === 'boolean') return false;
      if (simple instanceof CfNumber) return Number.isInteger(simple.value) && simple.value >= INT_MIN && simple.value <= INT_MAX;
      return /^-?\d+$/.test(text) && Number(text) >= INT_MIN && Number(text) <= INT_MAX;
    case 'boolean':
      return typeof simple !== 'string' || BOOLEAN_WORD.test(text) || BOOLEAN_NUMBER_TEXT.test(text);
    case 'date':
      // A number is a day serial, which an infinite or NaN value is not.
      if (typeof simple === 'boolean') return false;
      return simple instanceof CfNumber || (isNumberText(text) && Number.isFinite(Number(javaTrim(text)))) || cfIsDateText(text);
    case 'time':
      return typeof simple === 'string' && cfIsDateText(text);
    case 'uuid':
      return /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{16}$/.test(text);
    case 'guid':
      return /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(text);
    case 'range':
      // "The validation type range requires a min and a max argument."
      throw cfmlError();
    default:
      // array, binary, component and query hold no simple value.
      return false;
  }
}

/** validate_dataType's database-type translation (beanValidator.cfc:276-285). */
function translatedType(type: string): string {
  const lower = type.toLowerCase();
  if (lower === 'datetime') return 'date';
  if (['varchar', 'char', 'text', 'longtext', 'mediumtext', 'clob', 'nvarchar'].includes(lower)) return 'string';
  if (['tinyint', 'int', 'smallint'].includes(lower)) return 'integer';
  if (lower === 'double') return 'float';
  return lower;
}

// --- The validation run ---

/** One constraint of a property rule (beanValidator.cfc:97-114). */
interface ConstraintDetails {
  type: string;
  /** undefined for a JSON null, which leaves `constraintValue` undefined. */
  value: CfValue | undefined;
  conditions?: CfValue;
  rbkey?: string;
  message?: string;
}

/** The request a validation reads values from: `request.muraValidationContext[validationContextID]`, the posted data. */
export interface ValidationContext {
  data: CfStruct;
  /** fileManager `isPostedFile(name)`, under which validate_regex reads the client file name instead (fileManager.cfc:651-654). */
  isPostedFile: (name: string) => boolean;
}

/** A property's constraints in the order validate() runs them. */
interface PropertyRules {
  property: string;
  constraints: ConstraintDetails[];
}

class BeanValidation {
  constructor(
    readonly bean: ValidatedBean,
    /** `getValidations().conditions`, which getConditionsMeetFlag reads. */
    readonly conditions: CfValue | null | undefined,
    readonly context: ValidationContext,
  ) {}

  /** getValueForValidation (beanValidator.cfc:416-436): the posted value, else the bean's own for one of its properties. */
  #valueFor(property: string): CfValue {
    const posted = this.context.data.get(property);
    if (posted !== null && posted !== undefined) return posted;
    return this.bean.hasProperty(property) ? this.bean.value(property) : '';
  }

  /** validate_<type>; undefined when beanValidator defines none (beanValidator.cfc:256-460). */
  #check(type: string, property: string, constraint: CfValue): boolean | undefined {
    switch (type.toLowerCase()) {
      case 'required': {
        if (!booleanArgument(constraint)) return true;
        const v = this.#valueFor(property);
        if (Array.isArray(v)) return v.length > 0;
        if (v instanceof CfStruct) return v.size > 0;
        return isSimple(v) && textLength(v) > 0;
      }
      case 'datatype':
      case 'format': {
        if (!isSimple(constraint)) throw cfmlError();
        const raw = simpleText(constraint);
        const posted = this.context.data.get(property);
        // A posted value under dataType `date` is parseDateArg(String arg)'s date or '', which passes; a complex one raises.
        if (raw.toLowerCase() === 'date' && posted !== null && posted !== undefined) {
          if (!isSimple(posted)) throw cfmlError();
          return true;
        }
        const v = this.#valueFor(property);
        const type2 = translatedType(raw);
        if (ISVALID_TYPES.has(type2)) {
          if (isValidType(type2, v)) return true;
          return type2 === 'date' && isSimple(v) && simpleText(v) === '';
        }
        if (type2 === 'json') {
          if (!isSimple(v)) return false;
          const parsed = deserializeCfJson(simpleText(v));
          return Array.isArray(parsed) || parsed instanceof CfStruct;
        }
        return true;
      }
      case 'minvalue':
      case 'maxvalue': {
        const limit = numericArgument(constraint);
        const v = this.#valueFor(property);
        if (!isSimple(v) || !isNumericValue(v)) return false;
        return type.toLowerCase() === 'minvalue' ? numberOf(v) >= limit : numberOf(v) <= limit;
      }
      case 'minlength':
      case 'maxlength': {
        const limit = numericArgument(constraint);
        const v = this.#valueFor(property);
        if (!isSimple(v)) return false;
        return type.toLowerCase() === 'minlength' ? textLength(v) >= limit : textLength(v) <= limit;
      }
      case 'mincollection':
      case 'maxcollection': {
        const limit = numericArgument(constraint);
        const v = this.#valueFor(property);
        const count = Array.isArray(v) ? v.length : v instanceof CfStruct ? v.size : undefined;
        if (count === undefined) return false;
        return type.toLowerCase() === 'mincollection' ? count >= limit : count <= limit;
      }
      case 'minlist':
      case 'maxlist': {
        const limit = numericArgument(constraint);
        const v = this.#valueFor(property);
        if (!isSimple(v)) return false;
        const count = cfListToArray(simpleText(v)).length;
        return type.toLowerCase() === 'minlist' ? count >= limit : count <= limit;
      }
      case 'method':
        stringArgument(constraint);
        // validate_method returns nothing: "The value returned from the validate_method function is not of type boolean."
        throw cfmlError();
      case 'lte':
      case 'lt':
      case 'gte':
      case 'gt':
      case 'eq':
      case 'neq': {
        const limit = stringArgument(constraint);
        const v = this.#valueFor(property);
        if (!isSimple(v)) throw cfmlError();
        // A constraint of the text `null` reaches the function as null, which fails every comparison.
        if (limit.toLowerCase() === 'null') return false;
        const order = cfCompare(v, limit);
        const op = type.toLowerCase();
        return op === 'lte' ? order <= 0 : op === 'lt' ? order < 0 : op === 'gte' ? order >= 0 : op === 'gt' ? order > 0 : op === 'eq' ? order === 0 : order !== 0;
      }
      case 'inlist': {
        const list = stringArgument(constraint);
        const v = this.#valueFor(property);
        if (!isSimple(v)) throw cfmlError();
        const wanted = simpleText(v).toLowerCase();
        return cfListToArray(list).some((item) => item.toLowerCase() === wanted);
      }
      case 'regex': {
        const pattern = stringArgument(constraint);
        // A posted file's client name is simple; isValid('regex') raises for a complex value or an empty pattern.
        if (!this.context.isPostedFile(property) && !isSimple(this.#valueFor(property))) throw cfmlError();
        if (pattern === '') throw cfmlError();
        throw validateHalted(`An isValid('regex') check`, 'validate-regex');
      }
      default:
        return undefined;
    }
  }

  /** getConditionsMeetFlag (beanValidator.cfc:122-153). */
  #conditionsMet(conditions: CfValue): boolean {
    const names = cfListToArray(stringArgument(conditions));
    const defined = this.conditions;
    for (const name of names) {
      const condition = defined instanceof CfStruct ? defined.get(name) : undefined;
      if (!(condition instanceof CfStruct)) continue;
      let all = true;
      for (const property of condition.keys()) {
        for (const [type, value] of constraintEntries(condition.get(property))) {
          if (value === undefined) {
            if (this.#check(type, property, '') !== undefined) throw cfmlError();
            continue;
          }
          if (this.#check(type, property, value) === false) all = false;
        }
      }
      if (all) return true;
    }
    return false;
  }

  /** beanValidator.validate(object, '') over getValidationsByContext's rules (beanValidator.cfc:180-231). */
  run(rules: Iterable<PropertyRules>): ValidationErrors {
    const errors = new CfStruct();
    for (const { property, constraints } of rules) {
      const required = constraints.some((c) => c.type.toLowerCase() === 'required');
      for (const c of constraints) {
        let met = c.conditions === undefined ? true : this.#conditionsMet(c.conditions);
        const own = this.bean.value(property);
        if (c.type.toLowerCase() !== 'required' && isSimple(own) && textLength(own) === 0 && !required) met = false;
        if (!met) continue;
        if (c.value === undefined) {
          if (this.#check(c.type, property, '') !== undefined) throw cfmlError();
          continue;
        }
        if (this.#check(c.type, property, c.value) !== false) continue;
        if (c.rbkey !== undefined) throw validateHalted(`The resource-bundle label ${c.rbkey} of a failed rule`, 'validate-rbkey');
        errors.set(property, c.message ?? `The property named '${property}' is not valid`);
      }
    }
    return errors;
  }
}

/** The text of a rule's `rbkey` or `message`, which `len()` reads; complex values raise, nulls read as unset. */
function textIfSet(value: CfValue | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isSimple(value)) throw cfmlError();
  return simpleText(value);
}

/** getValidationsByContext(object, ''): each property's constraints, properties in the contextValidations struct's order (beanValidator.cfc:80-118). */
function rulesByContext(validations: CfStruct): PropertyRules[] {
  const properties = validations.get('properties');
  if (!(properties instanceof CfStruct)) throw cfmlError();
  const byProperty = new CfStruct();
  const out = new Map<string, PropertyRules>();
  for (const property of properties.keys()) {
    const rules = properties.get(property);
    if (!Array.isArray(rules)) throw cfmlError();
    for (const rule of rules) {
      if (!(rule instanceof CfStruct)) throw cfmlError();
      // listFindNoCase(rule.contexts, '') finds nothing, so any rule naming contexts is skipped.
      const contexts = rule.get('contexts');
      if (contexts !== null && contexts !== undefined) {
        if (!isSimple(contexts)) throw cfmlError();
        continue;
      }
      if (!byProperty.has(property)) {
        byProperty.set(property, true);
        out.set(property.toUpperCase(), { property, constraints: [] });
      }
      const entry = out.get(property.toUpperCase()) as PropertyRules;
      for (const type of rule.keys()) {
        if (type.toLowerCase() === 'contexts' || type.toLowerCase() === 'conditions') continue;
        const details: ConstraintDetails = { type, value: rule.get(type) ?? undefined };
        if (rule.has('conditions')) details.conditions = rule.get('conditions') as CfValue;
        const rbkey = textIfSet(rule.get('rbkey'));
        if (rbkey !== undefined && rbkey !== '') details.rbkey = rbkey;
        else {
          const message = textIfSet(rule.get('message'));
          if (message !== undefined && message !== '') details.message = message;
        }
        entry.constraints.push(details);
      }
    }
  }
  return byProperty.keys().map((key) => out.get(key.toUpperCase()) as PropertyRules);
}

/** `for (c in x)` over a condition's constraints and `x[c]` of each: a struct's entries; array and text items must index it. */
function constraintEntries(constraints: CfValue | null | undefined): Array<[string, CfValue | undefined]> {
  if (constraints instanceof CfStruct) return constraints.keys().map((key) => [key, constraints.get(key) ?? undefined]);
  if (constraints === null || constraints === undefined || typeof constraints === 'boolean' || constraints instanceof CfNumber || constraints === CF_QUERY) {
    throw cfmlError();
  }
  const items = Array.isArray(constraints) ? constraints.map((item) => (isSimple(item) ? simpleText(item) : null)) : cfListToArray(constraints);
  for (const item of items) {
    // A complex element, or one that is no number, cannot index the array or text.
    if (item === null || !cfIsNumeric(item)) throw cfmlError();
  }
  // A numeric item names no validate_<type> function, so it constrains nothing.
  return [];
}

/** ACF `isValid('variableName', name)`: dot-separated identifiers. */
function isVariableName(name: string): boolean {
  return name.split('.').every((part) => isValidVariableName(part));
}

/** Public methods `get<name>` of mura.bean.bean and mura.cfobject, by lower-cased name (bean.cfc; cfobject.cfc). */
const GENERIC_BEAN_GETTERS: ReadonlySet<string> = new Set([
  'dbutility', 'instancename', 'value', 'allvalues', 'all', 'errors', 'ishistorical', 'scaffold', 'bundleable', 'dynamic', 'primarykey',
  'table', 'orderby', 'publicapi', 'hasmanyproparray', 'hasoneproparray', 'properties', 'entityname', 'entitydisplayname', 'validations',
  'synthedfunctions', 'feed', 'registeredentity', 'permissions', 'listviewprops', 'searchableprops', 'configbean', 'servicefactory',
  'bean', 'entity', 'pluginmanager', 'eventmanager', 'currentuser', 'plugin', 'asjson', 'asstruct', 'queryattrs', 'queryservice',
  'httpservice', 'httpattrs', 'javatimezone', 'session',
]);

/** A name lockdownValidations keeps for the generic bean: a variable name with no `get<name>` method. */
function keepsName(name: string): boolean {
  return isVariableName(name) && !GENERIC_BEAN_GETTERS.has(name.toLowerCase());
}

/** `for (key in x)` over a condition and `x[key]` of each kept key: a struct's entries, else items no key can index. */
function conditionEntries(condition: CfValue | null | undefined): Array<[string, CfValue | null]> {
  if (condition instanceof CfStruct) return condition.keys().map((key) => [key, condition.get(key) ?? null]);
  if (condition === null || condition === undefined || condition === CF_QUERY) throw cfmlError();
  const items: Array<string | null> = Array.isArray(condition)
    ? condition.map((item) => (isSimple(item) ? simpleText(item) : null))
    : cfListToArray(simpleText(condition));
  for (const item of items) {
    if (item === null) throw cfmlError();
    // A kept name indexes the array or simple value, which raises.
    if (keepsName(item)) throw cfmlError();
  }
  return [];
}

/** lockdownValidations(bean, validations) for the generic `bean` entity (jsonApiUtility.cfc:3657-3700). */
function lockdownValidations(validations: CfStruct): CfStruct {
  const sanitized = new CfStruct();
  const properties = validations.get('properties');
  if (properties instanceof CfStruct) {
    for (const key of properties.keys()) {
      if (!keepsName(key)) continue;
      let kept = sanitized.get('properties');
      if (!(kept instanceof CfStruct)) {
        kept = new CfStruct();
        sanitized.set('properties', kept);
      }
      kept.set(key, properties.get(key) ?? null);
    }
  }
  const conditions = validations.get('conditions');
  if (conditions instanceof CfStruct) {
    const kept = new CfStruct();
    sanitized.set('conditions', kept);
    for (const name of conditions.keys()) {
      for (const [key, value] of conditionEntries(conditions.get(name))) {
        if (!keepsName(key)) continue;
        let inner = kept.get(name);
        if (!(inner instanceof CfStruct)) {
          inner = new CfStruct();
          kept.set(name, inner);
        }
        inner.set(key, value);
      }
    }
  }
  return sanitized;
}

/** `new mura.bean.bean()` with a validationContextID: its instance values and bean.cfc properties (bean.cfc:79-105). */
function genericBean(instanceId: string, validationContextId: string): ValidatedBean {
  const instance = new CfStruct();
  instance.set('isNew', new CfNumber('1', 1));
  instance.set('errors', new CfStruct());
  instance.set('fromMuraCache', false);
  instance.set('instanceID', instanceId);
  instance.set('addObjects', []);
  instance.set('removeObjects', []);
  instance.set('validationContextID', validationContextId);
  const properties = new Set(['errors', 'isnew', 'frommuracache', 'instanceid']);
  return {
    value: (property) => instance.get(property) ?? '',
    hasProperty: (property) => properties.has(property.toLowerCase()),
  };
}

/**
 * The ad hoc validation of `validate`: `bean.validate(fields)` of a generic bean under lockdownValidations, or the `bean` entity's
 * own empty rules when nothing is kept; `fields` is `data.fields` (jsonApiUtility.cfc:3770-3780; bean.cfc:487-505,1166-1172).
 */
export function validateAdHoc(
  validations: CfStruct,
  context: ValidationContext,
  fields: CfValue,
  ids: { instanceId: string; validationContextId: string },
): ValidationErrors {
  const sanitized = lockdownValidations(validations);
  // An empty set leaves getValidations() to generate the generic bean's, whose properties are all non-persistent.
  const rules = sanitized.size === 0 ? [] : rulesByContext(sanitized);
  const errors = new BeanValidation(genericBean(ids.instanceId, ids.validationContextId), sanitized.get('conditions'), context).run(rules);
  // `len(arguments.fields)` of a complex value raises.
  const list = stringArgument(fields);
  if (list === '') return errors;
  const kept = new CfStruct();
  for (const field of cfListToArray(list)) {
    const message = errors.get(field);
    if (message !== null && message !== undefined) kept.set(field, message);
  }
  return kept;
}

/** userBean's generated rules: each persistent cfproperty's dataType, in the rule struct's iteration order (bean.cfc:1166-1254; userBean.cfc:78-120). */
const USER_BEAN_RULES: readonly PropertyRules[] = (
  [
    ['mobilePhone', 'varchar'], ['lname', 'varchar'], ['contactFormat', 'varchar'], ['email', 'varchar'], ['notes', 'varchar'],
    ['lastUpdate', 'datetime'], ['created', 'datetime'], ['extendDataTable', 'varchar'], ['description', 'varchar'], ['groupname', 'varchar'],
    ['perm', 'numeric'], ['keepPrivate', 'numeric'], ['addressID', 'varchar'], ['userID', 'varchar'], ['username', 'varchar'],
    ['IMName', 'varchar'], ['type', 'numeric'], ['lastUpdateByID', 'varchar'], ['subType', 'varchar'], ['passwordCreated', 'datetime'],
    ['photoFileID', 'varchar'], ['interests', 'varchar'], ['categoryID', 'varchar'], ['siteID', 'varchar'], ['primaryAddressID', 'varchar'],
    ['subscribe', 'numeric'], ['fname', 'varchar'], ['company', 'varchar'], ['tablist', 'varchar'], ['remoteID', 'varchar'],
    ['newFile', 'varchar'], ['password', 'varchar'], ['inActive', 'numeric'], ['photoFileExt', 'varchar'], ['isPublic', 'numeric'],
    ['addresses', 'query'], ['lastUpdateBy', 'varchar'], ['IMService', 'varchar'], ['lastLogin', 'datetime'], ['website', 'varchar'],
    ['jobTitle', 'varchar'], ['s2', 'numeric'],
  ] as const
).map(([property, dataType]) => ({ property, constraints: [{ type: 'datatype', value: dataType }] }));

/** The userBean `validate()` checks after the generated rules, with the site's resource-bundle texts. */
export interface UserBeanChecks {
  /** `trim(siteid)` of the bean after `set('siteid', …)`. */
  siteId: string;
  /** A new type 2 bean, whose empty username and email fail with these texts (userBean.cfc:468-484). */
  newUser?: { usernameMessage: string; emailMessage: string };
}

/** userBean `validate()` of a group or a new bean without extended attributes (userBean.cfc:446-500). */
export function validateUserBean(bean: ValidatedBean, context: ValidationContext, checks: UserBeanChecks): ValidationErrors {
  const errors = new BeanValidation(bean, undefined, context).run(USER_BEAN_RULES);
  if (checks.siteId === '') {
    errors.set('siteid', "The 'SiteID' variable is missing.");
  } else if (checks.newUser !== undefined) {
    errors.set('username', checks.newUser.usernameMessage);
    errors.set('email', checks.newUser.emailMessage);
  }
  return errors;
}

/** `structAppend(errors, more)`: `more`'s keys in its iteration order, replacing equal keys' values in place. */
export function appendErrors(errors: ValidationErrors, more: ValidationErrors): void {
  for (const key of more.keys()) errors.set(key, more.get(key) ?? null);
}

/** The errors as a plain object in ACF iteration order, for the serializer. */
export function errorsObject(errors: ValidationErrors): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of errors.keys()) {
    const value = errors.get(key);
    const entry = value === null || value === undefined ? null : isSimple(value) ? simpleText(value) : value;
    // Defined, not assigned, so a `__proto__` key stays a data key.
    Object.defineProperty(out, key, { value: entry, writable: true, enumerable: true, configurable: true });
  }
  return out;
}

/** A CFML array value, re-exported for callers building validation values. */
export type { CfArray };
