/** A roster write-protocol step boundary at which a fault can be injected. */
export type RosterStep =
  | 'after-start'
  | 'after-prepare'
  | 'after-people-commit'
  | 'after-identity-commit'
  | 'after-done';

/** Every roster step boundary, in protocol order. */
export const ROSTER_STEPS: readonly RosterStep[] = [
  'after-start',
  'after-prepare',
  'after-people-commit',
  'after-identity-commit',
  'after-done',
];

/** Environment variable that names the step at which the process kills itself. */
export const FAULT_ENV = 'OPT2_FAULT';

/** Prefix of roster fault values in `OPT2_FAULT`, followed by a `RosterStep`. */
export const FAULT_PREFIX = 'roster:';

/** Hooks the roster protocol awaits at each step boundary. */
export interface FaultHooks {
  at(step: RosterStep): Promise<void>;
}

/** Errors to throw at given steps; a factory yields a fresh error on every throw. */
export type InjectedFaults = Partial<Record<RosterStep, Error | (() => Error)>>;

/** Hooks that resolve immediately at every step. */
export const NO_FAULTS: FaultHooks = {
  at: () => Promise.resolve(),
};

const STEP_SET: ReadonlySet<string> = new Set<string>(ROSTER_STEPS);

/** Whether `value` names a roster step. */
export function isRosterStep(value: string): value is RosterStep {
  return STEP_SET.has(value);
}

// Values without the roster prefix or with an unknown step belong to other packages' fault names and are ignored.
function killStepFrom(value: string | undefined): RosterStep | undefined {
  if (value === undefined || !value.startsWith(FAULT_PREFIX)) return undefined;
  const step = value.slice(FAULT_PREFIX.length);
  return isRosterStep(step) ? step : undefined;
}

/** Builds hooks that SIGKILL the process at the `OPT2_FAULT=roster:<step>` step, else throw that step's injected error. */
export function createFaultHooks(injected: InjectedFaults = {}, env: NodeJS.ProcessEnv = process.env): FaultHooks {
  const killStep = killStepFrom(env[FAULT_ENV]);
  return {
    async at(step: RosterStep): Promise<void> {
      if (step === killStep) {
        process.kill(process.pid, 'SIGKILL');
        // Abrupt process loss: the caller must never continue past this boundary, even before the signal lands.
        await new Promise<never>(() => undefined);
      }
      const fault = injected[step];
      if (fault !== undefined) throw typeof fault === 'function' ? fault() : fault;
    },
  };
}
