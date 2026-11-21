// Admin module title switch and `<title>` markup of the legacy layouts (server-only).

import { html, type SafeHtml } from '@/lib/html';

/** Module ids for which `cArch` is titled `Site Content` (`template.cfm` 122). */
export const CONTENT_MODULE_IDS: readonly string[] = Object.freeze([
  '00000000000000000000000000000000000',
  '00000000000000000000000000000000003',
  '00000000000000000000000000000000004',
  '00000000000000000000000000000000099',
]);

/** Request facts the module title switch reads. */
export interface ModuleTitleInput {
  /** `rc.originalcircuit`, e.g. `carch`. */
  readonly originalCircuit: string;
  /** `rc.originalfuseaction`, e.g. `list`. */
  readonly originalFuseaction: string;
  /** `rc.moduleID`. */
  readonly moduleId: string;
  /** `rc.muraAction`, e.g. `core:carch.export`. */
  readonly action: string;
  /** `moduleTitle` set by the screen before the layout runs; empty or absent falls through to the switch. */
  readonly override?: string | undefined;
  /** `rc.bodyclass` as the layout receives it. */
  readonly bodyclass: string;
}

/** Module title and the `rc.bodyclass` the switch leaves behind. */
export interface ModuleTitle {
  readonly moduleTitle: string;
  readonly bodyclass: string;
}

/**
 * Titles of every circuit except `cArch`, keyed by lower-cased circuit (`template.cfm` 139-201); kept verbatim,
 * including the circuits 7.6.1 no longer has (`cPrivateUsers`, `cPublicUsers`, `cPlugin`).
 */
const CIRCUIT_TITLES: ReadonlyMap<string, string> = new Map([
  ['csettings', 'Settings'],
  ['cprivateusers', 'Admin Users'],
  ['cpublicusers', 'Site Members'],
  ['cemail', 'Email Broadcaster'],
  ['clogin', 'Login'],
  ['cmailinglist', 'Mailing Lists'],
  ['cmessage', 'Message'],
  ['ceditprofile', 'Edit Profile'],
  ['cfeed', 'Collections'],
  ['cfilemanager', 'File Manager'],
  ['cdashboard', 'Dashboard'],
  ['ccategory', 'Categories'],
  ['cchain', 'Approval Chains'],
  ['cchangesets', 'Content Staging'],
  ['ccomments', 'Comments'],
  ['cextend', 'Class Extensions'],
  ['cperm', 'Permissions'],
  ['cplugin', 'Plugins'],
  ['cplugins', 'Plugins'],
  ['ctrash', 'Trash Bin'],
  ['cusers', 'Users'],
]);

/** `cArch` branch (`template.cfm` 120-138); CFML `eq` comparisons are case-insensitive. */
function carchTitle(input: ModuleTitleInput): ModuleTitle {
  if (CONTENT_MODULE_IDS.includes(input.moduleId)) return { moduleTitle: 'Site Content', bodyclass: 'sidebar-tab' };
  const action = input.action.toLowerCase();
  let moduleTitle = 'Drafts';
  if (input.originalFuseaction.toLowerCase() === 'imagedetails') moduleTitle = 'Image Details';
  else if (action === 'core:carch.export') moduleTitle = 'Export Content';
  else if (action === 'core:carch.import') moduleTitle = 'Import Content';
  return { moduleTitle, bodyclass: input.bodyclass };
}

/** Module title of `template.cfm` 117-206, which also sets `rc.bodyclass` to `sidebar-tab` for content modules. */
export function resolveModuleTitle(input: ModuleTitleInput): ModuleTitle {
  if (input.override) return { moduleTitle: input.override, bodyclass: input.bodyclass };
  const circuit = input.originalCircuit.toLowerCase();
  if (circuit === 'carch') return carchTitle(input);
  return { moduleTitle: CIRCUIT_TITLES.get(circuit) ?? '', bodyclass: input.bodyclass };
}

/** Decoded `<title>` text of the full layout: `configTitle`, then ` - moduleTitle` when one is set. */
export function templateTitleText(configTitle: string, moduleTitle: string): string {
  return moduleTitle ? `${configTitle} - ${moduleTitle}` : configTitle;
}

/** `<title>` element of `template.cfm` 211, both parts `esapiEncode('html')`. */
export function templateTitleElement(configTitle: string, moduleTitle: string): SafeHtml {
  return html`<title>${configTitle}${moduleTitle ? html` - ${moduleTitle}` : ''}</title>`;
}

/** `<title>` element of `compact.cfm` 105, which carries no module title. */
export function compactTitleElement(configTitle: string): SafeHtml {
  return html`<title>${configTitle}</title>`;
}
