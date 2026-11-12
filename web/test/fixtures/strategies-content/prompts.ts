import type { UserPrompts } from '@/shell/document';

// strategies-content's contract defines no prompt-count schema, so the counts take the shell's UserPrompts type.
export const promptCountsNonZero: UserPrompts = Object.freeze({
  drafts: 3,
  submissions: 2,
  approvals: 1,
  expires: 4,
  pendingChangesets: 2,
});

export const promptCountsZero: UserPrompts = Object.freeze({
  drafts: 0,
  submissions: 0,
  approvals: 0,
  expires: 0,
  pendingChangesets: 0,
});

export const PROMPT_TALLY_NONZERO = 12;
