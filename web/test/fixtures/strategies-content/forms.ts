import type { components } from '@/generated/clients/strategies-content';
import type { GatewayResponse } from '@/lib/gateway-client';
import { CONTENT_IDS } from './carch';

type RawLegacyJson = components['schemas']['RawLegacyJson'];

export const FORM_FIELD_IDS = Object.freeze({
  fname: '5C000000-000D-4000-8000000000000001',
  lname: '5C000000-000D-4000-8000000000000002',
  email: '5C000000-000D-4000-8000000000000003',
  topic: '5C000000-000D-4000-8000000000000004',
  message: '5C000000-000D-4000-8000000000000005',
} as const);

export const FORM_DATASET_IDS = Object.freeze({
  topicOptions: '5C000000-000E-4000-8000000000000001',
  optGeneral: '5C000000-000E-4000-8000000000000002',
  optSupport: '5C000000-000E-4000-8000000000000003',
  optPress: '5C000000-000E-4000-8000000000000004',
} as const);

const FIELD_TYPE_IDS = Object.freeze({
  fname: '5C000000-000D-4000-8000000000000011',
  lname: '5C000000-000D-4000-8000000000000012',
  email: '5C000000-000D-4000-8000000000000013',
  topic: '5C000000-000D-4000-8000000000000014',
  message: '5C000000-000D-4000-8000000000000015',
} as const);

const MODEL_RECORD_ID = '5C000000-000E-4000-8000000000000005';
const FORM_ID = CONTENT_IDS.contactForm;
const SITE_ID = 'tenant-a';
const CREATED = 'June, 29 2026 14:20:00';
const UPDATED = 'June, 30 2026 09:15:00';

// The wire form of json.cfm's `application/json; charset=utf-8`, as ACF sends it and the contract declares it.
const LEGACY_JSON_CONTENT_TYPE = 'application/json;charset=utf-8';

// New-bean values in serializeJSON's key order; a spread override keeps each key's position.
const FIELD_TYPE_DEFAULTS = {
  fieldtypeid: '',
  islong: 0,
  datecreate: '',
  fieldtype: 'textfield',
  IsMultiSelect: 0,
  moduleid: '',
  datelastupdate: '',
  rblabel: '',
  displaytype: 'field',
  bean: '',
  isdata: 0,
  label: '',
} as const;

const FIELD_DEFAULTS = {
  fieldid: '',
  sectionid: '00000000-0000-0000-0000000000000000',
  validatemessage: '',
  fieldtype: FIELD_TYPE_DEFAULTS,
  relatedid: '',
  rblabel: '',
  value: '',
  config: {},
  isrequired: 0,
  label: '',
  type: 'COMMON',
  fieldtypeid: '',
  datecreate: '',
  cssstyle: '',
  datelastupdate: '',
  validateregex: '',
  isactive: 1,
  formid: FORM_ID,
  name: '',
  placeholder: '',
  islocked: 0,
  validatetype: '',
  datasetid: '',
  remoteid: '',
  tooltip: '',
  isdeleted: 0,
  orderno: 0,
  isentrytype: 'SINGLE',
  params: '',
} as const;

const RECORD_DEFAULTS = {
  datasetid: FORM_DATASET_IDS.topicOptions,
  datecreate: '',
  remoteid: '',
  orderno: 0,
  datelastupdate: '',
  isselected: 0,
  label: '',
  datarecordid: '',
  value: '',
} as const;

const FIELD_ORDER = [
  FORM_FIELD_IDS.fname,
  FORM_FIELD_IDS.lname,
  FORM_FIELD_IDS.email,
  FORM_FIELD_IDS.topic,
  FORM_FIELD_IDS.message,
] as const;

