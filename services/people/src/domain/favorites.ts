// Masa's favorites templates (core/modules/v1/favorites/ajax): a person's `tusersfavorites` save, delete and RSS delete.
import { unescape as unescapeQuery } from 'node:querystring';
import { LegacyServiceUnavailableError, cfIsNumeric, cfUuid, javaTrim, sqlServerDatetime, windows1252Text } from '@opt2/platform/legacy-compat';
import { DEFAULT_UMBRELLA_SITE_ID, type WriteContext } from '@opt2/platform/migration-kit';
import type { Clock } from '@opt2/platform/service-kit';
import { registryEntries, tenantIdForSite, type TenantDb, type TenantRegistryEntry } from '@opt2/platform/tenancy';
import type { ContentClient } from '../legacy/content-client.js';
import type { IdentityClient } from '../legacy/identity-client.js';
import { LegacyStorageError, legacyStorable, type FavoriteInput, type PeopleRepository } from '../repo/repository.js';
import { FAVORITE } from '../repo/tables.js';
import { enPeopleMessages, type PeopleMessages } from './messages.js';
import type { PersonFence } from './person-fence.js';
import { UrlScanError, scanUrlScope } from './url-scan.js';

/** What `deleteFavorite.cfm` answers for any id (deleteFavorite.cfm:79). */
export const FAVORITE_REMOVED = 'Your favorite has been removed.';

/** The exceptions-list entry recording the favorites cases people refuses. */
const FAVORITES_EXCEPTION = 'EX-FAVORITES';
/** `tusersfavorites.favoriteID` is `char(35)`, so a longer id names no row. */
const FAVORITE_ID_LENGTH = 35;
const INT_MIN = -2147483648n;
const INT_MAX = 2147483647n;
/** SQL Server's largest `numeric` precision, the most significant digits a decimal literal may carry. */
const MAX_DECIMAL_PRECISION = 38;
const DECIMAL_PARTS = /^([+-]?)(\d*)(?:\.(\d*))?$/;
const XML_ENTITIES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const JS_STRING_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\\\',
  '"': '\\"',
  "'": "\\'",
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\f': '\\f',
  '\b': '\\b',
};
/** A condition legacy's template fails on, which it answers with the ColdFusion error page. */
export class FavoriteTemplateError extends Error {
  override readonly name: string = 'FavoriteTemplateError';
}

/** Collaborators of the favorites operations; `rb` defaults to the `en` bundle. */
export interface FavoriteDeps {
  db: TenantDb;
  repo: PeopleRepository;
  clock: Clock;
  fence: PersonFence;
  content: Pick<ContentClient, 'contentLinks'>;
  identity: Pick<IdentityClient, 'groupFavoriteIds'>;
  rb?: PeopleMessages;
}

/**
 * The url scope of a request target as the templates read it after the scriptProtect scan their Application.cfc runs: names
 * lower-cased, a repeated name's values joined with `,` in query order; a scan failure fails the template.
 */
