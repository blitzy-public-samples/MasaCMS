// The content editor's associated file or image selector with its file lock notices (`carch/form/dsp_file_selector.cfm`).
import { cfEq, cfToBoolean, cfToNumber } from '@opt2/platform/legacy-compat';
import { encodeHtml, encodeHtmlAttr, encodeJs, raw, type SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import type { RbLookup } from '@/lib/resource-bundles/rb';
import { isSuperOrAdminUser, structOf, structText, structValue, type CarchStruct } from '../model';
import { fileSelector, fileTools, type EditFormInput, type FileMetaData, type FileSelectorBean } from './custom-tags';

/** The user `stats.getLockID()` loads, as the locked-by-someone-else notice reads it. */
interface FileLockOwner {
  readonly fname: string;
  readonly lname: string;
  readonly email: string;
}

/** The empty user bean `loadBy` returns for an id no user has. */
const UNKNOWN_LOCK_OWNER: FileLockOwner = Object.freeze({ fname: '', lname: '', email: '' });

/** The new metadata bean `getFileMetaData('fileid')` returns when no metadata row matches. */
const NEW_FILE_META: FileMetaData = Object.freeze({
  isNew: true,
  filename: '',
  hasImageFileExt: false,
  hasCroppableImageFileExt: false,
  contentHistId: '',
  fileId: '',
  imageUrl: '',
});

/** The file lock flags of the version's stats for the session user. */
interface FileLock {
  /** `len(stats.getLockID())`, the `locked` attribute of the file tags. */
  readonly locked: boolean;
  readonly lockedByYou: boolean;
  readonly lockedBySomeElse: boolean;
}

/** `fileLockedByYou` and `fileLockedBySomeElse`: a lock that is not a node lock, held by `userId` or by another user. */
function fileLockOf(stats: CarchStruct, userId: string): FileLock {
  const lockId = structText(stats, 'lockID');
  const fileLock = !cfEq(structText(stats, 'lockType'), 'node');
  const holdsLock = cfEq(lockId, userId);
  return {
    locked: lockId.length > 0,
    lockedByYou: fileLock && holdsLock,
    lockedBySomeElse: lockId.length > 0 && fileLock && !holdsLock,
  };
}

/** `contentBean.fileMetaData`, the `getFileMetaData('fileid')` values; absent when no metadata row matches. */
function fileMetaOf(contentBean: CarchStruct): FileMetaData {
  if (structValue(contentBean, 'fileMetaData') === undefined) return NEW_FILE_META;
  const meta = structOf(contentBean, 'fileMetaData');
  return {
    isNew: cfToBoolean(structValue(meta, 'isNew')),
    filename: structText(meta, 'filename'),
    hasImageFileExt: cfToBoolean(structValue(meta, 'hasImageFileExt')),
    hasCroppableImageFileExt: cfToBoolean(structValue(meta, 'hasCroppableImageFileExt')),
    contentHistId: structText(meta, 'contentHistID'),
    fileId: structText(meta, 'fileID'),
    imageUrl: structText(meta, 'imageURL'),
  };
}

/** `rc.contentBean` as the file tags read it; `rcType` is `rc.type`. */
function contentFileBean(contentBean: CarchStruct, isNew: boolean, rcType: string): FileSelectorBean {
  return {
    entityName: 'content',
    // edit.cfm gives a new version the requested type before the panels render.
    type: isNew && rcType !== '' ? rcType : structText(contentBean, 'type'),
    contentId: structText(contentBean, 'contentID'),
    contentHistId: structText(contentBean, 'contentHistID'),
    siteId: structText(contentBean, 'siteID'),
    userId: '',
    propertyValue: structText(contentBean, 'fileID'),
    fileExt: structText(contentBean, 'fileExt'),
    majorVersion: cfToNumber(structValue(contentBean, 'majorVersion')),
    minorVersion: cfToNumber(structValue(contentBean, 'minorVersion')),
    fileMeta: fileMetaOf(contentBean),
  };
}

/** `rc.lockedBy`, the lock holder's user values, when the edit model carries one. */
function lockOwnerOf(rc: CarchStruct): FileLockOwner {
  if (structValue(rc, 'lockedBy') === undefined) return UNKNOWN_LOCK_OWNER;
  const user = structOf(rc, 'lockedBy');
  return { fname: structText(user, 'fname'), lname: structText(user, 'lname'), email: structText(user, 'email') };
}

/** The image heading with its popover (`rc.ptype` Gallery or `rc.type` not File), else the file heading. */
function heading(rb: RbLookup, imageBranch: boolean): string {
  if (!imageBranch) return `\n\t\t<h2>${rb.rbKey('sitemanager.content.fields.selectfile')}</h2>\n\t`;
  const label = rb.rbKey('sitemanager.content.fields.selectimage');
  return `
   \t\t<label>
\t\t
\t\t<span data-toggle="popover" title="" data-placement="right"
  \tdata-content="${encodeHtmlAttr(rb.rbKey('tooltip.selectimage'))}"
  \tdata-original-title="${encodeHtmlAttr(label)}">
  \t\t${label} <i class="mi-question-circle"></i></span>
\t\t</label>
\t`;
}

/** `#msg-file-locked`, hidden with its unlock link unless the session user holds the file lock. */
function youveLockedNotice(rb: RbLookup, lock: FileLock, indent: string): string {
  const hidden = lock.lockedByYou ? '' : ' style="display:none;"';
  return (
    `\n${indent}<p id="msg-file-locked" class="help-block"${hidden}>` +
    `${rb.rbKey('sitemanager.content.fields.youvelockedfile')} <a class="mura-file-unlock" href="#"${hidden}>` +
    `<i class="mi-unlock"></i> ${rb.rbKey('sitemanager.content.fields.unlockfile')}</a>\n${indent}</p>\n`
  );
}

/** `#msg-file-locked-else`: the holder's name, the release request mail link and, for super and admin users, unlock. */
function lockedElseNotice(rb: RbLookup, req: AdminRequest, owner: FileLockOwner): string {
  const holder = `${encodeHtmlAttr(owner.fname)} ${encodeHtml(owner.lname)}`;
  let out =
    `\n\t\t<p id="msg-file-locked-else" class="help-block">${rb.messageFormat(rb.rbKey('sitemanager.filelockedby'), holder)}.<br>` +
    `\n\t\t<a href="mailto:${encodeHtml(owner.email)}?subject=${encodeHtml(rb.rbKey('sitemanager.fileunlockrequest'))}">` +
    `<i class="mi-envelope"></i> ${rb.rbKey('sitemanager.requestfilerelease')}</a>\n\t\t`;
  if (isSuperOrAdminUser(req)) {
    out += `\n\t\t &nbsp; &nbsp;<a class="mura-file-unlock" href="#"><i class="mi-unlock"></i> ${rb.rbKey('sitemanager.content.fields.unlockfile')}</a>\n\t\t`;
  }
  return `${out}\n\t\t</p>\n`;
}

/** The lock flag and unlock prompt the file scripts read, the preview script and the `unlockfilewithnew` field. */
function scripts(rb: RbLookup, lock: FileLock): string {
  return `
\t<script>
\t\tsiteManager.hasFileLock=${lock.lockedByYou ? 'true' : 'false'};
\t\tsiteManager.unlockfileconfirm="${encodeJs(rb.rbKey('sitemanager.content.fields.unlockfileconfirm'))}";
\t</script>

\t<script type="text/javascript">
\t\t$('#assocImagePreview').click(function(){
\t\t\t$(this).parents().siblings('.bigui__launch').trigger('click');
\t\t})
\t\tfunction updateAssocPreview(){
\t\t\tvar imgsrc = $('#assocImage').attr('src');
\t\t\tif (imgsrc){
\t\t\t\t$('#assocImagePreview').attr('src',imgsrc).show();
\t\t\t}\t\t\t
\t\t}
\t\t// run on load
\t\tupdateAssocPreview();
\t</script>

\t<input type="hidden" id="unlockfilewithnew" name="unlockfilewithnew" value="false" />
</div>
`;
}

/**
 * The include's output, from the newline after `<cfoutput>` through `</div>` and its newline. Every whitespace-only
 * run between two tags follows whitespace output, so ACF whitespace management prints none of them.
 * @throws TypeError When `rc.contentBean`, its `stats` or a value the include reads is missing or of the wrong CFML type.
 */
export async function renderFileSelector(input: EditFormInput): Promise<SafeHtml> {
  const { ctx, req, data, state } = input;
  const { rb } = ctx;
  const rcType = structText(req.rc, 'type');
  const contentBean = structOf(data.rc, 'contentBean');
  const isNew = cfToBoolean(structValue(contentBean, 'isNew'));
  const lock = fileLockOf(structOf(contentBean, 'stats'), req.session.mura.userID);
  const isFile = cfEq(rcType, 'File');
  const imageBranch = cfEq(state.ptype, 'Gallery') || !isFile;
  const bean = contentFileBean(contentBean, isNew, rcType);
  const tagInput = { ctx };

  let out = `\n<div id="assocFileContainer" class="mura-control-group" style="display:none">\n\t${heading(rb, imageBranch)}`;
  if (!isFile) {
    out += '\n\t\t<div id="assocImagePreviewContainer">\n\t\t\t<img id="assocImagePreview" src="" style="display: none;">\n\t\t</div>\n\t';
  }
  if (!lock.lockedBySomeElse) {
    if (isFile && !isNew) out += `${youveLockedNotice(rb, lock, '\t\t\t')}\t\t`;
    const selector = await fileSelector(tagInput, {
      bean,
      name: 'newfile',
      property: 'fileid',
      deleteKey: 'deleteFile',
      compactDisplay: state.compactDisplay,
      locked: lock.locked,
      examplefileext: imageBranch ? 'png' : 'zip',
    });
    // ACF drops CFML comments before whitespace management, so the gaps around the bigui comments join its markup.
    out += isFile
      ? `\n\t\t\t<div id="assocFileSelectorContainer" style="clear:none;float:none;">\t\t\t\n\t\t\t\t${selector.value}\n\t\t\t</div>\n\n\t\t`
      : `\t\n\n\t\t\t\n\t\t\t\n\t\t\t<div class="bigui" id="bigui__associmg" data-label="Select Image">\n\t\t\t\t<div class="bigui__title">${encodeHtmlAttr(rb.rbKey('sitemanager.content.fields.selectimage'))}</div>\n\n\t\t\t\t<div class="bigui__controls">\n\t\t\t\t\t\t${selector.value}\n\t\t\t\t</div>\n\t\t\t</div> \n\n\t\t`;
  } else {
    const tools = await fileTools(tagInput, {
      bean,
      property: 'fileid',
      deleteKey: 'deleteFile',
      compactDisplay: state.compactDisplay,
      locked: lock.locked,
    });
    out += `${youveLockedNotice(rb, lock, '\t\t')}${lockedElseNotice(rb, req, lockOwnerOf(data.rc))}`;
    out += `\n\t\t<div class="mura-file-selector">\n\t\t\t${tools.value}\n\t\t</div>\n\n\t`;
  }
  return raw(out + scripts(rb, lock));
}