export const formBuilderJson = {
  datecreate: CREATED,
  fields: {
    [FORM_FIELD_IDS.fname]: {
      ...FIELD_DEFAULTS,
      fieldid: FORM_FIELD_IDS.fname,
      fieldtype: { ...FIELD_TYPE_DEFAULTS, fieldtypeid: FIELD_TYPE_IDS.fname },
      isrequired: 1,
      label: 'First Name',
      name: 'fname',
      orderno: 1,
    },
    [FORM_FIELD_IDS.lname]: {
      ...FIELD_DEFAULTS,
      fieldid: FORM_FIELD_IDS.lname,
      fieldtype: { ...FIELD_TYPE_DEFAULTS, fieldtypeid: FIELD_TYPE_IDS.lname },
      isrequired: 1,
      label: 'Last Name',
      name: 'lname',
      orderno: 2,
    },
    [FORM_FIELD_IDS.email]: {
      ...FIELD_DEFAULTS,
      fieldid: FORM_FIELD_IDS.email,
      validatemessage: 'Please enter a valid email address.',
      fieldtype: { ...FIELD_TYPE_DEFAULTS, fieldtypeid: FIELD_TYPE_IDS.email },
      isrequired: 1,
      label: 'Email Address',
      name: 'email',
      placeholder: 'name@example.com',
      validatetype: 'email',
      orderno: 3,
    },
    [FORM_FIELD_IDS.topic]: {
      ...FIELD_DEFAULTS,
      fieldid: FORM_FIELD_IDS.topic,
      fieldtype: { ...FIELD_TYPE_DEFAULTS, fieldtypeid: FIELD_TYPE_IDS.topic, fieldtype: 'dropdown', isdata: 1 },
      label: 'Topic',
      name: 'topic',
      datasetid: FORM_DATASET_IDS.topicOptions,
      orderno: 4,
    },
    [FORM_FIELD_IDS.message]: {
      ...FIELD_DEFAULTS,
      fieldid: FORM_FIELD_IDS.message,
      fieldtype: { ...FIELD_TYPE_DEFAULTS, fieldtypeid: FIELD_TYPE_IDS.message, islong: 1, fieldtype: 'textarea' },
      isrequired: 1,
      label: 'Message',
      name: 'message',
      orderno: 5,
    },
  },
  pages: [FIELD_ORDER],
  statuscode: 0,
  datelastupdate: UPDATED,
  formattributes: { class: 'mura-form-contact' },
  siteid: SITE_ID,
  formid: FORM_ID,
  isactive: 1,
  name: 'Contact Us Form',
  config: {},
  notes: '',
  remoteid: '',
  iscurrent: 1,
  package: '',
  deletedfields: {},
  fieldorder: FIELD_ORDER,
} as const satisfies RawLegacyJson;

export const fieldOptionsJson = {
  datarecords: {
    [FORM_DATASET_IDS.optGeneral]: {
      ...RECORD_DEFAULTS,
      orderno: 1,
      isselected: 1,
      label: 'General',
      datarecordid: FORM_DATASET_IDS.optGeneral,
      value: 'general',
    },
    [FORM_DATASET_IDS.optSupport]: {
      ...RECORD_DEFAULTS,
      orderno: 2,
      label: 'Support',
      datarecordid: FORM_DATASET_IDS.optSupport,
      value: 'support',
    },
    [FORM_DATASET_IDS.optPress]: {
      ...RECORD_DEFAULTS,
      orderno: 3,
      label: 'Press',
      datarecordid: FORM_DATASET_IDS.optPress,
      value: 'press',
    },
  },
  deletedrecords: {},
  datecreate: CREATED,
  issortchanged: 0,
  datelastupdate: UPDATED,
  model: { ...RECORD_DEFAULTS, datarecordid: MODEL_RECORD_ID },
  sourcetype: 'entered',
  siteid: SITE_ID,
  isactive: 1,
  name: 'Topic Options',
  islocked: 0,
  datasetid: FORM_DATASET_IDS.topicOptions,
  remoteid: '',
  parentid: '',
  source: '',
  sorttype: '',
  issorted: 0,
  isglobal: 0,
  sortdirection: 'asc',
  sortcolumn: 'orderby',
  datarecordorder: [FORM_DATASET_IDS.optGeneral, FORM_DATASET_IDS.optSupport, FORM_DATASET_IDS.optPress],
} as const satisfies RawLegacyJson;