export function urlFieldsOf(target: string): Map<string, string> {
  const fields = new Map<string, string>();
  const at = target.indexOf('?');
  const decode = (text: string): string => unescapeQuery(text.replace(/\+/g, ' '));
  for (const pair of at < 0 ? [] : target.slice(at + 1).split('&')) {
    const eq = pair.indexOf('=');
    const name = decode(eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
    const value = eq < 0 ? '' : decode(pair.slice(eq + 1));
    const previous = fields.get(name);
    fields.set(name, previous === undefined ? value : `${previous},${value}`);
  }
  try {
    return scanUrlScope(fields);
  } catch (err) {
    throw err instanceof UrlScanError ? new FavoriteTemplateError(err.message) : err;
  }
}

/** The url field `name` the template reads without a default; legacy errors when it is absent. */
function required(url: ReadonlyMap<string, string>, name: string): string {
  const value = url.get(name);
  if (value === undefined) throw new FavoriteTemplateError(`Element ${name.toUpperCase()} is undefined in URL.`);
  return value;
}

/**
 * The `int` legacy stores for a number field: `favoriteBean` keeps 0 unless the text `isNumeric`, and SQL Server converts
 * the inlined literal, truncating toward zero and failing beyond `int` or a decimal precision of 38 (favoriteBean.cfc:121-144,234-236).
 */
export function storedInteger(raw: string): number {
  if (!cfIsNumeric(raw)) return 0;
  const text = javaTrim(raw);
  let whole: bigint;
  const decimal = DECIMAL_PARTS.exec(text);
  if (decimal === null) {
    // A literal with an exponent is a float, which the int column truncates.
    whole = BigInt(Math.trunc(Number(text)));
  } else {
    const [, sign = '', integer = '', fraction = ''] = decimal;
    if (integer.replace(/^0+/, '').length + fraction.length > MAX_DECIMAL_PRECISION) {
      throw new FavoriteTemplateError(`The number '${text}' is out of the range for numeric representation (maximum precision 38).`);
    }
    whole = BigInt(`${sign === '-' ? '-' : ''}${integer === '' ? '0' : integer}`);
  }
  if (whole < INT_MIN || whole > INT_MAX) throw new FavoriteTemplateError('Arithmetic overflow error converting expression to data type int.');
  return Number(whole);
}

/** ACF `XmlFormat`: the five XML entities, CR dropped and U+00A0-U+00FF as hex character references. */
function cfXmlFormat(text: string): string {
  return text.replace(/[&<>"'\r\u00a0-\u00ff]/g, (ch) => (ch === '\r' ? '' : (XML_ENTITIES[ch] ?? `&#x${ch.charCodeAt(0).toString(16)};`)));
}

/** `mura.json` encode of a simple value (json.cfc:261-266): numeric text raw, other text quoted through ACF `JSStringFormat`. */
function muraJsonText(value: string): string {
  return cfIsNumeric(value) ? value : `"${value.replace(/[\\"'\n\r\t\f\b]/g, (ch) => JS_STRING_ESCAPES[ch] ?? ch)}"`;
}

/** `mura.json` encode of a struct (json.cfc:240-257): lower-cased keys, unescaped, in the given order. */
function muraJsonStruct(members: readonly (readonly [string, string])[]): string {
  return `{${members.map(([key, value]) => `"${key.toLowerCase()}":${muraJsonText(value)}`).join(',')}}`;
}

/** The text `saveFavorite.cfm` answers (saveFavorite.cfm:84-93): the id, its hyphenless `lid` and the removal and content links, in the oracle's key order. */
export function favoriteSavedBody(favoriteId: string, href: string, name: string, removeTitle: string): string {
  const lid = favoriteId.replace(/-/g, '');
  const link =
    `<a href="" onClick="return deleteFavorite('${favoriteId}', 'favorite${lid}');" title="${cfXmlFormat(removeTitle)}" class="remove"></a> ` +
    `<a href='${href}'>${name}</a>`;
  return muraJsonStruct([
    ['lid', lid],
    ['favoriteid', favoriteId],
    ['link', link],
  ]);
}

/** A case whose rows people does not own or cannot place: the legacy-shaped 503 naming its exceptions-list entry. */
function refused(what: string, reason: string): LegacyServiceUnavailableError {
  return new LegacyServiceUnavailableError(`${what} is refused (${FAVORITES_EXCEPTION})`, 'auto', reason);
}

/** The answer when people cannot tell who owns a favorite: a group's favorites are identity's share, an unknown user's no service's. */
function ownerUnknown(userId: string): LegacyServiceUnavailableError {
  return refused(`userID ${userId}, which names no stored person,`, 'favorite-owner-unknown');
}

function siteUnregistered(siteId: string): LegacyServiceUnavailableError {
  return refused(`siteID ${siteId}, which the registry does not hold,`, 'tenant-unregistered');
}

/** SQL Server's varchar equality of site ids: case-insensitive, trailing spaces ignored. */
function sameSite(a: string, b: string): boolean {
  return a.replace(/ +$/, '').toLowerCase() === b.replace(/ +$/, '').toLowerCase();
}

/** The registry entry of site `siteId`, compared as `sameSite`; throws the legacy 503 for an unregistered site. */
function siteEntry(entries: readonly TenantRegistryEntry[], siteId: string): TenantRegistryEntry {
  const entry = entries.find((candidate) => sameSite(candidate.siteId, siteId));
  if (entry === undefined) throw siteUnregistered(siteId);
  return entry;
}

/** The tenant holding person `userId`: the site's user pools first, then every registered tenant; throws the legacy 503 for none. */
async function personTenant(deps: FavoriteDeps, entries: readonly TenantRegistryEntry[], site: TenantRegistryEntry | undefined, userId: string): Promise<string> {
  const registered = new Set(entries.map((entry) => entry.tenantId));
  const preferred = site === undefined ? [] : [site.publicUserPoolTenant, site.privateUserPoolTenant, site.tenantId];
  const candidates = [...new Set([...preferred, ...registered])].filter((tenantId): tenantId is string => tenantId !== null && registered.has(tenantId));
  for (const tenantId of candidates) {
    const found = await deps.fence.withPersonsOpen(
      deps.db,
      tenantId,
      async (tx) => {
        await deps.fence.fencePersons(tx, [userId]);
        return (await deps.repo.findPerson(tx, userId)) !== null;
      },
      { clock: deps.clock },
    );
    if (found) return tenantId;
  }
  throw ownerUnknown(userId);
}

/** The row `favoriteBean.save` inserts, checked against the legacy column limits; a value legacy cannot store fails the template. */
function storableFavorite(row: FavoriteInput): FavoriteInput {
  if (row.userid === '' || row.favorite === '' || row.type === '') {
    throw new FavoriteTemplateError('Cannot insert the value NULL into a NOT NULL column of tusersfavorites.');
  }
  try {
    return legacyStorable(FAVORITE.table, row);
  } catch (err) {
    throw err instanceof LegacyStorageError ? new FavoriteTemplateError(err.message) : err;
  }
}

/**
 * `saveFavorite.cfm` (saveFavorite.cfm:77-93; favoriteManager.cfc:199-231): a new favorite of the person, then its id and
 * removal link as `mura.json` text. A blank `siteid` stores the row under the umbrella tenant before legacy fails reading content.
 */
export async function saveFavorite(deps: FavoriteDeps, url: ReadonlyMap<string, string>, write: WriteContext): Promise<string> {
  const urlSiteId = required(url, 'siteid');
  const [userId, siteId, name, location, type] = ['userid', 'siteid', 'favoritename', 'favoritelocation', 'favoritetype'].map((field) =>
    // The bean's setters trim every text value (bean.cfc:417-438).
    javaTrim(required(url, field)),
  ) as [string, string, string, string, string];
  const favoriteId = cfUuid();
  // Only the stored text is converted; the answer and the content link read the url values.
  const row = storableFavorite({
    favoriteid: favoriteId,
    userid: windows1252Text(userId),
    // `cfqueryparam null` stores an empty text value as NULL (favoriteBean.cfc:228-233).
    favoritename: name === '' ? null : windows1252Text(name),
    favorite: windows1252Text(location),
    type: windows1252Text(type),
    siteid: siteId === '' ? null : windows1252Text(siteId),
    datecreated: sqlServerDatetime(deps.clock.now()),
    columnnumber: storedInteger(url.get('columnnumber') ?? ''),
    rownumber: storedInteger(url.get('rownumber') ?? ''),
    maxrssitems: storedInteger(url.get('maxrssitems') ?? ''),
  });
  const entries = await registryEntries(deps.db);
  // tusersfavorites resolves siteID-or-umbrella, as the migration mapping places its rows.
  const site = siteId === '' ? undefined : siteEntry(entries, siteId);
  const umbrella = tenantIdForSite(DEFAULT_UMBRELLA_SITE_ID);
  if (site === undefined && !entries.some((entry) => entry.tenantId === umbrella)) throw siteUnregistered(DEFAULT_UMBRELLA_SITE_ID);
  const tenantId = site?.tenantId ?? umbrella;
  const ownerTenant = await personTenant(deps, entries, site, userId);
  // The link is read before the write, so an unavailable strategies-content leaves no favorite behind.
  const href = site === undefined ? undefined : (await deps.content.contentLinks(siteId, [location])).get(location);
  if (site !== undefined && href === undefined) {
    throw new LegacyServiceUnavailableError(`strategies-content answered no link for ${location}`, 'auto', 'favorite-link-missing');
  }
  await deps.fence.withPersonsOpen(
    deps.db,
    tenantId,
    async (tx) => {
      if (tenantId === ownerTenant) {
        await deps.fence.fencePersons(tx, [userId]);
        if ((await deps.repo.findPerson(tx, userId)) === null) throw ownerUnknown(userId);
      }
      return deps.repo.insertFavorite(tx, row, write);
    },
    { clock: deps.clock },
  );
  if (href === undefined) throw new FavoriteTemplateError("A 'SITEID' is required in order to read content.");
  const title = (deps.rb ?? enPeopleMessages)(urlSiteId, 'favorites.removefromfavorites');
  return favoriteSavedBody(favoriteId, href, required(url, 'favoritename'), title);
}

/**
 * `deleteFavorite.cfm` (favoriteManager.cfc:233-241; favoriteBean.cfc:198-203): deletes the favorite in whichever people tenant
 * holds it. An id no people tenant holds that names a group's favorite, identity's row, is refused with the legacy 503.
 */
export async function deleteFavorite(deps: FavoriteDeps, url: ReadonlyMap<string, string>, write: WriteContext): Promise<string> {
  const favoriteId = javaTrim(required(url, 'favoriteid'));
  // An empty id makes the bean a new one, which matches no row.
  if (favoriteId === '') return FAVORITE_REMOVED;
  let deleted = 0;
  for (const { tenantId } of await registryEntries(deps.db)) {
    deleted += await deps.fence.withPersonsOpen(
      deps.db,
      tenantId,
      async (tx) => {
        const stored = await deps.repo.lockFavorites(tx, favoriteId);
        if (stored.length === 0) return 0;
        // Row locks precede roster locks.
        await deps.fence.fencePersons(tx, stored.map((favorite) => favorite.userid));
        return deps.repo.deleteFavorites(tx, stored, write);
      },
      { clock: deps.clock },
    );
  }
  if (deleted === 0 && favoriteId.length <= FAVORITE_ID_LENGTH && (await deps.identity.groupFavoriteIds([favoriteId])).length > 0) {
    throw refused(`favoriteID ${favoriteId}, which names a group's favorite,`, 'favorite-owner-group');
  }
  return FAVORITE_REMOVED;
}

/** `deleteRSSFavorite.cfm` (favoriteManager.cfc:243-255): deletes the person's `RSS` favorites of the site, answering no text. */
export async function deleteRssFavorites(deps: FavoriteDeps, url: ReadonlyMap<string, string>, write: WriteContext): Promise<string> {
  const userId = required(url, 'userid');
  const siteId = required(url, 'siteid');
  // No stored favorite has an empty owner or site, so legacy's DELETE matches nothing.
  if (userId === '' || siteId === '') return '';
  const entries = await registryEntries(deps.db);
  const site = siteEntry(entries, siteId);
  const ownerTenant = await personTenant(deps, entries, site, userId);
  await deps.fence.withPersonsOpen(
    deps.db,
    site.tenantId,
    async (tx) => {
      const stored = await deps.repo.lockRssFavorites(tx, userId, siteId);
      if (site.tenantId === ownerTenant) await deps.fence.fencePersons(tx, [userId]);
      return deps.repo.deleteFavorites(tx, stored, write);
    },
    { clock: deps.clock },
  );
  return '';
}
