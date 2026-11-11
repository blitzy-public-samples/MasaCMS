// Types shared by the admin shell renderers and `document.ts`, which re-exports them (type-only).

import type { SafeHtml } from '@/lib/html';
import type { AdminRequest } from '@/lib/request-context';
import type { RbLookup } from '@/lib/resource-bundles/rb';

/** Circuits whose secondary menu `dsp_secondary_menu.cfm` includes. */
export type SecondaryMenuCircuit = 'carch' | 'cchangesets' | 'ccategory' | 'cfeed';

/** Circuit fragments the screens inject into the shell. */
export interface ShellHooks {
  readonly secondaryMenus: Partial<Record<SecondaryMenuCircuit, (ctx: AdminRequest) => SafeHtml>>;
  /** `carch/dsp_content_nav.cfm`. */
  readonly contentNav?: (ctx: AdminRequest) => SafeHtml;
}

/** What a screen hands the layout. */
export interface ShellView {
  /** The FW/1 `body` the layout wraps. */
  readonly body: SafeHtml;
  /** Replaces the `template.cfm` 117-206 module title switch. */
  readonly moduleTitle?: string;
  /** `rc.bodyclass` set by the screen; when absent the layout reads `ctx.rc.bodyclass`. */
  readonly bodyclass?: string;
  /** `request.ajax`: the screen's `js.cfm` output. */
  readonly ajax?: SafeHtml;
  /** Accumulated `cfhtmlhead` text, emitted at the end of `<head>`. */
  readonly htmlHead?: SafeHtml;
  /** Overrides `rc.originalcircuit`, which otherwise derives from `ctx.action`. */
  readonly originalCircuit?: string;
  /** Overrides `rc.originalfuseaction`, which otherwise derives from `ctx.action`. */
  readonly originalFuseaction?: string;
  /** OPT-2 module of a synthetic screen (`timesheets`, `finance`, …); marks the OPT-2 nav group active. */
  readonly opt2Module?: string;
}

/** Legacy layout file: `template.cfm` or `compact.cfm` (`default.cfm`). */
export type ShellLayout = 'template' | 'compact';

/** A rendered admin page, split so page mode and raw serialisation can both emit it. */
export interface AdminDocument {
  readonly layout: ShellLayout;
  /** Decoded text of `<title>`. */
  readonly title: string;
  /** `<html>` attributes a non-IE browser sees (`lang`, `class`), in legacy order. */
  readonly htmlAttrs: Record<string, string>;
  /** `<body>` attributes (`id`, `class`), in legacy order. */
  readonly bodyAttrs: Record<string, string>;
  /** `<!DOCTYPE html>` and the legacy `<html>` opener text with its IE conditional comments. */
  readonly preamble: SafeHtml;
  /** Inner markup of `<head>`. */
  readonly head: SafeHtml;
  /** Inner markup of `<body>`. */
  readonly body: SafeHtml;
  /** Send `cache-control: no-cache, no-store, must-revalidate` and the 1994 `expires` (`template.cfm` 207-208). */
  readonly noCache: boolean;
}

/** One row of `settingsManager.getUserSites`. */
export interface ShellSite {
  readonly siteId: string;
  readonly site: string;
  readonly showDashboard: boolean;
}

/** Header prompt badge counts (`header.cfm` 176-246). */
export interface UserPrompts {
  readonly drafts: number;
  readonly submissions: number;
  readonly approvals: number;
  readonly expires: number;
  readonly pendingChangesets: number;
}

/** One nav plugin row (`nav.cfm` 209-222). */
export interface ShellPlugin {
  readonly moduleId: string;
  readonly directory: string;
  readonly name: string;
}

/** Legacy runtime facts of the nav Version menu (`nav.cfm` 384-407). */
export interface LegacyServerInfo {
  readonly appServerProductName: string;
  readonly appServerVersion: string;
  readonly dbProductName: string;
  readonly dbProductVersion: string;
  readonly javaVersion: string;
  readonly osName: string;
  readonly osVersion: string;
}

/** The current user as the header reads it. */
export interface ShellUser {
  readonly fname: string;
  readonly lname: string;
  readonly passwordExpired: boolean;
  /** `isDefined('session.hasdefaultpassword')`. */
  readonly hasDefaultPassword: boolean;
}

/** Data the shell needs beyond `AdminRequest`, loaded before the synchronous render. */
export interface ShellData {
  readonly rb: RbLookup;
  readonly user: ShellUser;
  readonly userSites: ShellSite[];
  readonly prompts: UserPrompts;
  readonly sitePlugins: ShellPlugin[];
  /** Null when no legacy runtime facts are available. */
  readonly server: LegacyServerInfo | null;
  /** `renderCSRFTokens(context='updatecore', format='url')`, or `''`. */
  readonly updateCoreCsrfQuery: string;
  readonly exportLocationExists: boolean;
  readonly now: Date;
}

/** Request, view, hooks and data resolved once and passed to every shell renderer. */
export interface ShellContext {
  readonly ctx: AdminRequest;
  readonly view: ShellView;
  readonly hooks: ShellHooks;
  readonly data: ShellData;
  readonly layout: ShellLayout;
  readonly originalCircuit: string;
  readonly originalFuseaction: string;
  readonly moduleTitle: string;
  readonly bodyclass: string;
  /** `rc.siteid`, else `session.siteID`, else `'default'` (`template.cfm` 109-115). */
  readonly siteId: string;
}
