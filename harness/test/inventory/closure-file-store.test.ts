import { describe, expect, it } from 'vitest';
import { computeClosure, memorySourceTree, parseCfmlComponent } from '../../src/inventory/closure.js';
import type { CfmlComponent, ComponentIndex, FileStoreEvidence } from '../../src/inventory/closure.js';

const FILE_MANAGER = 'core/mura/content/file/fileManager.cfc';
const IMAGE_PROCESSOR = 'core/mura/content/file/imageProcessor.cfc';
const WRITER = 'core/mura/writer.cfc';

/** Excerpts modelled on fileManager.cfc, processImgCfimage.cfc and fileWriter.cfc. */
const FILES: Readonly<Record<string, string>> = {
  [FILE_MANAGER]: `<cfcomponent extends="mura.cfobject" output="false">
<cffunction name="crop" output="false">
	<cfargument name="fileID">
	<cfargument name="siteID">
	<cfset var file="">
	<cfset var file="#application.configBean.getFileDir()#/#arguments.siteID#/cache/file/#arguments.fileID#.jpg">
	<cfif fileExists(file)>
		<cfset fileDelete(file)>
	</cfif>
	<cfset imageWrite(imageRead(file), file, 0.9)>
	<cfset getBean('imageProcessor').resize(image=file)>
</cffunction>
<cffunction name="upload" output="false">
	<cffile action="upload" filefield="newFile" destination="#variables.configBean.getTempDir()#" nameconflict="makeunique">
	<cffile action="delete" file="#variables.configBean.getTempDir()##cffile.serverFile#">
	<cfset getBean('imageProcessor').resize(image=cffile.serverDirectory & "/" & cffile.serverFile)>
</cffunction>
<cffunction name="clean" output="false">
	<cfargument name="siteID">
	<cfset var filePath="#application.configBean.getFileDir()#/#arguments.siteID#/cache/file/">
	<cfloop query="rs"><cffile action="delete" file="#filePath##rs.name#"></cfloop>
	<cfdirectory action="rename" directory="#filePath#old" newDirectory="#filePath#new">
	<cfzip action="unzip" file="#arguments.zipFile#" destination="#filePath#">
	<cffile action="move" source="#getTempDirectory()#x.jpg" destination="#filePath#x.jpg">
	<cffile action="read" file="#filePath#x.jpg" variable="local.text">
</cffunction>
<cffunction name="assets" output="false">
	<cffile action="rename" source="#$.siteConfig().getAssetDir()#/a.txt" destination="#$.siteConfig().getAssetDir()#/b.txt">
</cffunction>
<cffunction name="defaulted" output="false">
	<cfargument name="toDir" default="#application.configBean.getAssetDir()#">
	<cfset fileWrite(arguments.toDir & "/x.txt", "x")>
</cffunction>
<cffunction name="getCustom" output="false">
	<cfargument name="image">
	<cfreturn getBean('imageProcessor').custom(argumentCollection=arguments)>
</cffunction>
<cffunction name="href" output="false">
	<cfargument name="siteID">
	<cfreturn getCustom(image="#application.configBean.getFileDir()#/#arguments.siteID#/cache/file/x.jpg")>
</cffunction>
<cffunction name="tempHref" output="false">
	<cfreturn getCustom(image="#getTempDirectory()#x.jpg")>
</cffunction>
<cffunction name="getCustomImage" output="false">
	<cfargument name="image">
	<cfreturn getBean('imageProcessor').custom(argumentCollection=arguments)>
</cffunction>
<cffunction name="createHREFForImage" output="false">
	<cfargument name="siteID">
	<cfreturn getCustomImage(image="#application.configBean.getFileDir()#/#arguments.siteID#/cache/file/x.jpg")>
</cffunction>
</cfcomponent>
`,
  [IMAGE_PROCESSOR]: `<cfcomponent output="false">
<cffunction name="resize" output="false">
	<cfargument name="image">
	<cfset imageWrite(imageRead(arguments.image), arguments.image)>
</cffunction>
<cffunction name="custom" output="false">
	<cfargument name="image">
	<cfset var original = trim(arguments.image)>
	<cfset var target = replace(original, ".jpg", "_small.jpg")>
	<cfset getBean('writer').copy(source=original, destination=target)>
</cffunction>
</cfcomponent>
`,
  [WRITER]: `component output="false" {
	public function copy(required string source, required string destination) {
		fileCopy(arguments.source, arguments.destination);
	}
}
`,
};

