/** Form responses, the data manager and the cform dialog inputs (GS-CO-14) over a throwaway `content` schema and local storage. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LEGACY_JSON_CONTENT_TYPE, cfTimestampText, isCfUuid } from '@opt2/platform/legacy-compat';
import { TENANT_UMBRELLA, pgAvailable } from '@opt2/platform/testing';
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
import { wddxStructGet, type WddxStruct } from '../../src/domain/wddx.js';
import { ADMIN, NOW, SITE_ID, cfId, createContentFixture, type ContentFixture } from '../helpers/content-fixture.js';

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

const part = (fieldName: string, fileName: string, contentType = 'application/pdf'): UploadedFile => ({
  fieldName,
  fileName,
  contentType,
  bytes: Buffer.from(`bytes of ${fileName}`),
});
const link = { scheme: 'http', domain: 'tenant-a.local', serverPort: ':8080', context: '' };

describe.skipIf(!(await pgAvailable()))('domain/forms', () => {
  let fx: ContentFixture;
  let createdId = '';

  beforeAll(async () => {
    fx = await createContentFixture('forms-test');
    await fx.inTenant(async (tx) => {
      await fx.repo.content.insertVersion(tx, {
        contentid: FORM, contenthistid: cfId('H', 1), siteid: SITE_ID, type: 'Form', subtype: 'Default', moduleid: '00000000000000000000000000000000004',
        active: 1, approved: 1, display: 1, title: 'My Form', body: '<form></form>', responsedisplayfields: 'name^Email~name', sortby: 'Entered', sortdirection: 'desc', nextn: 10,
      });
      await fx.repo.content.insertVersion(tx, {
        contentid: FORM, contenthistid: cfId('H', 2), siteid: SITE_ID, type: 'Form', subtype: 'Default', moduleid: '00000000000000000000000000000000004',
        active: 0, approved: 0, display: 1, title: 'My Form old', body: '', responsedisplayfields: '', sortby: 'orderno', sortdirection: 'asc', nextn: 5,
      });
      await fx.repo.content.insertVersion(tx, {
        contentid: OTHER_FORM, contenthistid: cfId('H', 3), siteid: SITE_ID, type: 'form', subtype: 'Default', moduleid: '00000000000000000000000000000000004',
        active: 1, approved: 1, display: 1, title: 'Another', body: '{"form":{"muraormentities":1,"formattributes":{"muraormentities":true}}}',
      });
    });
  });

  afterAll(async () => {
    await fx?.drop();
  });

  it('submitForm throws the undefined legacy method error', () => {
    expect(() => submitForm()).toThrow(UndefinedLegacyMethodError);
  });

  it('creates a response with the captured packet bytes, ignore list and _default rename', async () => {
    expect(FORM_FIELD_IGNORE_LIST.startsWith('_P,CSSCLASS')).toBe(true);
    const created = await updateResponse(fx.deps, ADMIN, {
      formid: FORM,
      siteid: SITE_ID,
      fieldnames: 'name,Email,comments,color_default,CSRF_TOKEN,siteid',
      name: '  Bob <script>x</script> ',
      Email: 'b@x.com',
      comments: 'l1\r\nl2\t&<>\'"é',
      color_default: 'red',
      csrf_token: 'tok',
    });
    createdId = created.responseId;
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
    const entered = new Date(2026, 5, 1, 9, 30, 0, 0);
    const written = await updateResponse(fx.deps, ADMIN, {
      responseid: createdId,
      formid: FORM,
      siteid: SITE_ID,
      fieldlist: 'name,Email,comments,color',
      entered: cfTimestampText(entered),
      name: 'Bobby',
      Email: 'b2@x.com',
      comments: 'c2',
    });
    expect(written.packet.data).toBe(FORM_UPDATE.replace(RID, createdId));
    expect(written.packet.entered).toEqual(entered);
    expect(written.questions).toHaveLength(3);
    const row = await readResponse(fx.deps, ADMIN, createdId);
    expect(wddxStructGet(responseValues(row ?? { data: '' }) as WddxStruct, 'NAME')).toBe('Bobby');
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

  it('lists fields and filters with an unwildcarded keyword', async () => {
    expect(await getFullFieldList(fx.deps, ADMIN, FORM)).toBe('comments,Email,name');
    expect(await getCurrentFieldList(fx.deps, ADMIN, FORM)).toBe('name,Email');
    const rc = { contentid: FORM, siteid: SITE_ID, sortBy: 'name', sortDirection: 'asc', keywords: 'Bobby', filterBy: 'name', fieldnames: 'name,Email', date1: '', date2: '' };
    expect(await getData(fx.deps, ADMIN, rc)).toHaveLength(1);
    expect(await getData(fx.deps, ADMIN, { ...rc, keywords: 'Bob' })).toHaveLength(0);
    expect(await getData(fx.deps, ADMIN, { ...rc, keywords: 'Bob%' })).toHaveLength(1);
    expect(await getData(fx.deps, ADMIN, { ...rc, keywords: 'Bobby', filterBy: 'Email' })).toHaveLength(0);
    const args = formResponsesArgs({ ...rc, keywords: '', date1: '06/01/2026', hour1: '9', minute1: '5', date2: '06/30/2026', hour2: '23', minute2: '59', sortBy: 'Entered', sortDirection: '' });
    expect(args.start).toEqual(new Date(2026, 5, 1, 9, 5, 0));
    expect(args.stop).toEqual(new Date(2026, 5, 30, 23, 59, 59));
    expect(args.sortDirection).toBeUndefined();
    expect(() => formResponsesArgs({ ...rc, date1: '06/01/2026' })).toThrow();
    expect(() => formResponsesArgs({ contentid: FORM, siteid: SITE_ID, sortBy: 'Entered' })).toThrow();
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
    const validated: string[] = [];
    const deny = { validateCsrfTokens: async (c: string) => (validated.push(c), false) };
    const noop = await dataManagerAction(fx.deps, ADMIN, { siteid: SITE_ID, contentid: FORM, action: 'Delete', responseid: createdId, date1: '', date2: '' }, deny);
    expect(noop.outcome).toBe('none');
    expect(validated).toEqual([createdId]);
    expect(await readResponse(fx.deps, ADMIN, createdId)).not.toBeNull();

    const updated = await dataManagerAction(
      fx.deps,
      ADMIN,
      {
        siteid: SITE_ID, contentid: FORM, formid: FORM, action: 'update', responseid: createdId, date1: '', date2: '',
        fieldlist: 'name,Email,comments,color', entered: '2026-06-01 09:30:00.0', name: 'Bobby', Email: 'b2@x.com', comments: 'c2',
      },
      { validateCsrfTokens: async (c: string) => (validated.push(c), true) },
    );
    expect(updated.outcome).toBe('updated');
    expect(updated.rc).toMatchObject({ keywords: '', filterBy: '', sortBy: 'Entered', sortDirection: 'desc' });
    expect((await readResponse(fx.deps, ADMIN, createdId))?.data).toBe(FORM_UPDATE.replace(RID, createdId));

    const shown = await dataManagerAction(
      fx.deps,
      ADMIN,
      { siteid: SITE_ID, contentid: FORM, action: 'setDisplay', detailList2: 'Email^name', summaryList2: 'name', nextn: '25', sortBy: ' name ', sortDirection: 'asc', date1: '', date2: '' },
      deny,
    );
    expect(shown.outcome).toBe('display-set');
    expect(shown.rc.action).toBe('');
    expect(shown.view).toBe('responses');
    const versions = await fx.rows('content', 'contentid = $1', [FORM]);
    expect(versions.map((v) => [v.responsedisplayfields, v.sortby, v.sortdirection, v.nextn])).toEqual([
      ['Email^name~name', 'name', 'asc', 25],
      ['Email^name~name', 'name', 'asc', 25],
    ]);
    expect(validated).toEqual([createdId, createdId]);
  });

  it('downloads the CSV as downloaddata.cfm writes it', async () => {
    const result = await downloadData(fx.deps, ADMIN, { siteid: SITE_ID, contentid: FORM, sortBy: 'Entered', sortDirection: 'asc', keywords: '', columns: 'fixed', date1: '', date2: '' }, { link });
    expect(result.columns).toEqual(['Email', 'name']);
    expect(result.fileName).toMatch(/^My-Form_\d{6}\.csv$/);
    expect(result.body).toBe(`DATE/TIME ENTERED,Email,name,\r\n2026-06-01 09:30:00.0,"b2@x.com","Bobby",\r\n`);
  });

  it('deletes the filtered responses on the response view', async () => {
    const result = await dataManagerAction(
      fx.deps,
      ADMIN,
      { siteid: SITE_ID, contentid: FORM, action: '', date1: 'nope', hour1: '0', minute1: '0', date2: '', hour2: '23', minute2: '59', delete: '1' },
      { validateCsrfTokens: async () => true },
    );
    expect(result.filteredDeletions).toBe(1);
    expect(await readResponse(fx.deps, ADMIN, createdId)).toBeNull();
  });

  it('writes attachment links and quoted cells over each row field list, and honours the test-field restriction', async () => {
    const fileId = cfId('A', 7);
    const restricted = await updateResponse(
      fx.deps,
      ADMIN,
      { formid: OTHER_FORM, siteid: SITE_ID, fieldnames: 'attachmentx,quote', attachmentx: 'run.exe', quote: 'say "hi"\r\nbye' },
      [part('attachmentx', 'run.exe'), part('test', 'evil.exe')],
    );
    expect(wddxStructGet(restricted.info, 'attachmentx')).toBe('run.exe');
    await updateResponse(fx.deps, ADMIN, { formid: OTHER_FORM, siteid: SITE_ID, fieldnames: 'attachmentx', attachmentx: fileId });
    const csv = await downloadData(fx.deps, ADMIN, { siteid: SITE_ID, contentid: OTHER_FORM, sortBy: 'Entered', sortDirection: 'asc', keywords: '', date1: '', date2: '' }, { link });
    expect(csv.columns).toEqual(['attachmentx', 'quote']);
    // Both rows share the fixed clock's entry time, so their order is the responseid tiebreak.
    expect(csv.rows.map((r) => r.slice(1)).sort((a, b) => b.length - a.length)).toEqual([
      ['"run.exe"', '"say ""hi"" bye"'],
      [`http://tenant-a.local:8080/index.cfm/_api/render/file/?fileID=${fileId}`],
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
