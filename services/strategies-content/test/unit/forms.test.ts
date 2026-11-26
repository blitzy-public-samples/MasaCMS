/** Form responses, the data manager and the cform dialog inputs over a throwaway `content` schema and local storage. */
import type { PassThrough } from 'node:stream';
import { text } from 'node:stream/consumers';
import { setTimeout } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LEGACY_JSON_CONTENT_TYPE, cfTimestampText, isCfUuid } from '@opt2/platform/legacy-compat';
import { TENANT_UMBRELLA, pgAvailable } from '@opt2/platform/testing';
import type { ContentDeps } from '../../src/domain/content.js';
import { UndefinedLegacyMethodError } from '../../src/domain/context.js';
import { ImageUploadHaltedError, type UploadedFile } from '../../src/domain/files.js';
import {
  FORM_FIELD_IGNORE_LIST,
  cformDatasetBean,
  cformFieldBean,
  cformFieldTypeBean,
  cformFormBean,
  dataManagerAction,
  dataManagerView,
  deleteResponse,
  downloadData,
  formResponsesArgs,
  getActiveForm,
  getCurrentFieldList,
  getData,
  getForms,
  getFullFieldList,
  readResponse,
  responseValues,
  submitForm,
  updateResponse,
} from '../../src/domain/forms.js';
import { formBeanJson, renderCformResponse } from '../../src/legacy/admin-render-forms.js';
import { wddx2cfml, wddxStructGet, type WddxStruct } from '../../src/domain/wddx.js';
import { DEFAULT_ROW_BATCH_SIZE, type VersionInput } from '../../src/repo/repository.js';
import { ADMIN, NOW, SITE_ID, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';
import { uploadedFile } from '../helpers/uploads.js';

const FORM = cfId('F', 1);
const OTHER_FORM = cfId('F', 2);
const RID = 'C33981F1-CE76-D22E-93A50AB350491D41';
const FORM_CREATE =
  "<wddxPacket version='1.0'><header/><data>" +
  "<struct><var name='responseid'><string>C33981F1-CE76-D22E-93A50AB350491D41</string></var>" +
  "<var name='color'><string>red</string></var>" +
  "<var name='fieldnames'><string>name,Email,comments,color</string></var>" +
  "<var name='comments'><string>l1<char code='0d'/><char code='0a'/>l2<char code='09'/>&amp;&lt;&gt;'\"é</string></var>" +
  "<var name='Email'><string>b@x.com</string></var>" +
  "<var name='name'><string>Bob &lt;nonoscript&gt;x&lt;/noscript&gt;</string></var>" +
  '</struct></data></wddxPacket>';
const FORM_UPDATE =
  "<wddxPacket version='1.0'><header/><data>" +
  "<struct><var name='responseid'><string>C33981F1-CE76-D22E-93A50AB350491D41</string></var>" +
  "<var name='fieldnames'><string>name,Email,comments,color</string></var>" +
  "<var name='comments'><string>c2</string></var><var name='Email'><string>b2@x.com</string></var>" +
  "<var name='name'><string>Bobby</string></var></struct></data></wddxPacket>";

const part = (fieldName: string, fileName: string, contentType = 'application/pdf'): UploadedFile =>
  uploadedFile({ fieldName, fileName, contentType }, Buffer.from(`bytes of ${fileName}`));
const link = { scheme: 'http', domain: 'tenant-a.local', serverPort: ':8080', context: '' };

/** A packet of string `fields` as cfwddx writes it, CR and LF as char codes. */
const packetOf = (fields: Readonly<Record<string, string>>): string =>
  "<wddxPacket version='1.0'><header/><data><struct>" +
  Object.entries(fields)
    .map(([name, value]) => `<var name='${name}'><string>${value.replaceAll('\r', "<char code='0d'/>").replaceAll('\n', "<char code='0a'/>")}</string></var>`)
    .join('') +
  '</struct></data></wddxPacket>';

/** downloaddata.cfm's `fixDelim`. */
const fixDelim = (value: string): string => `"${value.replaceAll('"', '""').replaceAll('\r\n', ' ')}"`;

/** FORM's active version. */
const MY_FORM: VersionInput = { title: 'My Form', body: '<form></form>', responsedisplayfields: 'name^Email~name', sortby: 'Entered', sortdirection: 'desc', nextn: 10 };
/** FORM's inactive version. */
const MY_FORM_OLD: VersionInput = { active: 0, approved: 0, title: 'My Form old', body: '', responsedisplayfields: '', sortby: 'orderno', sortdirection: 'asc', nextn: 5 };
/** MY_FORM with the display fields, sort and nextN the setDisplay case writes. */
const MY_FORM_SHOWN: VersionInput = { ...MY_FORM, responsedisplayfields: 'Email^name~name', sortby: 'name', sortdirection: 'asc', nextn: 25 };
/** OTHER_FORM's version: an ORM form typed in lower case. */
const ANOTHER: VersionInput = { type: 'form', title: 'Another', body: '{"form":{"muraormentities":1,"formattributes":{"muraormentities":true}}}' };
/** The entry time the captured update keeps. */
const BOBBY_ENTERED = new Date(2026, 5, 1, 9, 30, 0, 0);

/** Inserts version `cfId('H', histN)` of form `formId`, active, approved and displayed unless `fields` say otherwise. */
const insertForm = (fx: ContentFixture, formId: string, histN: number, fields: VersionInput) =>
  fx.inTenant((tx) =>
    fx.repo.content.insertVersion(tx, {
      contentid: formId, contenthistid: cfId('H', histN), siteid: SITE_ID, type: 'Form', subtype: 'Default', moduleid: '00000000000000000000000000000000004',
      active: 1, approved: 1, display: 1, ...fields,
    }),
  );

/** Seeds FORM's two versions and OTHER_FORM. */
const seedForms = async (fx: ContentFixture): Promise<void> => {
  await insertForm(fx, FORM, 1, MY_FORM);
  await insertForm(fx, FORM, 2, MY_FORM_OLD);
  await insertForm(fx, OTHER_FORM, 3, ANOTHER);
};

describe.skipIf(!(await pgAvailable()))('domain/forms', () => {
  let fx: ContentFixture;

  /** The captured create: Bob's response to `formId`, with ignored fields and a `_default` rename. */
  const createBob = (formId: string) =>
    updateResponse(fx.deps, ADMIN, {
      formid: formId,
      siteid: SITE_ID,
      fieldnames: 'name,Email,comments,color_default,CSRF_TOKEN,siteid',
      name: '  Bob <script>x</script> ',
      Email: 'b@x.com',
      comments: 'l1\r\nl2\t&<>\'"é',
      color_default: 'red',
      csrf_token: 'tok',
    });

  /** The captured update of response `responseId` to `formId`: Bobby, entered at BOBBY_ENTERED. */
  const updateBob = (formId: string, responseId: string) =>
    updateResponse(fx.deps, ADMIN, {
      responseid: responseId,
      formid: formId,
      siteid: SITE_ID,
      fieldlist: 'name,Email,comments,color',
      entered: cfTimestampText(BOBBY_ENTERED),
      name: 'Bobby',
      Email: 'b2@x.com',
      comments: 'c2',
    });

  beforeAll(async () => {
    fx = await createContentFixture('forms-test');
    await seedForms(fx);
  });

  afterAll(async () => {
    await fx?.drop();
  });

  it('submitForm throws the undefined legacy method error', () => {
    expect(() => submitForm()).toThrow(UndefinedLegacyMethodError);
  });

  it('creates a response with the captured packet bytes, ignore list and _default rename', async () => {
    expect(FORM_FIELD_IGNORE_LIST.startsWith('_P,CSSCLASS')).toBe(true);
    const created = await createBob(FORM);
    expect(isCfUuid(created.responseId)).toBe(true);
    expect(created.packet.data).toBe(FORM_CREATE.replace(RID, created.responseId));
    expect(created.packet.fieldlist).toBe('name,Email,comments,color');
    expect(created.packet.entered).toEqual(NOW);
    expect(created.questions.map((q) => [q.formfield, q.formvalue])).toEqual([
      ['name', 'Bob <nonoscript>x</noscript>'],
      ['Email', 'b@x.com'],
      ['comments', 'l1\r\nl2\t&<>\'"é'],
      ['color', 'red'],
    ]);
  });

  it('updates a response keeping entered and the packet bytes', async () => {
    const { responseId } = await createBob(FORM);
    const written = await updateBob(FORM, responseId);
    expect(written.packet.data).toBe(FORM_UPDATE.replace(RID, responseId));
    expect(written.packet.entered).toEqual(BOBBY_ENTERED);
    expect(written.questions).toHaveLength(3);
    const row = await readResponse(fx.deps, ADMIN, responseId);
    expect(wddxStructGet(responseValues(row ?? { data: '' }) as WddxStruct, 'NAME')).toBe('Bobby');
    const stored = await fx.rows('form_response_question', 'responseid = $1', [responseId], 'lower(formfield)');
    expect(stored.map((q) => [q.formfield, q.formvalue])).toEqual([
      ['comments', 'c2'],
      ['Email', 'b2@x.com'],
      ['name', 'Bobby'],
    ]);
    expect((await fx.rows('form_response_packet', 'responseid = $1', [responseId])).map((p) => p.data)).toEqual([FORM_UPDATE.replace(RID, responseId)]);
  });

  it('neutralises <script and <form openers, then script> and form> closers, after the trim, as REReplaceNoCase ALL does', async () => {
    const neutralised = {
      opener: '<noscript action="x">in</noscript>',
      bare: '<nonoscript>x</noscript>',
      script: 'a<noscript src=y></noscript>b',
    };
    const written = await updateResponse(fx.deps, ADMIN, {
      formid: cfId('F', 7),
      siteid: SITE_ID,
      fieldnames: 'opener,bare,script',
      opener: '<FORM action="x">in</Form>',
      bare: ' <form>x</form> ',
      script: 'a<Script src=y></SCRIPT>b',
    });
    expect(written.questions.map((q) => [q.formfield, q.formvalue, q.pollvalue])).toEqual(Object.entries(neutralised).map(([field, value]) => [field, value, value]));
    const packet = wddx2cfml(written.packet.data ?? '') as WddxStruct;
    expect(Object.keys(neutralised).map((field) => wddxStructGet(packet, field))).toEqual(Object.values(neutralised));
    await deleteResponse(fx.deps, ADMIN, written.responseId);
  });

  it('stores a non-image attachment, refuses an image and deletes the file with the response', async () => {
    const withFile = await updateResponse(
      fx.deps,
      ADMIN,
      { formid: FORM, siteid: SITE_ID, fieldnames: 'attachment1,note', attachment1: 'doc.pdf', note: 'n' },
      [part('attachment1', 'doc.pdf')],
    );
    const fileId = String(wddxStructGet(withFile.info, 'attachment1'));
    expect(isCfUuid(fileId)).toBe(true);
    const stored = await fx.inTenant((tx) => fx.repo.files.readFileAll(tx, fileId), TENANT_UMBRELLA.tenantId);
    expect(stored).toMatchObject({ contentid: FORM, moduleid: '00000000000000000000000000000000004', deleted: 0 });
    // No posted part: the value is kept.
    const text = await updateResponse(fx.deps, ADMIN, { formid: FORM, siteid: SITE_ID, fieldnames: 'attachment2', attachment2: 'plain' });
    expect(wddxStructGet(text.info, 'attachment2')).toBe('plain');
    await expect(
      updateResponse(fx.deps, ADMIN, { formid: FORM, siteid: SITE_ID, fieldnames: 'attachment1', attachment1: 'a.png' }, [part('attachment1', 'a.png', 'image/png')]),
    ).rejects.toBeInstanceOf(ImageUploadHaltedError);
    const deletion = await deleteResponse(fx.deps, ADMIN, withFile.responseId);
    expect(deletion.attachmentFileIds).toEqual([fileId]);
    const after = await fx.inTenant((tx) => fx.repo.files.readFileAll(tx, fileId), TENANT_UMBRELLA.tenantId);
    expect(after).toMatchObject({ deleted: 1 });
    await deleteResponse(fx.deps, ADMIN, text.responseId);
  });

  it('deleteResponse without deleteFiles removes the packet and question rows and leaves the attachment file undeleted', async () => {
    const written = await updateResponse(
      fx.deps,
      ADMIN,
      { formid: cfId('F', 8), siteid: SITE_ID, fieldnames: 'attachment1,note', attachment1: 'kept.pdf', note: 'n' },
      [part('attachment1', 'kept.pdf')],
    );
    const fileId = String(wddxStructGet(written.info, 'attachment1'));
    const storedCounts = async (): Promise<number[]> => [
      (await fx.rows('form_response_packet', 'responseid = $1', [written.responseId])).length,
      (await fx.rows('form_response_question', 'responseid = $1', [written.responseId])).length,
    ];
    expect(await storedCounts()).toEqual([1, 2]);
    const deletion = await deleteResponse(fx.deps, ADMIN, written.responseId, false);
    expect(deletion.attachmentFileIds).toEqual([fileId]);
    expect(await storedCounts()).toEqual([0, 0]);
    expect(await fx.inTenant((tx) => fx.repo.files.readFileAll(tx, fileId), TENANT_UMBRELLA.tenantId)).toMatchObject({ deleted: 0 });
  });

  it('lists fields and filters with an unwildcarded keyword', async () => {
    const formId = cfId('F', 10);
    await insertForm(fx, formId, 7, MY_FORM);
    await updateBob(formId, (await createBob(formId)).responseId);
    expect(await getFullFieldList(fx.deps, ADMIN, formId)).toBe('comments,Email,name');
    expect(await getCurrentFieldList(fx.deps, ADMIN, formId)).toBe('name,Email');
    const rc = { contentid: formId, siteid: SITE_ID, sortBy: 'name', sortDirection: 'asc', keywords: 'Bobby', filterBy: 'name', fieldnames: 'name,Email', date1: '', date2: '' };
    expect(await getData(fx.deps, ADMIN, rc)).toHaveLength(1);
    expect(await getData(fx.deps, ADMIN, { ...rc, keywords: 'Bob' })).toHaveLength(0);
    expect(await getData(fx.deps, ADMIN, { ...rc, keywords: 'Bob%' })).toHaveLength(1);
    expect(await getData(fx.deps, ADMIN, { ...rc, keywords: 'Bobby', filterBy: 'Email' })).toHaveLength(0);
    const args = formResponsesArgs({ ...rc, keywords: '', date1: '06/01/2026', hour1: '9', minute1: '5', date2: '06/30/2026', hour2: '23', minute2: '59', sortBy: 'Entered', sortDirection: '' });
    expect(args.start).toEqual(new Date(2026, 5, 1, 9, 5, 0));
    expect(args.stop).toEqual(new Date(2026, 5, 30, 23, 59, 59));
    expect(args.sortDirection).toBeUndefined();
    expect(() => formResponsesArgs({ ...rc, date1: '06/01/2026' })).toThrow();
    expect(() => formResponsesArgs({ contentid: formId, siteid: SITE_ID, sortBy: 'Entered' })).toThrow();
  });

  it('sorts by a listed field in the requested direction, and by entry date otherwise', async () => {
    const formId = cfId('F', 3);
    const answer = (score: string) => updateResponse(fx.deps, ADMIN, { formid: formId, siteid: SITE_ID, fieldnames: 'score', score });
    const low = await answer('a');
    const high = await answer('b');
    const rc = { contentid: formId, siteid: SITE_ID, keywords: '', fieldnames: 'score', sortBy: 'score', sortDirection: 'desc' };
    expect((await getData(fx.deps, ADMIN, rc)).map((row) => row.responseid)).toEqual([high.responseId, low.responseId]);
    expect((await getData(fx.deps, ADMIN, { ...rc, sortDirection: 'ASC' })).map((row) => row.responseid)).toEqual([low.responseId, high.responseId]);
    // listFind is case-sensitive, so `SCORE` is no listed field and the default entry-date order applies.
    expect(formResponsesArgs({ ...rc, sortBy: 'SCORE' }).sortDirection).toBeUndefined();
    await deleteResponse(fx.deps, ADMIN, low.responseId);
    await deleteResponse(fx.deps, ADMIN, high.responseId);
  });

  it('setDisplay through the data manager updates every version, and CSRF gates writes', async () => {
    const formId = cfId('F', 9);
    await insertForm(fx, formId, 5, MY_FORM);
    await insertForm(fx, formId, 6, MY_FORM_OLD);
    const { responseId } = await createBob(formId);
    const validated: string[] = [];
    const deny = { validateCsrfTokens: async (c: string) => (validated.push(c), false) };
    const noop = await dataManagerAction(fx.deps, ADMIN, { siteid: SITE_ID, contentid: formId, action: 'Delete', responseid: responseId, date1: '', date2: '' }, deny);
    expect(noop.outcome).toBe('none');
    expect(validated).toEqual([responseId]);
    expect(await readResponse(fx.deps, ADMIN, responseId)).not.toBeNull();

    const updated = await dataManagerAction(
      fx.deps,
      ADMIN,
      {
        siteid: SITE_ID, contentid: formId, formid: formId, action: 'update', responseid: responseId, date1: '', date2: '',
        fieldlist: 'name,Email,comments,color', entered: '2026-06-01 09:30:00.0', name: 'Bobby', Email: 'b2@x.com', comments: 'c2',
      },
      { validateCsrfTokens: async (c: string) => (validated.push(c), true) },
    );
    expect(updated.outcome).toBe('updated');
    expect(updated.rc).toMatchObject({ keywords: '', filterBy: '', sortBy: 'Entered', sortDirection: 'desc' });
    expect((await readResponse(fx.deps, ADMIN, responseId))?.data).toBe(FORM_UPDATE.replace(RID, responseId));

    const shown = await dataManagerAction(
      fx.deps,
      ADMIN,
      { siteid: SITE_ID, contentid: formId, action: 'setDisplay', detailList2: 'Email^name', summaryList2: 'name', nextn: '25', sortBy: ' name ', sortDirection: 'asc', date1: '', date2: '' },
      deny,
    );
    expect(shown.outcome).toBe('display-set');
    expect(shown.rc.action).toBe('');
    expect(shown.view).toBe('responses');
    const versions = await fx.rows('content', 'contentid = $1', [formId]);
    expect(versions.map((v) => [v.responsedisplayfields, v.sortby, v.sortdirection, v.nextn])).toEqual([
      ['Email^name~name', 'name', 'asc', 25],
      ['Email^name~name', 'name', 'asc', 25],
    ]);
    expect(validated).toEqual([responseId, responseId]);
  });

  it.each([
    ['the seed dataset ISO text', '2026-03-05T17:04:00.000', 20],
    ['the edit form CF text', '2026-03-05 17:04:00.0', 21],
  ] as const)('updates a seeded response from the data manager edit post with entered as %s, writing the packet legacy wrote', async (_label, entered, n) => {
    const formId = cfId('F', n);
    await insertForm(fx, formId, n, MY_FORM);
    const seeded = await updateResponse(fx.deps, ADMIN, {
      formid: formId, siteid: SITE_ID, fieldnames: 'fullname,email,message',
      fullname: 'Trenton Kuhn-Rice', email: 'trenton.kuhnrice@seed.opt2.test', message: 'Aegre sapiente nemo ancilla titulus blanditiis.',
    });
    expect(seeded.packet.fieldlist).toBe('fullname,email,message');
    const validated: string[] = [];
    const result = await dataManagerAction(
      fx.deps,
      ADMIN,
      {
        fullname: 'Trenton Kuhn-Rice', email: 'trenton.kuhnrice@seed.opt2.test', message: 'Data manager updated message',
        formid: formId, contentid: formId, siteid: SITE_ID, muraAction: 'cArch.datamanager', responseID: seeded.responseId,
        hour1: '0', hour2: '23', minute1: '0', minute2: '59', date1: '', date2: '', fieldlist: 'email,fullname,message',
        sortBy: 'Entered', sortDirection: 'asc', filterBy: '', keywords: '', entered, moduleid: '00000000000000000000000000000000004', action: 'update',
      },
      { validateCsrfTokens: async (c: string) => (validated.push(c), true) },
    );
    expect([result.outcome, validated]).toEqual(['updated', [seeded.responseId]]);
    // tformresponsepackets.Data legacy wrote for the same edit post.
    const legacyPacket =
      "<wddxPacket version='1.0'><header/><data><struct>" +
      `<var name='responseid'><string>${seeded.responseId}</string></var>` +
      "<var name='message'><string>Data manager updated message</string></var>" +
      "<var name='fieldnames'><string>email,fullname,message</string></var>" +
      "<var name='email'><string>trenton.kuhnrice@seed.opt2.test</string></var>" +
      "<var name='fullname'><string>Trenton Kuhn-Rice</string></var>" +
      '</struct></data></wddxPacket>';
    const [packet] = await fx.rows('form_response_packet', 'responseid = $1', [seeded.responseId]);
    expect(packet).toMatchObject({ data: legacyPacket, fieldlist: 'email,fullname,message', entered: new Date(2026, 2, 5, 17, 4, 0, 0) });
    const questions = await fx.rows('form_response_question', 'responseid = $1', [seeded.responseId], 'formfield');
    expect(questions.map((q) => [q.formfield, q.formvalue, q.pollvalue])).toEqual([
      ['email', 'trenton.kuhnrice@seed.opt2.test', 'trenton.kuhnrice@seed.opt2.test'],
      ['fullname', 'Trenton Kuhn-Rice', 'Trenton Kuhn-Rice'],
      ['message', 'Data manager updated message', 'Data manager updated message'],
    ]);
  });

  it('downloads the CSV as downloaddata.cfm writes it', async () => {
    const formId = cfId('F', 11);
    await insertForm(fx, formId, 8, MY_FORM_SHOWN);
    await updateBob(formId, (await createBob(formId)).responseId);
    const result = await downloadData(fx.deps, ADMIN, { siteid: SITE_ID, contentid: formId, sortBy: 'Entered', sortDirection: 'asc', keywords: '', columns: 'fixed', date1: '', date2: '' }, { link });
    expect(result.columns).toEqual(['Email', 'name']);
    expect(result.fileName).toMatch(/^My-Form_\d{6}\.csv$/);
    expect(await text(result.body)).toBe(`DATE/TIME ENTERED,Email,name,\r\n2026-06-01 09:30:00.0,"b2@x.com","Bobby",\r\n`);
  });

  it('deletes the filtered responses on the response view', async () => {
    const formId = cfId('F', 12);
    await insertForm(fx, formId, 9, MY_FORM_SHOWN);
    const { responseId } = await updateBob(formId, (await createBob(formId)).responseId);
    const result = await dataManagerAction(
      fx.deps,
      ADMIN,
      { siteid: SITE_ID, contentid: formId, action: '', date1: 'nope', hour1: '0', minute1: '0', date2: '', hour2: '23', minute2: '59', delete: '1' },
      { validateCsrfTokens: async () => true },
    );
    expect(result.filteredDeletions).toBe(1);
    expect(await readResponse(fx.deps, ADMIN, responseId)).toBeNull();
  });

  it('writes attachment links and quoted cells over each row field list, and honours the test-field restriction', async () => {
    const formId = cfId('F', 13);
    await insertForm(fx, formId, 10, ANOTHER);
    const fileId = cfId('A', 7);
    const restricted = await updateResponse(
      fx.deps,
      ADMIN,
      { formid: formId, siteid: SITE_ID, fieldnames: 'attachmentx,quote', attachmentx: 'run.exe', quote: 'say "hi"\r\nbye' },
      [part('attachmentx', 'run.exe'), part('test', 'evil.exe')],
    );
    expect(wddxStructGet(restricted.info, 'attachmentx')).toBe('run.exe');
    await updateResponse(fx.deps, ADMIN, { formid: formId, siteid: SITE_ID, fieldnames: 'attachmentx', attachmentx: fileId });
    const csv = await downloadData(fx.deps, ADMIN, { siteid: SITE_ID, contentid: formId, sortBy: 'Entered', sortDirection: 'asc', keywords: '', date1: '', date2: '' }, { link });
    expect(csv.columns).toEqual(['attachmentx', 'quote']);
    const [header, ...lines] = (await text(csv.body)).split('\r\n');
    expect(header).toBe('DATE/TIME ENTERED,attachmentx,quote,');
    // Both rows share the fixed clock's entry time, so their order is the responseid tiebreak.
    expect(lines.map((line) => line.replace(`${cfTimestampText(NOW)},`, '')).sort()).toEqual([
      '',
      '"run.exe","say ""hi"" bye",',
      `http://tenant-a.local:8080/index.cfm/_api/render/file/?fileID=${fileId},`,
    ]);
    expect(csv.fileName).toMatch(/^Another_/);
  });

  it('classifies form bodies and reads the active form', async () => {
    expect(dataManagerView('<form/>', '')).toBe('responses');
    expect(dataManagerView('{"form":{"muraormentities":1,"formattributes":{"muraormentities":true}}}', 'edit')).toBe('orm');
    expect(dataManagerView('{"x":1}', '')).toBe('abort');
    expect(dataManagerView('{"form":{}}', 'EDIT')).toBe('edit');
    expect(dataManagerView('{"form":{"muraormentities":1}}', '')).toBe('abort');
    expect((await getActiveForm(fx.deps, ADMIN, FORM, SITE_ID)).text('title')).toBe('My Form');
    expect((await getActiveForm(fx.deps, ADMIN, cfId('Z', 9), SITE_ID)).isNew).toBe(1);
  });

  describe('more responses than one cursor batch', () => {
    const BIG_FORM = cfId('F', 4);
    /** BIG_FORM's version. */
    const BIG: VersionInput = { title: 'Big Form', body: '<form></form>', responsedisplayfields: 'n^note~n', sortby: 'Entered', sortdirection: 'asc', nextn: 10 };
    const MANY = 2 * DEFAULT_ROW_BATCH_SIZE + 201;
    const FIRST_ENTERED = new Date(2026, 4, 1, 8, 0, 0, 0);
    const big = Array.from({ length: MANY }, (_, i) => ({
      entered: new Date(FIRST_ENTERED.getTime() + i * 1000),
      n: String(i + 1),
      note: `say "hi"\r\nrow ${i + 1} of the streamed download`,
      fieldlist: i % 2 === 0 ? 'note,n' : 'n',
    }));
    const rcOf = (contentid: string, columns: string) => ({ siteid: SITE_ID, contentid, sortBy: 'Entered', sortDirection: 'asc', keywords: '', columns, date1: '', date2: '' });

    /** Inserts `rows` as packets of `formId` in one statement. */
    const insertPackets = (formId: string, rows: ReadonlyArray<{ responseid: string; entered: Date; fieldlist: string; data: string }>) =>
      fx.inTenant((tx) =>
        tx.query(
          `INSERT INTO ${fx.handle.schema}.form_response_packet (tenant_id, responseid, formid, siteid, fieldlist, data, entered)` +
            ' SELECT $1::uuid, r.responseid, $2::text, $3::text, r.fieldlist, r.data, r.entered' +
            ' FROM unnest($4::text[], $5::text[], $6::text[], $7::timestamp[]) AS r(responseid, fieldlist, data, entered)',
          [ADMIN.tenantId, formId, SITE_ID, rows.map((r) => r.responseid), rows.map((r) => r.fieldlist), rows.map((r) => r.data), rows.map((r) => r.entered)],
        ),
      );

    /** `big` as packets whose response ids carry `prefix`. */
    const bigPackets = (prefix: string) => big.map((row, i) => ({ ...row, responseid: cfId(prefix, i + 1), data: packetOf({ n: row.n, note: row.note }) }));

    /** downloaddata.cfm's bytes for `big`: over `n,note` with `columns=fixed`, else over each row's `fieldlist`. */
    const legacyCsv = (fixed: boolean): string =>
      'DATE/TIME ENTERED,n,note,\r\n' +
      big
        .map((row) => `${cfTimestampText(row.entered)},${(fixed ? ['n', 'note'] : row.fieldlist.split(',')).map((f) => `${fixDelim(f === 'n' ? row.n : row.note)},`).join('')}\r\n`)
        .join('');

    /** `fx.deps` whose response batches count what they fetched and record that their cursor closed. */
    const trackedDeps = (): { deps: ContentDeps; tracked: { fetched: number; closed: boolean } } => {
      const tracked = { fetched: 0, closed: false };
      const forms = fx.repo.forms;
      const repository = {
        ...fx.repo,
        forms: {
          ...forms,
          async *responseBatches(...args: Parameters<typeof forms.responseBatches>) {
            try {
              for await (const batch of forms.responseBatches(...args)) {
                tracked.fetched += 1;
                yield batch;
              }
            } finally {
              tracked.closed = true;
            }
          },
        },
      };
      return { deps: { ...fx.deps, repository }, tracked };
    };

    beforeAll(async () => {
      await insertForm(fx, BIG_FORM, 4, BIG);
      await insertPackets(BIG_FORM, bigPackets('R'));
    });

    it.each([
      ['the field list with columns=fixed', 'fixed', true],
      ['each row’s own field list', '', false],
    ] as const)('streams %s over three batches as downloaddata.cfm writes it, fetching no batch before the reader drains the last', async (_case, columns, fixed) => {
      const { deps, tracked } = trackedDeps();
      const result = await downloadData(deps, ADMIN, rcOf(BIG_FORM, columns), { link });
      await setTimeout(50);
      expect(tracked.fetched).toBe(1);
      expect([result.columns, result.fileName]).toEqual([['n', 'note'], expect.stringMatching(/^Big-Form_\d{6}\.csv$/)]);
      expect(await text(result.body)).toBe(legacyCsv(fixed));
      expect(tracked).toEqual({ fetched: 3, closed: true });
    });

    it('releases the cursor, transaction and connection when the reader destroys the body mid-stream, writing nothing after', async () => {
      const { deps, tracked } = trackedDeps();
      const result = await downloadData(deps, ADMIN, rcOf(BIG_FORM, 'fixed'), { link });
      const first = await new Promise<Buffer>((resolve) => result.body.once('data', resolve));
      expect(first.toString()).toMatch(/^DATE\/TIME ENTERED,n,note,\r\n/);
      const write = vi.spyOn(result.body as PassThrough, 'write');
      result.body.destroy();
      // The suite's pool holds 4 connections, so 4 transactions open together only once the download released its own.
      let entered = 0;
      let together = (): void => undefined;
      const all = new Promise<void>((resolve) => {
        together = resolve;
      });
      const held = Promise.all(
        Array.from({ length: 4 }, () =>
          fx.inTenant(async (tx) => {
            await tx.query('SELECT 1');
            entered += 1;
            if (entered === 4) together();
            await all;
          }),
        ),
      );
      const outcome = await Promise.race([held.then(() => 'served'), setTimeout(10_000, 'starved')]);
      together();
      expect(outcome).toBe('served');
      expect(tracked.closed).toBe(true);
      expect(tracked.fetched).toBeLessThan(3);
      expect(write).not.toHaveBeenCalled();
    });

    it.each([
      ['the first batch rejects downloadData', cfId('F', 5), 'V', 1, 'downloadData'],
      ['a later batch destroys the body with its error', cfId('F', 6), 'W', DEFAULT_ROW_BATCH_SIZE + 1, 'body'],
    ] as const)('an invalid packet in %s', async (_case, formId, prefix, count, failing) => {
      await insertPackets(
        formId,
        Array.from({ length: count }, (_, i) => ({
          responseid: cfId(prefix, i + 1),
          entered: new Date(FIRST_ENTERED.getTime() + i * 1000),
          fieldlist: 'n',
          data: i === count - 1 ? '<not wddx' : packetOf({ n: String(i + 1) }),
        })),
      );
      const download = downloadData(fx.deps, ADMIN, rcOf(formId, 'fixed'), { link });
      await expect(failing === 'downloadData' ? download : download.then((result) => text(result.body))).rejects.toThrow('Invalid WDDX packet');
    });

    it('deletes the filtered responses streamed over every batch, only for a true boolean `delete`, counting them', async () => {
      const formId = cfId('F', 14);
      await insertForm(fx, formId, 11, BIG);
      await insertPackets(formId, bigPackets('D'));
      const rc = { siteid: SITE_ID, contentid: formId, action: '', date1: '', hour1: '0', minute1: '0', date2: '', hour2: '23', minute2: '59' };
      const csrf = { validateCsrfTokens: async () => true };
      const remaining = async () => (await fx.rows('form_response_packet', 'formid = $1', [formId])).length;
      expect((await dataManagerAction(fx.deps, ADMIN, { ...rc, delete: 'maybe' }, csrf)).filteredDeletions).toBeNull();
      expect(await remaining()).toBe(MANY);
      expect((await dataManagerAction(fx.deps, ADMIN, { ...rc, delete: 'yes' }, csrf)).filteredDeletions).toBe(MANY);
      expect(await remaining()).toBe(0);
      expect((await dataManagerAction(fx.deps, ADMIN, { ...rc, delete: 'yes' }, csrf)).filteredDeletions).toBeNull();
    });
  });
});

describe.skipIf(!(await pgAvailable()))('domain/forms listing', () => {
  let fx: ContentFixture;

  beforeAll(async () => {
    fx = await createContentFixture('forms-list-test');
    await seedForms(fx);
  });

  afterAll(async () => {
    await fx?.drop();
  });

  it('builds cform bean inputs and lists forms', async () => {
    expect(isCfUuid(cformFormBean({}).formId)).toBe(true);
    expect(cformFormBean({ FORMID: 'x' }).formId).toBe('x');
    expect(cformFieldBean({ formID: FORM })).toMatchObject({ formId: FORM, fieldType: 'field-textfield' });
    expect(cformFieldBean({}).formId).toBeUndefined();
    expect(cformFieldTypeBean({ fieldtype: 'field-dropdown', fieldTypeID: 'k' })).toEqual({ fieldTypeId: 'k', fieldType: 'field-dropdown' });
    expect(isCfUuid(cformDatasetBean({ datasetID: '', fieldID: FORM }).datasetId)).toBe(true);
    expect(cformDatasetBean({ datasetID: 'd' })).toEqual({ datasetId: 'd', fieldId: undefined });
    const formJson = formBeanJson(cformFormBean({ formID: FORM }));
    expect((JSON.parse(formJson) as { formid: string }).formid).toBe(FORM);
    expect(renderCformResponse('json', formJson).contentType).toBe(LEGACY_JSON_CONTENT_TYPE);
    expect((await getForms(fx.deps, ADMIN, SITE_ID)).map((f) => f.title)).toEqual(['Another', 'My Form']);
    expect((await getForms(fx.deps, ADMIN, SITE_ID, OTHER_FORM.toLowerCase())).map((f) => f.title)).toEqual(['My Form']);
  });
});
