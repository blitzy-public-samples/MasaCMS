import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { components } from '@/generated/clients/strategies-content';
import type { GatewayResponse } from '@/lib/gateway-client';
import { CONTENT_HIST_IDS, CONTENT_IDS } from './carch';

type RawLegacyJson = components['schemas']['RawLegacyJson'];

export const LOADDIFF_BODY_URL = new URL('./loaddiff.html', import.meta.url);
export const DOWNLOADDATA_BODY_URL = new URL('./downloaddata.csv', import.meta.url);

const LOADDIFF_BODY = readFileSync(fileURLToPath(LOADDIFF_BODY_URL), 'utf8');
const DOWNLOADDATA_BODY = readFileSync(fileURLToPath(DOWNLOADDATA_BODY_URL), 'utf8');

export const DOWNLOADDATA_FILENAME = 'Contact-Us-Form_063026.csv';

export const loaddiffRelay = {
  status: 200,
  ok: true,
  headers: { 'content-type': 'text/html;charset=UTF-8' },
  body: LOADDIFF_BODY,
  setCookies: [],
} as const satisfies GatewayResponse<string>;

export const loadsitemanagerRelay = {
  status: 200,
  ok: true,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: String.raw`{"html":"<form novalidate=\"novalidate\" class=\"viewUpdate clearfix\" name=\"viewUpdate\" method=\"post\" action=\"./index.cfm?muraAction=cArch.list&siteid=tenant-a&moduleid=00000000000000000000000000000000000&topid=00000000000000000000000000000000001\">\n\t<div class=\"mura-grid stripe\">\n\t<ul id=\"mura-nodes\">\n\t<li data-contentid=\"00000000000000000000000000000000001\" data-contenthistid=\"${CONTENT_HIST_IDS.home}\" class=\"page mura-node-data\"><dl><dt><a class=\"title\" title=\"Home\">Home</a></dt></dl>\n\t<ul class=\"section\">\n\t<li data-contentid=\"${CONTENT_IDS.aboutUs}\" data-contenthistid=\"${CONTENT_HIST_IDS.aboutUs}\" class=\"page mura-node-data\"><dl><dt><a class=\"title\" title=\"About Us\">About Us</a></dt></dl></li>\n\t<li data-contentid=\"${CONTENT_IDS.news}\" data-contenthistid=\"${CONTENT_HIST_IDS.news}\" class=\"folder mura-node-data\"><dl><dt><a class=\"title\" title=\"News\">News</a></dt></dl></li>\n\t<li data-contentid=\"${CONTENT_IDS.events}\" data-contenthistid=\"${CONTENT_HIST_IDS.events}\" class=\"calendar mura-node-data\"><dl><dt><a class=\"title\" title=\"Events\">Events</a></dt></dl></li>\n\t</ul>\n\t</li>\n\t</ul>\n\t</div>\n</form>","perm":"editor","sortby":"orderno"}`,
  setCookies: [],
} as const satisfies GatewayResponse<string>;

export const loadsitemanagerDecoded = {
  html: `<form novalidate="novalidate" class="viewUpdate clearfix" name="viewUpdate" method="post" action="./index.cfm?muraAction=cArch.list&siteid=tenant-a&moduleid=00000000000000000000000000000000000&topid=00000000000000000000000000000000001">\n\t<div class="mura-grid stripe">\n\t<ul id="mura-nodes">\n\t<li data-contentid="00000000000000000000000000000000001" data-contenthistid="${CONTENT_HIST_IDS.home}" class="page mura-node-data"><dl><dt><a class="title" title="Home">Home</a></dt></dl>\n\t<ul class="section">\n\t<li data-contentid="${CONTENT_IDS.aboutUs}" data-contenthistid="${CONTENT_HIST_IDS.aboutUs}" class="page mura-node-data"><dl><dt><a class="title" title="About Us">About Us</a></dt></dl></li>\n\t<li data-contentid="${CONTENT_IDS.news}" data-contenthistid="${CONTENT_HIST_IDS.news}" class="folder mura-node-data"><dl><dt><a class="title" title="News">News</a></dt></dl></li>\n\t<li data-contentid="${CONTENT_IDS.events}" data-contenthistid="${CONTENT_HIST_IDS.events}" class="calendar mura-node-data"><dl><dt><a class="title" title="Events">Events</a></dt></dl></li>\n\t</ul>\n\t</li>\n\t</ul>\n\t</div>\n</form>`,
  perm: 'editor',
  sortby: 'orderno',
} as const satisfies RawLegacyJson;

export const downloaddataRelay = {
  status: 200,
  ok: true,
  headers: {
    'content-type': 'application/msexcel',
    'content-disposition': 'attachment;filename=Contact-Us-Form_063026.csv',
    expires: '0',
  },
  body: DOWNLOADDATA_BODY,
  setCookies: [],
} as const satisfies GatewayResponse<string>;
