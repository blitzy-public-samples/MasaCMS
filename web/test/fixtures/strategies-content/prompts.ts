import type { components } from '@/generated/clients/strategies-content';

type HeaderPrompts = components['schemas']['HeaderPrompts'];

// strategies-content `getHeaderPrompts` bodies, which the shell takes as its UserPrompts.
export const promptCountsNonZero: HeaderPrompts = Object.freeze({
  drafts: 3,
  submissions: 2,
  approvals: 1,
  expires: 4,
  pendingChangesets: 2,
});

export const promptCountsZero: HeaderPrompts = Object.freeze({
  drafts: 0,
  submissions: 0,
  approvals: 0,
  expires: 0,
  pendingChangesets: 0,
});

export const PROMPT_TALLY_NONZERO = 12;