export const getFormRelay = {
  status: 200,
  ok: true,
  headers: { 'content-type': LEGACY_JSON_CONTENT_TYPE },
  body:
    `{"datecreate":"June, 29 2026 14:20:00",` +
    `"fields":{"${FORM_FIELD_IDS.fname}":{"fieldid":"${FORM_FIELD_IDS.fname}",` +
    `"sectionid":"00000000-0000-0000-0000000000000000","validatemessage":"",` +
    `"fieldtype":{"fieldtypeid":"${FIELD_TYPE_IDS.fname}","islong":0,"datecreate":"","fieldtype":"textfield",` +
    `"IsMultiSelect":0,"moduleid":"","datelastupdate":"","rblabel":"","displaytype":"field","bean":"","isdata":0,` +
    `"label":""},"relatedid":"","rblabel":"","value":"","config":{},"isrequired":1,"label":"First Name",` +
    `"type":"COMMON","fieldtypeid":"","datecreate":"","cssstyle":"","datelastupdate":"","validateregex":"",` +
    `"isactive":1,"formid":"${FORM_ID}","name":"fname","placeholder":"","islocked":0,"validatetype":"",` +
    `"datasetid":"","remoteid":"","tooltip":"","isdeleted":0,"orderno":1,"isentrytype":"SINGLE","params":""},` +
    `"${FORM_FIELD_IDS.lname}":{"fieldid":"${FORM_FIELD_IDS.lname}",` +
    `"sectionid":"00000000-0000-0000-0000000000000000","validatemessage":"",` +
    `"fieldtype":{"fieldtypeid":"${FIELD_TYPE_IDS.lname}","islong":0,"datecreate":"","fieldtype":"textfield",` +
    `"IsMultiSelect":0,"moduleid":"","datelastupdate":"","rblabel":"","displaytype":"field","bean":"","isdata":0,` +
    `"label":""},"relatedid":"","rblabel":"","value":"","config":{},"isrequired":1,"label":"Last Name",` +
    `"type":"COMMON","fieldtypeid":"","datecreate":"","cssstyle":"","datelastupdate":"","validateregex":"",` +
    `"isactive":1,"formid":"${FORM_ID}","name":"lname","placeholder":"","islocked":0,"validatetype":"",` +
    `"datasetid":"","remoteid":"","tooltip":"","isdeleted":0,"orderno":2,"isentrytype":"SINGLE","params":""},` +
    `"${FORM_FIELD_IDS.email}":{"fieldid":"${FORM_FIELD_IDS.email}",` +
    `"sectionid":"00000000-0000-0000-0000000000000000","validatemessage":"Please enter a valid email address.",` +
    `"fieldtype":{"fieldtypeid":"${FIELD_TYPE_IDS.email}","islong":0,"datecreate":"","fieldtype":"textfield",` +
    `"IsMultiSelect":0,"moduleid":"","datelastupdate":"","rblabel":"","displaytype":"field","bean":"","isdata":0,` +
    `"label":""},"relatedid":"","rblabel":"","value":"","config":{},"isrequired":1,"label":"Email Address",` +
    `"type":"COMMON","fieldtypeid":"","datecreate":"","cssstyle":"","datelastupdate":"","validateregex":"",` +
    `"isactive":1,"formid":"${FORM_ID}","name":"email","placeholder":"name@example.com","islocked":0,` +
    `"validatetype":"email","datasetid":"","remoteid":"","tooltip":"","isdeleted":0,"orderno":3,` +
    `"isentrytype":"SINGLE","params":""},"${FORM_FIELD_IDS.topic}":{"fieldid":"${FORM_FIELD_IDS.topic}",` +
    `"sectionid":"00000000-0000-0000-0000000000000000","validatemessage":"",` +
    `"fieldtype":{"fieldtypeid":"${FIELD_TYPE_IDS.topic}","islong":0,"datecreate":"","fieldtype":"dropdown",` +
    `"IsMultiSelect":0,"moduleid":"","datelastupdate":"","rblabel":"","displaytype":"field","bean":"","isdata":1,` +
    `"label":""},"relatedid":"","rblabel":"","value":"","config":{},"isrequired":0,"label":"Topic","type":"COMMON",` +
    `"fieldtypeid":"","datecreate":"","cssstyle":"","datelastupdate":"","validateregex":"","isactive":1,` +
    `"formid":"${FORM_ID}","name":"topic","placeholder":"","islocked":0,"validatetype":"",` +
    `"datasetid":"${FORM_DATASET_IDS.topicOptions}","remoteid":"","tooltip":"","isdeleted":0,"orderno":4,` +
    `"isentrytype":"SINGLE","params":""},"${FORM_FIELD_IDS.message}":{"fieldid":"${FORM_FIELD_IDS.message}",` +
    `"sectionid":"00000000-0000-0000-0000000000000000","validatemessage":"",` +
    `"fieldtype":{"fieldtypeid":"${FIELD_TYPE_IDS.message}","islong":1,"datecreate":"","fieldtype":"textarea",` +
    `"IsMultiSelect":0,"moduleid":"","datelastupdate":"","rblabel":"","displaytype":"field","bean":"","isdata":0,` +
    `"label":""},"relatedid":"","rblabel":"","value":"","config":{},"isrequired":1,"label":"Message",` +
    `"type":"COMMON","fieldtypeid":"","datecreate":"","cssstyle":"","datelastupdate":"","validateregex":"",` +
    `"isactive":1,"formid":"${FORM_ID}","name":"message","placeholder":"","islocked":0,"validatetype":"",` +
    `"datasetid":"","remoteid":"","tooltip":"","isdeleted":0,"orderno":5,"isentrytype":"SINGLE","params":""}},` +
    `"pages":[["${FORM_FIELD_IDS.fname}","${FORM_FIELD_IDS.lname}","${FORM_FIELD_IDS.email}",` +
    `"${FORM_FIELD_IDS.topic}","${FORM_FIELD_IDS.message}"]],"statuscode":0,` +
    `"datelastupdate":"June, 30 2026 09:15:00","formattributes":{"class":"mura-form-contact"},"siteid":"tenant-a",` +
    `"formid":"${FORM_ID}","isactive":1,"name":"Contact Us Form","config":{},"notes":"","remoteid":"",` +
    `"iscurrent":1,"package":"","deletedfields":{},"fieldorder":["${FORM_FIELD_IDS.fname}",` +
    `"${FORM_FIELD_IDS.lname}","${FORM_FIELD_IDS.email}","${FORM_FIELD_IDS.topic}","${FORM_FIELD_IDS.message}"]}`,
  setCookies: [],
} as const satisfies GatewayResponse<string>;

