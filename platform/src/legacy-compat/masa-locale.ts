// Masa's mapping of a site or configured locale to the name it passes setLocale (resourceBundleFactory.cfc:157-643).
import { javaEqualsIgnoreCase } from './java-date-format.js';
import { javaTrim } from './serializer.js';

/** ACF's default request locale, which getLocale() returns before any setLocale. */
const SERVER_LOCALE = 'English (US)';

/** CF2Java's cases (matched in any case) and the names they return, in its order. */
const CF_TO_JAVA: ReadonlyArray<readonly [cfLocale: string, javaLocale: string]> = [
  ['dutch (belgian)', 'nl_BE'], ['dutch (standard)', 'nl_NL'], ['english (australian)', 'en_AU'],
  ['english (canadian)', 'en_CA'], ['english (uk)', 'en_GB'], ['english (new zealand)', 'en_NZ'],
  ['english (us)', 'en_US'], ['french (belgian)', 'fr_BE'], ['french (canadian)', 'fr_CA'],
  ['french (standard)', 'fr_FR'], ['french (swiss)', 'fr_CH'], ['german (austrian)', 'de_AT'],
  ['german (standard)', 'de_DE'], ['german (swiss)', 'de_CH'], ['italian (standard)', 'it_IT'],
  ['italian (swiss)', 'it_CH'], ['norwegian (bokmal)', 'no_NO'], ['norwegian (nynorsk)', 'no_NO'],
  ['portuguese (brazilian)', 'pt_BR'], ['portuguese (standard)', 'pt_PT'], ['spanish (mexican)', 'es_MX'],
  ['spanish (modern)', 'es_ES'], ['spanish (united states)', 'es_US'], ['spanish (standard)', 'es_ES'],
  ['swedish', 'sv_SE'], ['japanese', 'ja_JP'], ['korean', 'ko_KR'], ['chinese (china)', 'zh_CN'],
  ['chinese (hong kong)', 'zh_HK'], ['chinese (taiwan)', 'zh_TW'], ['arabic', 'ar'],
  ['arabic (united arab emirates)', 'ar'], ['arabic (bahrain)', 'ar'], ['arabic (algeria)', 'ar'],
  ['arabic (egypt)', 'ar'], ['arabic (iraq)', 'ar'], ['arabic (jordan)', 'ar'], ['arabic (kuwait)', 'ar'],
  ['arabic (lebanon)', 'ar'], ['arabic (libya)', 'ar'], ['arabic (morocco)', 'ar'], ['arabic (oman)', 'ar'],
  ['arabic (qatar)', 'ar'], ['arabic (saudi arabia)', 'ar'], ['arabic (sudan)', 'ar'], ['arabic (syria)', 'ar'],
  ['arabic (tunisia)', 'ar'], ['arabic (yemen)', 'ar'], ['hindi (india)', 'hi_IN'], ['hebrew', 'iw_IL'],
  ['hebrew (israel)', 'iw_IL'], ['japanese (japan)', 'ja_JP'], ['korean (south korea)', 'ko_KY'], ['thai', 'vi_VN'],
  ['thai (thailand)', 'vi_VN'], ['vietnamese', 'vi_VN'], ['vietnamese (vietnam)', 'vi_VN'], ['chinese', 'ch_CN'],
  ['belarusian', 'be_BY'], ['belarusian (belarus)', 'be_BY'], ['bulgarian', 'bg_BG'], ['bulgarian (bulgaria)', 'bg_BG'],
  ['catalan', 'ca_ES'], ['catalan (spain)', 'ca_ES'], ['czech', 'cs_CZ'], ['czech (czech republic)', 'cs_CZ'],
  ['danish', 'da_DK'], ['danish (denmark)', 'da_DK'], ['german', 'de_DE'], ['german (austria)', 'de_AT'],
  ['german (switzerland)', 'de_CH'], ['german (germany)', 'de_DE'], ['german (luxembourg)', 'de_LU'],
  ['greek', 'el_GR'], ['greek (greece)', 'el_GR'], ['english (australia)', 'en_AU'], ['english (canada)', 'en_CA'],
  ['english (united kingdom)', 'en_GB'], ['english (ireland)', 'en_IE'], ['english (india)', 'en_IN'],
  ['english (south africa)', 'en_ZA'], ['spanish', 'es_ES'], ['spanish (argentina)', 'es_BO'],
  ['spanish (bolivia)', 'es_UY'], ['spanish (chile)', 'es_CL'], ['spanish (colombia)', 'es_CO'],
  ['spanish (costa rica)', 'es_CR'], ['spanish (dominican republic)', 'es_DO'], ['spanish (ecuador)', 'es_EC'],
  ['spanish (spain)', 'es_ES'], ['spanish (guatemala)', 'es_GT'], ['spanish (honduras)', 'es_HN'],
  ['spanish (mexico)', 'es_MX'], ['spanish (nicaragua)', 'es_NI'], ['spanish (panama)', 'es_PA'],
  ['spanish (peru)', 'es_PE'], ['spanish (puerto rico)', 'es_PR'], ['spanish (paraguay)', 'es_PY'],
  ['spanish (el salvador)', 'es_SV'], ['spanish (uruguay)', 'es_UY'], ['spanish (venezuela)', 'es_VE'],
  ['estonian', 'et_EE'], ['estonian (estonia)', 'et_EE'], ['finnish', 'fi_FI'], ['finnish (finland)', 'fi_FI'],
  ['french', 'fr_FR'], ['french (belgium)', 'fr_BE'], ['french (canada)', 'fr_CA'], ['french (switzerland)', 'fr_CH'],
  ['french (france)', 'fr_FR'], ['french (luxembourg)', 'fr_LU'], ['croatian', 'hr_HR'],
  ['croatian (croatia)', 'hr_HR'], ['hungarian', 'hu_HU'], ['hungarian (hungary)', 'hu_HU'], ['icelandic', 'is_IS'],
  ['icelandic (iceland)', 'is_IS'], ['italian', 'it_IT'], ['italian (switzerland)', 'it_CH'],
  ['italian (italy)', 'it_IT'], ['lithuanian', 'lt_LT'], ['lithuanian (lithuania)', 'lt_LT'], ['latvian', 'lv_LV'],
  ['latvian (latvia)', 'lv_LV'], ['macedonian', 'mk_MK'], ['macedonian (macedonia)', 'mk_MK'], ['dutch', 'nl_NL'],
  ['dutch (belgium)', 'nl_BE'], ['dutch (netherlands)', 'nl_NL'], ['norwegian', 'no_NO'],
  ['norwegian (norway)', 'no_NO'], ['polish', 'pl_PL'], ['polish (poland)', 'pl_PL'], ['portuguese', 'pt_PT'],
  ['portuguese (brazil)', 'pt_BR'], ['portuguese (portugal)', 'pt_PT'], ['romanian', 'ro_RO'],
  ['romanian (romania)', 'ro_RO'], ['russian', 'ru_RU'], ['russian (russia)', 'ru_RU'], ['slovak', 'sk_SK'],
  ['slovak (slovakia)', 'sk_SK'], ['slovenian', 'sl_SI'], ['slovenian (slovenia)', 'sl_SI'], ['albanian', 'sq_AL'],
  ['albanian (albania)', 'sq_AL'], ['serbian', 'sh_YU'], ['serbian (bosnia and herzegovina)', 'sh_YU'],
  ['serbian (serbia and montenegro)', 'sh_YU'], ['swedish (sweden)', 'sv_SE'], ['swiss german (switzerland)', 'de_CH'],
  ['turkish', 'tr_TR'], ['turkish (turkey)', 'tr_TR'], ['ukrainian', 'uk_UA'], ['ukrainian (ukraine)', 'uk_UA'],
  ['english (united states)', 'en_US'], ['english', 'en_US'],
];

/**
 * resourceBundleFactory.CF2Java in a request at ACF's default locale: the trimmed value mapped by its cases, 'Server'
 * and '' read as English (US), anything else unchanged (setLocale then refuses an unsupported name).
 */
export function masaCf2Java(cfLocale: string): string {
  const trimmed = javaTrim(cfLocale);
  const value = javaEqualsIgnoreCase(trimmed, 'Server') ? SERVER_LOCALE : trimmed;
  const mapped = CF_TO_JAVA.find(([name]) => javaEqualsIgnoreCase(value, name));
  if (mapped !== undefined) return mapped[1];
  return value === '' ? SERVER_LOCALE : value;
}
