import { join, raw, type SafeHtml } from '@/lib/html';

/** Validation messages keyed by field, in the struct iteration order strategies-content reports. */
export type DisplayErrors = Readonly<Record<string, string>> | ReadonlyArray<readonly [string, string]>;

function isEntryList(errors: DisplayErrors): errors is ReadonlyArray<readonly [string, string]> {
  return Array.isArray(errors);
}

/** `utility.displayErrors`: the inner markup of the content edit `.alert-error` span. */
export function displayErrors(errors: DisplayErrors): SafeHtml {
  const entries = isEntryList(errors) ? errors : Object.entries(errors);
  const parts: SafeHtml[] = [];
  entries.forEach(([key, message], index) => {
    if (key.toLowerCase() === 'siteid') return;
    // Unencoded as legacy emits it (messages may carry resource-bundle markup). The `<br>` test counts every key,
    // `siteID` included, so a trailing `siteID` leaves a `<br>` after the last message. The single spaces are the
    // tag-body whitespace as ACF whitespace management emits it, observed on the legacy server.
    parts.push(raw(`${message} ${entries.length > index + 1 ? '<br> ' : ''}`));
  });
  return join(parts);
}