export const getDatasetRelay = {
  status: 200,
  ok: true,
  headers: { 'content-type': LEGACY_JSON_CONTENT_TYPE },
  body:
    `{"datarecords":{"${FORM_DATASET_IDS.optGeneral}":{"datasetid":"${FORM_DATASET_IDS.topicOptions}",` +
    `"datecreate":"","remoteid":"","orderno":1,"datelastupdate":"","isselected":1,"label":"General",` +
    `"datarecordid":"${FORM_DATASET_IDS.optGeneral}","value":"general"},` +
    `"${FORM_DATASET_IDS.optSupport}":{"datasetid":"${FORM_DATASET_IDS.topicOptions}","datecreate":"",` +
    `"remoteid":"","orderno":2,"datelastupdate":"","isselected":0,"label":"Support",` +
    `"datarecordid":"${FORM_DATASET_IDS.optSupport}","value":"support"},` +
    `"${FORM_DATASET_IDS.optPress}":{"datasetid":"${FORM_DATASET_IDS.topicOptions}","datecreate":"","remoteid":"",` +
    `"orderno":3,"datelastupdate":"","isselected":0,"label":"Press","datarecordid":"${FORM_DATASET_IDS.optPress}",` +
    `"value":"press"}},"deletedrecords":{},"datecreate":"June, 29 2026 14:20:00","issortchanged":0,` +
    `"datelastupdate":"June, 30 2026 09:15:00","model":{"datasetid":"${FORM_DATASET_IDS.topicOptions}",` +
    `"datecreate":"","remoteid":"","orderno":0,"datelastupdate":"","isselected":0,"label":"",` +
    `"datarecordid":"${MODEL_RECORD_ID}","value":""},"sourcetype":"entered","siteid":"tenant-a","isactive":1,` +
    `"name":"Topic Options","islocked":0,"datasetid":"${FORM_DATASET_IDS.topicOptions}","remoteid":"",` +
    `"parentid":"","source":"","sorttype":"","issorted":0,"isglobal":0,"sortdirection":"asc",` +
    `"sortcolumn":"orderby","datarecordorder":["${FORM_DATASET_IDS.optGeneral}","${FORM_DATASET_IDS.optSupport}",` +
    `"${FORM_DATASET_IDS.optPress}"]}`,
  setCookies: [],
} as const satisfies GatewayResponse<string>;
