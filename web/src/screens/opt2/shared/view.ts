// SYNTHETIC: opt2-admin - no Masa equivalent; legacy oracle in legacy-fixtures/
import type { SafeHtml } from '@/lib/html';
import type { ShellView } from '@/shell/document';
import type { Opt2Module } from '../../registry';

/** Shell view of an OPT-2 screen: `body` with `module` marked active in the nav's OPT-2 group. */
export function opt2View(module: Opt2Module, body: SafeHtml): ShellView {
  return { body, opt2Module: module };
}
