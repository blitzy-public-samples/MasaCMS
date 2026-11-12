// The resource-bundle messages of people's validation, resolved per site as Masa's site rbFactory resolves them.

/** Resource-bundle keys of the people validation messages. */
export type PeopleMessageKey =
  | 'params.errordate'
  | 'params.erroremail'
  | 'params.errornumeric'
  | 'user.emailrequired'
  | 'captcha.error'
  | 'captcha.spam'
  | 'sitemanager.requesthasrestrictedfiles';

/**
 * The text of `key` in the resource bundle of `siteId`, as `getSite(siteId).getRBFactory().getKey(key)`: a blank or
 * unknown site reads the `default` site, and a key missing from the site locale reads its fallback.
 */
export type PeopleMessages = (siteId: string, key: PeopleMessageKey) => string;

/**
 * The `en` texts [legacy: core/mura/resourceBundle/resources/en.properties:829-831,1608,1744;
 * core/modules/v1/core_assets/resource_bundles/en.properties:31,35].
 */
export const EN_PEOPLE_MESSAGES: Readonly<Record<PeopleMessageKey, string>> = Object.freeze({
  'params.errordate': '{1} must be a valid date.',
  'params.erroremail': '{1} must be a valid email.',
  'params.errornumeric': '{1} must be numeric.',
  'user.emailrequired': "The 'Email Address' field is required.",
  'captcha.error': "The 'Security Code' entered was not correct.",
  'captcha.spam': 'This submission has been marked as spam.',
  'sitemanager.requesthasrestrictedfiles': 'The posted request contained restricted file types',
});

/** The `en` text of `key` for every site, the validators' default. */
export const enPeopleMessages: PeopleMessages = (_siteId, key) => EN_PEOPLE_MESSAGES[key];
