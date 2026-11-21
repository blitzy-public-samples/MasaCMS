// Target-side write rule keeping Masa's start-up URL conversion predicate empty
// (`type in ('File','Link') and active=1 and body is null and filename is not null`, onApplicationStart_include.cfm:896-899).
import type { ContentRow } from '../repo/tables.js';

/** The `content.content` columns the start-up predicate reads. */
export type StartupPredicateRow = Pick<ContentRow, 'type' | 'active' | 'body' | 'filename'>;

// SQL Server's default collation compares case-insensitively and `=`/`IN` ignore trailing spaces, so 'file ' matches 'File'.
function sqlTypeIn(type: string | null, ...expected: readonly string[]): boolean {
  return type !== null && expected.includes(type.replace(/ +$/u, '').toLowerCase());
}

/** True when Masa's start-up would rewrite this row. */
export function violatesStartupPredicate(row: StartupPredicateRow): boolean {
  return sqlTypeIn(row.type, 'file', 'link') && Number(row.active) === 1 && row.body === null && row.filename !== null;
}

/**
 * Sets `body` to the stored file's original filename for a `File` save with a new upload, as legacy does
 * (CFML `eq`, case-insensitive); any other row is returned unchanged.
 */
export function applyFileBody<T extends StartupPredicateRow>(row: T, uploadedFilename?: string): T {
  if (uploadedFilename === undefined || row.type?.toLowerCase() !== 'file') return row;
  return { ...row, body: uploadedFilename };
}

/** A content version write would leave a row matching the start-up predicate. */
export class StartupPredicateViolationError extends Error {
  override readonly name = 'StartupPredicateViolationError';
  /** `contenthistid` of the offending version. */
  readonly contentHistId: string | null;

  constructor(contentHistId: string | null) {
    super(
      `Content version ${contentHistId ?? '<null>'} would match Masa's start-up URL conversion predicate ` +
        '(File or Link, active, body null, filename set)',
    );
    this.contentHistId = contentHistId;
  }
}

// contenthistid stays nullable as ContentRow declares it, so written rows pass without narrowing.
/** Throws `StartupPredicateViolationError` for the first row matching the predicate; call before commit. */
export function assertStartupSafe(rows: Iterable<StartupPredicateRow & Pick<ContentRow, 'contenthistid'>>): void {
  for (const row of rows) {
    if (violatesStartupPredicate(row)) throw new StartupPredicateViolationError(row.contenthistid);
  }
}