const BEANS: Readonly<Record<string, string>> = { imageprocessor: IMAGE_PROCESSOR, writer: WRITER };
const tree = memorySourceTree(FILES);
const parsed = new Map<string, CfmlComponent | null>();
const index: ComponentIndex = {
  resolveBean: (name) => BEANS[name.toLowerCase()] ?? null,
  ormTable: () => null,
  parsed(p) {
    if (!parsed.has(p)) parsed.set(p, tree.exists(p) ? parseCfmlComponent(p, tree.readText(p)) : null);
    return parsed.get(p) ?? null;
  },
};

function lineWith(rel: string, needle: string): number {
  const at = tree.readText(rel).split('\n').findIndex((l) => l.includes(needle));
  if (at < 0) throw new Error(`${rel} has no line containing ${needle}`);
  return at + 1;
}

type Row = [method: string, op: FileStoreEvidence['op'], at: string, conditional: boolean];

/** File-store evidence of a fileManager entry, by source path, line and method. */
function evidenceOf(method: string): Row[] {
  return [...computeClosure({ component: FILE_MANAGER, method }, { tree, index }).fileStoreEvidence]
    .sort((a, b) => a.source.path.localeCompare(b.source.path) || a.source.lines[0] - b.source.lines[0] || a.method.localeCompare(b.method))
    .map((e): Row => [e.method, e.op, `${e.source.path}:${e.source.lines[0]}`, e.conditional]);
}

const at = (rel: string, needle: string): string => `${rel}:${lineWith(rel, needle)}`;

describe('computeClosure file-store operations', () => {
  it.each<[string, string, Row[]]>([
    [
      'builtins on a local built on fileDir, and a callee given that path',
      'crop',
      [
        ['fileDelete(file)', 'delete', at(FILE_MANAGER, 'fileDelete(file)'), true],
        ['imageWrite(destination)', 'write', at(FILE_MANAGER, 'imageWrite(imageRead(file)'), false],
        ['imageWrite(destination)', 'write', at(IMAGE_PROCESSOR, 'imageWrite(imageRead(arguments.image)'), false],
      ],
    ],
    ['temp-directory uploads and their upload results', 'upload', []],
    [
      'tags on a fileDir local, in a loop, with a temp source left out and a read ignored',
      'clean',
      [
        ['cffile:delete(file)', 'delete', at(FILE_MANAGER, '<cfloop query="rs">'), false],
        ['cfdirectory:rename(directory)', 'delete', at(FILE_MANAGER, '<cfdirectory action="rename"'), false],
        ['cfdirectory:rename(newdirectory)', 'write', at(FILE_MANAGER, '<cfdirectory action="rename"'), false],
        ['cfzip:unzip(destination)', 'write', at(FILE_MANAGER, '<cfzip action="unzip"'), false],
        ['cffile:move(destination)', 'write', at(FILE_MANAGER, '<cffile action="move"'), false],
      ],
    ],
    [
      'a rename within the site asset directory',
      'assets',
      [
        ['cffile:rename(destination)', 'write', at(FILE_MANAGER, '<cffile action="rename"'), false],
        ['cffile:rename(source)', 'delete', at(FILE_MANAGER, '<cffile action="rename"'), false],
      ],
    ],
    ['a formal declared with an assetDir default', 'defaulted', [['fileWrite(file)', 'write', at(FILE_MANAGER, 'fileWrite(arguments.toDir'), false]]],
    [
      'a fileDir path passed through argumentCollection and locals into a writer',
      'href',
      [['fileCopy(destination)', 'write', at(WRITER, 'fileCopy('), false]],
    ],
    ['a temp path passed the same way', 'tempHref', []],
    ['nothing for a custom-size rendition, a cache getCustomImage rebuilds', 'createHREFForImage', []],
  ])('records %s (%s)', (_name, method, rows) => {
    expect(evidenceOf(method)).toEqual(rows);
  });

  it('cites the function holding the operation as the end of its call path', () => {
    const e = computeClosure({ component: FILE_MANAGER, method: 'href' }, { tree, index }).fileStoreEvidence;
    expect(e).toEqual([
      {
        component: WRITER,
        method: 'fileCopy(destination)',
        source: { path: WRITER, lines: [lineWith(WRITER, 'fileCopy('), lineWith(WRITER, 'fileCopy(')] },
        conditional: false,
        via: ['fileManager.href', 'fileManager.getCustom', 'imageProcessor.custom', 'writer.copy'],
        op: 'write',
      },
    ]);
  });
});
