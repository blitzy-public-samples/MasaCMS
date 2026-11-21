// SYNTHETIC: reporting - no Masa equivalent; legacy oracle in legacy-fixtures/
/** Export-job state machine: the transition table, `transitionJob` against stored rows as `usp_export_job_transition` moves them, and failed jobs through the runner, on the in-memory database. */
import { describe, expect, it } from 'vitest';
import { EXPORT_ERRORS, JOB_STATES, JOB_TRANSITIONS, isLegalTransition } from '../../src/domain/job-state.js';
import { LEGAL_EDGES, STATE_PAIRS, defineJobStateCases } from '../helpers/job-state-cases.js';

describe('export job transition table', () => {
  it('names the fixture states in lifecycle order and its two failure errors', () => {
    expect(JOB_STATES).toStrictEqual(['queued', 'running', 'done', 'failed']);
    expect(EXPORT_ERRORS).toStrictEqual(['source-unavailable', 'export-failed']);
  });

  it('declares exactly the three legal moves of usp_export_job_transition', () => {
    const declared = Object.entries(JOB_TRANSITIONS).flatMap(([from, targets]) => targets.map((to) => [from, to]));

    expect(declared).toStrictEqual(LEGAL_EDGES);
  });

  it.each(STATE_PAIRS)('answers $legal for $from → $to', ({ from, to, legal }) => {
    expect(isLegalTransition(from, to)).toBe(legal);
  });
});

defineJobStateCases('recording');
