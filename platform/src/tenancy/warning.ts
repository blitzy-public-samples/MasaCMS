import { emitDiagnostic } from '../logging/diagnostics.js';
import { safeErrorMessage } from '../logging/safe-error.js';

const WARNING_CODE = 'OPT2_TENANCY';

/** Returns a handler that emits its first argument as an OPT2_TENANCY diagnostic warning: `prefix` and its safe message. */
export function tenancyWarning(prefix = ''): (err: unknown) => void {
  return (err) => {
    emitDiagnostic(WARNING_CODE, `${prefix}${safeErrorMessage(err)}`, err);
  };
}
