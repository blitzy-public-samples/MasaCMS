// Generated LSParseDateTime data of every ACF 2023 setLocale name, captured from ACF 2023.0.26 on Java 17.0.21.

/** A name a text field matches, with the Calendar value it sets. */
export type DateName = readonly [name: string, value: number];

/** A zone name, the offset in ms east of UTC it parses as, and the longer zone names that start with it. */
export type FixedZone = readonly [name: string, offset: number, longer: readonly string[]];

/** What the formatters CFLocaleBase builds for one setLocale name parse with. */
export interface AcfDateLocale {
  /** Java SHORT, MEDIUM, LONG and FULL date-time patterns, then date patterns, then time patterns. */
  readonly patterns: readonly string[];
  /** Era, month (0-11), long and short weekday (1-7) and am/pm names, longest first. */
  readonly eras: readonly DateName[];
  readonly months: readonly DateName[];
  readonly weekdays: readonly DateName[];
  readonly shortWeekdays: readonly DateName[];
  readonly amPm: readonly DateName[];
  /** DecimalFormat's minus sign (its negative prefix), NaN, infinity and exponent separator. */
  readonly minus: string;
  readonly nan: string;
  readonly infinity: string;
  readonly exponent: string;
  /** 543 where a BuddhistCalendar numbers the years, else 0. */
  readonly yearOffset: number;
  /** Whether its time-zone names are en_US's (java-zone-names.ts). */
  readonly enZoneNames: boolean;
  /** Its era, month, weekday and am/pm names that no time-zone name of the locale starts with or is a prefix of. */
  readonly zoneSafeNames: readonly string[];
  /** Zone names every zone holding them parses at one offset, which no shorter zone name prefixes. */
  readonly fixedZones: readonly FixedZone[];
}

/** Date-time patterns, SHORT to FULL. */
const DATE_TIME_PATTERNS: ReadonlyArray<readonly string[]> = [
  [
    'y-MM-dd HH:mm', 'y MMM d HH:mm:ss', 'y MMMM d HH:mm:ss z', 'y MMMM d, EEEE HH:mm:ss zzzz',
  ],
  [
    'y/M/d ah:mm', 'y年M月d日 ah:mm:ss', 'y年M月d日 z ah:mm:ss', 'y年M月d日EEEE zzzz ah:mm:ss',
  ],
  [
    'd/M/y ah:mm', 'y年M月d日 ah:mm:ss', 'y年M月d日 ah:mm:ss [z]', 'y年M月d日EEEE ah:mm:ss [zzzz]',
  ],
  [
    'y/M/d ah:mm', 'y年M月d日 ah:mm:ss', 'y年M月d日 ah:mm:ss [z]', 'y年M月d日 EEEE ah:mm:ss [zzzz]',
  ],
  [
    'd/MM/y HH:mm', 'd MMM y HH:mm:ss', 'd MMMM y \'om\' HH:mm:ss z', 'EEEE d MMMM y \'om\' HH:mm:ss zzzz',
  ],
  [
    'dd-MM-y HH:mm', 'd MMM y HH:mm:ss', 'd MMMM y \'om\' HH:mm:ss z', 'EEEE d MMMM y \'om\' HH:mm:ss zzzz',
  ],
  [
    'd/M/yy, h:mm a', 'd MMM y, h:mm:ss a', 'd MMMM y \'at\' h:mm:ss a z', 'EEEE, d MMMM y \'at\' h:mm:ss a zzzz',
  ],
  [
    'y-MM-dd, h:mm a', 'MMM d, y, h:mm:ss a', 'MMMM d, y \'at\' h:mm:ss a z', 'EEEE, MMMM d, y \'at\' h:mm:ss a zzzz',
  ],
  [
    'd/MM/yy, h:mm a', 'd/MM/y, h:mm:ss a', 'd MMMM y \'at\' h:mm:ss a z', 'EEEE, d MMMM y \'at\' h:mm:ss a zzzz',
  ],
  [
    'dd/MM/y, HH:mm', 'd MMM y, HH:mm:ss', 'd MMMM y \'at\' HH:mm:ss z', 'EEEE, d MMMM y \'at\' HH:mm:ss zzzz',
  ],
  [
    'M/d/yy, h:mm a', 'MMM d, y, h:mm:ss a', 'MMMM d, y \'at\' h:mm:ss a z', 'EEEE, MMMM d, y \'at\' h:mm:ss a zzzz',
  ],
  [
    'd/MM/yy HH:mm', 'd MMM y, HH:mm:ss', 'd MMMM y \'à\' HH:mm:ss z',
    'EEEE d MMMM y \'à\' H \'h\' mm \'min\' ss \'s\' zzzz',
  ],
  [
    'y-MM-dd HH \'h\' mm', 'd MMM y, HH \'h\' mm \'min\' ss \'s\'', 'd MMMM y \'à\' HH \'h\' mm \'min\' ss \'s\' z',
    'EEEE d MMMM y \'à\' HH \'h\' mm \'min\' ss \'s\' zzzz',
  ],
  [
    'dd/MM/y HH:mm', 'd MMM y, HH:mm:ss', 'd MMMM y \'à\' HH:mm:ss z', 'EEEE d MMMM y \'à\' HH:mm:ss zzzz',
  ],
  [
    'dd.MM.yy HH:mm', 'd MMM y, HH:mm:ss', 'd MMMM y \'à\' HH:mm:ss z', 'EEEE, d MMMM y \'à\' HH.mm:ss \'h\' zzzz',
  ],
  [
    'dd.MM.yy, HH:mm', 'dd.MM.y, HH:mm:ss', 'd. MMMM y \'um\' HH:mm:ss z', 'EEEE, d. MMMM y \'um\' HH:mm:ss zzzz',
  ],
  [
    'dd/MM/yy, HH:mm', 'd MMM y, HH:mm:ss', 'd MMMM y HH:mm:ss z', 'EEEE d MMMM y HH:mm:ss zzzz',
  ],
  [
    'dd.MM.yy, HH:mm', 'd MMM y, HH:mm:ss', 'd MMMM y HH:mm:ss z', 'EEEE, d MMMM y HH:mm:ss zzzz',
  ],
  [
    'y/MM/dd H:mm', 'y/MM/dd H:mm:ss', 'y年M月d日 H:mm:ss z', 'y年M月d日EEEE H時mm分ss秒 zzzz',
  ],
  [
    'yy. M. d. a h:mm', 'y. M. d. a h:mm:ss', 'y년 M월 d일 a h시 m분 s초 z', 'y년 M월 d일 EEEE a h시 m분 s초 zzzz',
  ],
  [
    'dd.MM.y, HH:mm', 'd. MMM y, HH:mm:ss', 'd. MMMM y \'kl\'. HH:mm:ss z', 'EEEE d. MMMM y \'kl\'. HH:mm:ss zzzz',
  ],
  [
    'dd/MM/y HH:mm', 'd \'de\' MMM \'de\' y HH:mm:ss', 'd \'de\' MMMM \'de\' y HH:mm:ss z',
    'EEEE, d \'de\' MMMM \'de\' y HH:mm:ss zzzz',
  ],
  [
    'dd/MM/yy, HH:mm', 'dd/MM/y, HH:mm:ss', 'd \'de\' MMMM \'de\' y \'às\' HH:mm:ss z',
    'EEEE, d \'de\' MMMM \'de\' y \'às\' HH:mm:ss zzzz',
  ],
  [
    'dd/MM/yy HH:mm', 'd MMM y HH:mm:ss', 'd \'de\' MMMM \'de\' y, HH:mm:ss z',
    'EEEE, d \'de\' MMMM \'de\' y, HH:mm:ss zzzz',
  ],
  [
    'd/M/yy H:mm', 'd MMM y H:mm:ss', 'd \'de\' MMMM \'de\' y, H:mm:ss z',
    'EEEE, d \'de\' MMMM \'de\' y, H:mm:ss (zzzz)',
  ],
  [
    'y-MM-dd HH:mm', 'd MMM y HH:mm:ss', 'd MMMM y HH:mm:ss z', 'EEEE d MMMM y HH:mm:ss zzzz',
  ],
  [
    'y-MM-dd HH:mm', 'dd MMM y HH:mm:ss', 'dd MMMM y HH:mm:ss z', 'EEEE dd MMMM y HH:mm:ss zzzz',
  ],
  [
    'y-MM-dd h:mm a', 'dd MMM y h:mm:ss a', 'dd MMMM y h:mm:ss a z', 'EEEE dd MMMM y h:mm:ss a zzzz',
  ],
  [
    'd/M/y HH:mm', 'd MMM, y HH:mm:ss', 'd MMMM y HH:mm:ss z', 'EEEE d MMMM y HH:mm:ss zzzz',
  ],
  [
    'yy/MM/dd h:mm a', 'y MMM d h:mm:ss a', 'y MMMM d h:mm:ss a z', 'EEEE, y MMMM dd h:mm:ss a zzzz',
  ],
  [
    'dd/MM/y h:mm a', 'd MMM y h:mm:ss a', 'd MMMM y h:mm:ss a z', 'y MMMM d, EEEE h:mm:ss a zzzz',
  ],
  [
    'd\u200f/M\u200f/y, h:mm a', 'dd\u200f/MM\u200f/y, h:mm:ss a', 'd MMMM y في h:mm:ss a z',
    'EEEE، d MMMM y في h:mm:ss a zzzz',
  ],
  [
    'd\u200f/M\u200f/y, H:mm', 'dd\u200f/MM\u200f/y, H:mm:ss', 'd MMMM y في H:mm:ss z',
    'EEEE، d MMMM y في H:mm:ss zzzz',
  ],
  [
    'd\u200f/M\u200f/y, HH:mm', 'dd\u200f/MM\u200f/y, HH:mm:ss', 'd MMMM y في HH:mm:ss z',
    'EEEE، d MMMM y في HH:mm:ss zzzz',
  ],
  [
    'd-M-y a h.mm', 'dd-MM-y a h.mm.ss', 'd MMMM, y a h.mm.ss z', 'EEEE, d MMMM, y a h.mm.ss zzzz',
  ],
  [
    'dd/MM/y HH:mm', 'd MMM y HH:mm:ss', 'd MMMM y HH:mm:ss z', 'EEEE, d MMMM y HH:mm:ss zzzz',
  ],
  [
    'd/M/yy HH:mm', 'd MMM y, HH:mm:ss', 'd MMMM \'de\' y \'a\' \'les\' HH:mm:ss z',
    'EEEE, d MMMM \'de\' y \'a\' \'les\' HH:mm:ss zzzz',
  ],
  [
    'dd.MM.yy HH:mm', 'd MMM y HH:mm:ss', 'd MMMM y HH:mm:ss z', 'd MMMM y, EEEE HH:mm:ss zzzz',
  ],
  [
    'd.MM.yy, HH:mm', 'd.MM.y, HH:mm:ss', 'd MMMM y \'г\'. \'у\' HH:mm:ss z',
    'EEEE, d MMMM y \'г\'. \'у\' HH:mm:ss, zzzz',
  ],
  [
    'dd/MM/y h:mm a', 'd MMM y h:mm:ss a', 'd MMMM y h:mm:ss a z', 'EEEE, d MMMM y h:mm:ss a zzzz',
  ],
  [
    'd.MM.yy \'г\'., H:mm \'ч\'.', 'd.MM.y \'г\'., H:mm:ss \'ч\'.', 'd MMMM y \'г\'., H:mm:ss \'ч\'. z',
    'EEEE, d MMMM y \'г\'., H:mm:ss \'ч\'. zzzz',
  ],
  [
    'd/M/yy h:mm a', 'd MMM, y h:mm:ss a', 'd MMMM, y h:mm:ss a z', 'EEEE, d MMMM, y h:mm:ss a zzzz',
  ],
  [
    'y-MM-dd h:mm a', 'y ལོའི་MMMཚེས་d h:mm:ss a', 'སྤྱི་ལོ་y MMMMའི་ཚེས་d h:mm:ss a z',
    'y MMMMའི་ཚེས་d, EEEE h:mm:ss a zzzz',
  ],
  [
    'dd/MM/y HH:mm', 'd MMM y, HH:mm:ss', 'd MMMM y \'da\' HH:mm:ss z', 'EEEE d MMMM y \'da\' HH:mm:ss zzzz',
  ],
  [
    'M/d/yy h:mm a', 'MMM d, y h:mm:ss a', 'MMMM d, y h:mm:ss a z', 'EEEE, MMMM d, y h:mm:ss a zzzz',
  ],
  [
    'd. M. y. HH:mm', 'd. MMM y. HH:mm:ss', 'd. MMMM y. \'u\' HH:mm:ss z', 'EEEE, d. MMMM y. \'u\' HH:mm:ss zzzz',
  ],
  [
    'd/M/yy H:mm', 'd MMM y, H:mm:ss', 'd MMMM \'de\' y, \'a\' \'les\' H:mm:ss z',
    'EEEE, d MMMM \'de\' y, \'a\' \'les\' H:mm:ss (zzzz)',
  ],
  [
    'M/d/yy, h:mm a', 'MMM d, y, h:mm:ss a', 'MMMM d, y \'sa\' h:mm:ss a z', 'EEEE, MMMM d, y \'sa\' h:mm:ss a zzzz',
  ],
  [
    'M/d/yy, h:mm a', 'MMM d, y, h:mm:ss a', 'MMMM d, y ᎤᎾᎢ h:mm:ss a z', 'EEEE, MMMM d, y ᎤᎾᎢ h:mm:ss a zzzz',
  ],
  [
    'y-MM-dd h:mm a', 'y MMM d h:mm:ss a', 'dی MMMMی y h:mm:ss a z', 'y MMMM d, EEEE h:mm:ss a zzzz',
  ],
  [
    'y-MM-dd HH:mm', 'y MMM d HH:mm:ss', 'dی MMMMی y HH:mm:ss z', 'y MMMM d, EEEE HH:mm:ss zzzz',
  ],
  [
    'dd.MM.yy H:mm', 'd. M. y H:mm:ss', 'd. MMMM y H:mm:ss z', 'EEEE d. MMMM y H:mm:ss zzzz',
  ],
  [
    'dd/MM/yy HH:mm', 'd MMM y HH:mm:ss', 'd MMMM y \'am\' HH:mm:ss z', 'EEEE, d MMMM y \'am\' HH:mm:ss zzzz',
  ],
  [
    'dd.MM.y HH.mm', 'd. MMM y HH.mm.ss', 'd. MMMM y \'kl\'. HH.mm.ss z',
    'EEEE \'den\' d. MMMM y \'kl\'. HH.mm.ss zzzz',
  ],
  [
    'd/M/yy, h:mm a', 'd, MMM y, h:mm:ss a', 'd, MMMM y गी h:mm:ss a z', 'EEEE, d, MMMM y गी h:mm:ss a zzzz',
  ],
  [
    'd.M.yy H:mm', 'd.M.y H:mm:ss', 'd. MMMM y H:mm:ss z', 'EEEE, d. MMMM y H:mm:ss zzzz',
  ],
  [
    'd/M/y HH:mm', 'd MMM y HH:mm:ss', 'd MMMM y HH:mm:ss z', 'EEEE d MMMM y HH:mm:ss zzzz',
  ],
  [
    'y-MM-dd ཆུ་ཚོད་ h སྐར་མ་ mm a', 'སྤྱི་ལོ་y ཟླ་MMM ཚེས་dd ཆུ་ཚོད་h:mm:ss a',
    'སྤྱི་ལོ་y MMMM ཚེས་ dd ཆུ་ཚོད་ h སྐར་མ་ mm:ss a z', 'EEEE, སྤྱི་ལོ་y MMMM ཚེས་dd ཆུ་ཚོད་ h སྐར་མ་ mm:ss a zzzz',
  ],
  [
    'a \'ga\' h:mm M/d/yy', 'a \'ga\' h:mm:ss MMM d \'lia\', y', 'a \'ga\' h:mm:ss z MMMM d \'lia\' y',
    'a \'ga\' h:mm:ss zzzz EEEE, MMMM d \'lia\' y',
  ],
  [
    'HH:mm M/d/yy', 'HH:mm:ss MMM d \'lia\', y', 'HH:mm:ss z MMMM d \'lia\' y', 'HH:mm:ss zzzz EEEE, MMMM d \'lia\' y',
  ],
  [
    'd/M/yy, h:mm a', 'd MMM y, h:mm:ss a', 'd MMMM y - h:mm:ss a z', 'EEEE, d MMMM y - h:mm:ss a zzzz',
  ],
  [
    'dd/MM/y, h:mm a', 'd MMM y, h:mm:ss a', 'd MMMM y \'at\' h:mm:ss a z', 'EEEE, d MMMM y \'at\' h:mm:ss a zzzz',
  ],
  [
    'dd/MM/yy, HH:mm', 'dd MMM y, HH:mm:ss', 'd MMMM y \'at\' HH:mm:ss z', 'EEEE, d MMMM y \'at\' HH:mm:ss zzzz',
  ],
  [
    'M/d/yy, HH:mm', 'MMM d, y, HH:mm:ss', 'MMMM d, y \'at\' HH:mm:ss z', 'EEEE, MMMM d, y \'at\' HH:mm:ss zzzz',
  ],
  [
    'dd/MM/yy, HH:mm', 'dd MMM y, HH:mm:ss', 'dd MMMM y \'at\' HH:mm:ss z', 'EEEE, dd MMMM y \'at\' HH:mm:ss zzzz',
  ],
  [
    'dd/MM/yy, HH:mm', 'dd-MMM-y, HH:mm:ss', 'dd MMMM y \'at\' HH:mm:ss z', 'EEEE, dd MMMM y \'at\' HH:mm:ss zzzz',
  ],
  [
    'dd/MM/y, HH.mm', 'd MMM y, HH.mm.ss', 'd MMMM y \'at\' HH.mm.ss z', 'EEEE, d MMMM y \'at\' HH.mm.ss zzzz',
  ],
  [
    'dd/MM/y, H.mm', 'd MMM y, H.mm.ss', 'd MMMM y \'at\' H.mm.ss z', 'EEEE, d MMMM y \'at\' H.mm.ss zzzz',
  ],
  [
    'd/M/y, h:mm a', 'd MMM y, h:mm:ss a', 'd MMMM y \'at\' h:mm:ss a z', 'EEEE, d MMMM y \'at\' h:mm:ss a zzzz',
  ],
  [
    'dd/MM/y, HH:mm', 'd MMM y, HH:mm:ss', 'd MMMM y \'at\' HH:mm:ss z', 'EEEE d MMMM y \'at\' HH:mm:ss zzzz',
  ],
  [
    'dd/MM/y, H:mm', 'd MMM y, H:mm:ss', 'd MMMM y \'at\' H:mm:ss z', 'EEEE, d MMMM y \'at\' H:mm:ss zzzz',
  ],
  [
    'dd/MM/yy, h:mm a', 'dd-MMM-y, h:mm:ss a', 'd MMMM y \'at\' h:mm:ss a z', 'EEEE, d MMMM, y \'at\' h:mm:ss a zzzz',
  ],
  [
    'dd/MM/y, HH:mm', 'dd MMM y, HH:mm:ss', 'dd MMMM y \'at\' HH:mm:ss z', 'EEEE, d MMMM y \'at\' HH:mm:ss zzzz',
  ],
  [
    'dd/MM/y, h:mm a', 'dd-MMM-y, h:mm:ss a', 'd MMMM y \'at\' h:mm:ss a z', 'EEEE, d MMMM y \'at\' h:mm:ss a zzzz',
  ],
  [
    'y-MM-dd, HH:mm', 'd MMM y, HH:mm:ss', 'd MMMM y \'at\' HH:mm:ss z', 'EEEE, d MMMM y \'at\' HH:mm:ss zzzz',
  ],
  [
    'y/MM/dd, HH:mm', 'dd MMM y, HH:mm:ss', 'dd MMMM y \'at\' HH:mm:ss z', 'EEEE, dd MMMM y \'at\' HH:mm:ss zzzz',
  ],
  [
    'd/M/y, HH:mm', 'dd MMM,y, HH:mm:ss', 'dd MMMM y \'at\' HH:mm:ss z', 'EEEE, dd MMMM y \'at\' HH:mm:ss zzzz',
  ],
  [
    'yy-MM-dd HH:mm', 'y-MMM-dd HH:mm:ss', 'y-MMMM-dd HH:mm:ss z',
    'EEEE, d-\'a\' \'de\' MMMM y H-\'a\' \'horo\' \'kaj\' m:ss zzzz',
  ],
  [
    'd/M/yy HH:mm', 'd MMM y HH:mm:ss', 'd \'de\' MMMM \'de\' y, HH:mm:ss z',
    'EEEE, d \'de\' MMMM \'de\' y, HH:mm:ss zzzz',
  ],
  [
    'd/M/yy HH:mm', 'd MMM \'de\' y HH:mm:ss', 'd \'de\' MMMM \'de\' y, HH:mm:ss z',
    'EEEE, d \'de\' MMMM \'de\' y, HH:mm:ss zzzz',
  ],
  [
    'dd-MM-yy HH:mm', 'dd-MM-y HH:mm:ss', 'd \'de\' MMMM \'de\' y, HH:mm:ss z',
    'EEEE, d \'de\' MMMM \'de\' y, HH:mm:ss zzzz',
  ],
  [
    'd/MM/yy, h:mm a', 'd/MM/y, h:mm:ss a', 'd \'de\' MMMM \'de\' y, h:mm:ss a z',
    'EEEE, d \'de\' MMMM \'de\' y, h:mm:ss a zzzz',
  ],
  [
    'd/M/yy h:mm a', 'd MMM y h:mm:ss a', 'd \'de\' MMMM \'de\' y, h:mm:ss a z',
    'EEEE, d \'de\' MMMM \'de\' y, h:mm:ss a zzzz',
  ],
  [
    'd/MM/yy HH:mm', 'd/MM/y HH:mm:ss', 'd \'de\' MMMM \'de\' y, HH:mm:ss z',
    'EEEE, d \'de\' MMMM \'de\' y, HH:mm:ss zzzz',
  ],
  [
    'd/M/yy HH:mm', 'd MMM y HH:mm:ss', 'dd \'de\' MMMM \'de\' y, HH:mm:ss z',
    'EEEE dd \'de\' MMMM \'de\' y, HH:mm:ss zzzz',
  ],
  [
    'MM/dd/yy h:mm a', 'MM/dd/y h:mm:ss a', 'd \'de\' MMMM \'de\' y, h:mm:ss a z',
    'EEEE, d \'de\' MMMM \'de\' y, h:mm:ss a zzzz',
  ],
  [
    'd/MM/yy HH:mm', 'd MMM y HH:mm:ss', 'd \'de\' MMMM \'de\' y, HH:mm:ss z',
    'EEEE, d \'de\' MMMM \'de\' y, HH:mm:ss zzzz',
  ],
  [
    'd/M/y h:mm a', 'd MMM y h:mm:ss a', 'd \'de\' MMMM \'de\' y, h:mm:ss a z',
    'EEEE, d \'de\' MMMM \'de\' y, h:mm:ss a zzzz',
  ],
  [
    'dd.MM.yy HH:mm', 'd. MMM y HH:mm:ss', 'd. MMMM y HH:mm:ss z', 'EEEE, d. MMMM y HH:mm:ss zzzz',
  ],
  [
    'yy/M/d HH:mm', 'y(\'e\')\'ko\' MMM d(\'a\') HH:mm:ss', 'y(\'e\')\'ko\' MMMM\'ren\' d(\'a\') HH:mm:ss (z)',
    'y(\'e\')\'ko\' MMMM\'ren\' d(\'a\'), EEEE HH:mm:ss (zzzz)',
  ],
  [
    'y/M/d،\u200f H:mm', 'd MMM y،\u200f H:mm:ss', 'd MMMM y، ساعت H:mm:ss (z)', 'EEEE d MMMM y، ساعت H:mm:ss (zzzz)',
  ],
  [
    'd.M.y H.mm', 'd.M.y \'klo\' H.mm.ss', 'd. MMMM y \'klo\' H.mm.ss z', 'EEEE d. MMMM y \'klo\' H.mm.ss zzzz',
  ],
  [
    'M/d/yy, h:mm a', 'MMM d, y, h:mm:ss a', 'MMMM d, y \'nang\' h:mm:ss a z',
    'EEEE, MMMM d, y \'nang\' h:mm:ss a zzzz',
  ],
  [
    'dd.MM.yy, HH:mm', 'dd.MM.y, HH:mm:ss', 'd. MMMM y \'kl\'. HH:mm:ss z', 'EEEE, d. MMMM y \'kl\'. HH:mm:ss zzzz',
  ],
  [
    'dd/MM/y h:mm a', 'd MMM y, h:mm:ss a', 'd MMMM y \'à\' h:mm:ss a z', 'EEEE d MMMM y \'à\' h:mm:ss a zzzz',
  ],
  [
    'dd/MM/y, HH:mm', 'd MMM y, HH:mm:ss', 'd MMMM y \'à\' HH:mm:ss z', 'EEEE d MMMM y \'à\' HH:mm:ss zzzz',
  ],
  [
    'dd/MM/yy HH:mm', 'dd/MM/y HH:mm:ss', 'd \'di\' MMMM \'dal\' y HH:mm:ss z',
    'EEEE d \'di\' MMMM \'dal\' y HH:mm:ss zzzz',
  ],
  [
    'dd-MM-yy HH:mm', 'd MMM y HH:mm:ss', 'd MMMM y \'om\' HH:mm:ss z', 'EEEE d MMMM y \'om\' HH:mm:ss zzzz',
  ],
  [
    'dd/MM/y HH:mm', 'd MMM y HH:mm:ss', 'd MMMM y HH:mm:ss z', 'EEEE d MMMM y HH:mm:ss zzzz',
  ],
  [
    'dd/MM/y HH:mm', 'd MMM y HH:mm:ss', 'd\'mh\' MMMM y HH:mm:ss z', 'EEEE, d\'mh\' MMMM y HH:mm:ss zzzz',
  ],
  [
    'HH:mm, dd/MM/yy', 'HH:mm:ss, d \'de\' MMM \'de\' y', 'HH:mm:ss z \'do\' d \'de\' MMMM \'de\' y',
    'HH:mm:ss zzzz \'do\' EEEE, d \'de\' MMMM \'de\' y',
  ],
  [
    'dd.MM.yy HH:mm', 'dd.MM.y HH:mm:ss', 'd. MMMM y HH:mm:ss z', 'EEEE, d. MMMM y HH:mm:ss zzzz',
  ],
  [
    'd/M/yy hh:mm a', 'd MMM, y hh:mm:ss a', 'd MMMM, y એ hh:mm:ss a z વાગ્યે',
    'EEEE, d MMMM, y એ hh:mm:ss a zzzz વાગ્યે',
  ],
  [
    'd/M/yy, HH:mm', 'd MMM, y, HH:mm:ss', 'd MMMM, y \'da\' HH:mm:ss z', 'EEEE d MMMM, y HH:mm:ss zzzz',
  ],
  [
    'd/M/yy, h:mm a', 'd MMM, y, h:mm:ss a', 'd MMMM, y \'da\' h:mm:ss a z', 'EEEE d MMMM, y h:mm:ss a zzzz',
  ],
  [
    'd/M/yy h:mm a', 'd MMM y h:mm:ss a', 'd MMMM y h:mm:ss a z', 'EEEE, d MMMM y h:mm:ss a zzzz',
  ],
  [
    'd.M.y, H:mm', 'd בMMM y, H:mm:ss', 'd בMMMM y בשעה H:mm:ss z', 'EEEE, d בMMMM y בשעה H:mm:ss zzzz',
  ],
  [
    'd/M/yy, h:mm a', 'd MMM y, h:mm:ss a', 'd MMMM y को h:mm:ss a z', 'EEEE, d MMMM y को h:mm:ss a zzzz',
  ],
  [
    'dd. MM. y. HH:mm', 'd. MMM y. HH:mm:ss', 'd. MMMM y. \'u\' HH:mm:ss z', 'EEEE, d. MMMM y. \'u\' HH:mm:ss (zzzz)',
  ],
  [
    'd. M. yy. HH:mm', 'd. MMM y. HH:mm:ss', 'd. MMMM y. \'u\' HH:mm:ss z', 'EEEE, d. MMMM y. \'u\' HH:mm:ss (zzzz)',
  ],
  [
    'd.M.yy H:mm \'hodź\'.', 'd.M.y H:mm:ss', 'd. MMMM y H:mm:ss z', 'EEEE, d. MMMM y H:mm:ss zzzz',
  ],
  [
    'y. MM. dd. H:mm', 'y. MMM d. H:mm:ss', 'y. MMMM d. H:mm:ss z', 'y. MMMM d., EEEE H:mm:ss zzzz',
  ],
  [
    'dd.MM.yy, HH:mm', 'dd MMM, y թ., HH:mm:ss', 'dd MMMM, y թ., HH:mm:ss z', 'y թ. MMMM d, EEEE, HH:mm:ss zzzz',
  ],
  [
    'dd-MM-y HH:mm', 'd MMM y HH:mm:ss', 'd \'de\' MMMM y \'a\' HH:mm:ss z',
    'EEEE \'le\' d \'de\' MMMM y \'a\' HH:mm:ss zzzz',
  ],
  [
    'dd/MM/yy HH.mm', 'd MMM y HH.mm.ss', 'd MMMM y HH.mm.ss z', 'EEEE, dd MMMM y HH.mm.ss zzzz',
  ],
  [
    'd/M/yy, HH:mm', 'd MMM y, HH:mm:ss', 'd MMMM y \'na\' HH:mm:ss z', 'EEEE, d MMMM y \'na\' HH:mm:ss zzzz',
  ],
  [
    'y-MM-dd h:mm a', 'y MMM d h:mm:ss a', 'y MMMM d h:mm:ss a z', 'y MMMM d, EEEE h:mm:ss a zzzz',
  ],
  [
    'd.M.y, HH:mm', 'd. MMM y, HH:mm:ss', 'd. MMMM y \'kl\'. HH:mm:ss z', 'EEEE, d. MMMM y \'kl\'. HH:mm:ss zzzz',
  ],
  [
    'yy/MM/dd H:mm', 'yyyy/MM/dd H:mm:ss', 'yyyy/MM/dd H:mm:ss z', 'yyyy\'年\'M\'月\'d\'日\' H\'時\'mm\'分\'ss\'秒\' z',
  ],
  [
    'y-MM-dd HH:mm', 'y MMM d HH:mm:ss', 'y MMMM d HH:mm:ss z', 'EEEE, y MMMM dd HH:mm:ss zzzz',
  ],
  [
    'dd-MM-y, HH:mm', 'd MMM y, HH:mm:ss', 'd MMMM y HH:mm:ss z', 'EEEE, d MMMM y HH:mm:ss zzzz',
  ],
  [
    'dd.MM.yy, HH:mm', 'd MMM. y, HH:mm:ss', 'd MMMM, y, HH:mm:ss z', 'EEEE, dd MMMM, y, HH:mm:ss zzzz',
  ],
  [
    'd/M/y h:mm a', 'd MMM, y h:mm:ss a', 'd MMMM y h:mm:ss a z', 'EEEE d MMMM y h:mm:ss a zzzz',
  ],
  [
    'dd/MM/y, HH:mm', 'd MMM y, HH:mm:ss', 'd \'di\' MMMM \'di\' y, HH:mm:ss z',
    'EEEE, d \'di\' MMMM \'di\' y, HH:mm:ss zzzz',
  ],
  [
    'dd.MM.yy, HH:mm', 'y \'ж\'. dd MMM, HH:mm:ss', 'y \'ж\'. d MMMM, HH:mm:ss z',
    'y \'ж\'. d MMMM, EEEE, HH:mm:ss zzzz',
  ],
  [
    'dd/MM y HH:mm', 'd MMM y HH:mm:ss', 'd MMMM y HH:mm:ss z', 'EEEE dd MMMM y HH:mm:ss zzzz',
  ],
  [
    'y-MM-dd HH.mm', 'y MMM d HH.mm.ss', 'y MMMM d HH.mm.ss z', 'y MMMM d, EEEE HH.mm.ss zzzz',
  ],
  [
    'd/M/yy, h:mm a', 'd MMM y, h:mm:ss a', 'd MMMM y នៅ\u200bម៉ោង h:mm:ss a z',
    'EEEE d MMMM y នៅ\u200bម៉ោង h:mm:ss a zzzz',
  ],
  [
    'd/M/yy hh:mm a', 'MMM d, y hh:mm:ss a', 'MMMM d, y hh:mm:ss a z', 'EEEE, MMMM d, y hh:mm:ss a zzzz',
  ],
  [
    'd-M-yy h:mm a', 'd-MMM-y h:mm:ss a', 'd MMMM y h:mm:ss a z', 'EEEE d MMMM y h:mm:ss a zzzz',
  ],
  [
    'd. M. y HH:mm', 'd. MMM. y HH:mm:ss', 'd. MMMM y HH:mm:ss z', 'EEEE, \'dä\' d. MMMM y HH:mm:ss zzzz',
  ],
  [
    'd/M/yy HH:mm', 'y-\'ж\'., d-MMM HH:mm:ss', 'y-\'ж\'., d-MMMM HH:mm:ss z', 'y-\'ж\'., d-MMMM, EEEE HH:mm:ss zzzz',
  ],
  [
    'd/M/y, H:mm', 'd MMM y, H:mm:ss', 'd MMMM y, H ໂມງ m ນາທີ ss ວິນາທີ z',
    'EEEE ທີ d MMMM G y, H ໂມງ m ນາທີ ss ວິນາທີ zzzz',
  ],
  [
    'y-MM-dd HH:mm', 'y-MM-dd HH:mm:ss', 'y \'m\'. MMMM d \'d\'. HH:mm:ss z',
    'y \'m\'. MMMM d \'d\'., EEEE HH:mm:ss zzzz',
  ],
  [
    'dd.MM.yy HH:mm', 'y. \'gada\' d. MMM HH:mm:ss', 'y. \'gada\' d. MMMM HH:mm:ss z',
    'EEEE, y. \'gada\' d. MMMM HH:mm:ss zzzz',
  ],
  [
    'd/M/yy, h:mm a', 'd MMM y, h:mm:ss a', 'd MMMM y के h:mm:ss a z', 'EEEE, d MMMM y के h:mm:ss a zzzz',
  ],
  [
    'y-MM-dd HH:mm', 'y MMM d HH:mm:ss', 'd MMMM y HH:mm:ss z', 'EEEE d MMMM y HH:mm:ss zzzz',
  ],
  [
    'dd-MM-y h:mm a', 'd MMM y h:mm:ss a', 'd MMMM y h:mm:ss a z', 'EEEE, d MMMM y h:mm:ss a zzzz',
  ],
  [
    'd.M.yy, \'во\' HH:mm', 'd.M.y, \'во\' HH:mm:ss', 'd MMMM y, \'во\' HH:mm:ss z',
    'EEEE, d MMMM y, \'во\' HH:mm:ss zzzz',
  ],
  [
    'd/M/yy h:mm a', 'y, MMM d h:mm:ss a', 'y, MMMM d h:mm:ss a z', 'y, MMMM d, EEEE h:mm:ss a zzzz',
  ],
  [
    'y.MM.dd HH:mm', 'y \'оны\' MMM\'ын\' d HH:mm:ss', 'y \'оны\' MMMM\'ын\' d HH:mm:ss (z)',
    'y \'оны\' MMMM\'ын\' d, EEEE \'гараг\' HH:mm:ss (zzzz)',
  ],
  [
    'd/M/yy, h:mm a', 'MMM d, y, h:mm:ss a', 'MMMM d, y গী h:mm:ss a z দা', 'MMMM d, y, EEEE গী h:mm:ss a zzzz দা',
  ],
  [
    'd/M/yy, h:mm a', 'd MMM, y, h:mm:ss a', 'd MMMM, y रोजी h:mm:ss a z', 'EEEE, d MMMM, y रोजी h:mm:ss a zzzz',
  ],
  [
    'd/MM/yy, h:mm a', 'd MMM y, h:mm:ss a', 'd MMMM y h:mm:ss a z', 'EEEE, d MMMM y h:mm:ss a zzzz',
  ],
  [
    'd/MM/yy, h:mm a', 'd MMM y, h:mm:ss a', 'd MMMM y h:mm:ss a z', 'dd MMMM y h:mm:ss a zzzz',
  ],
  [
    'dd/MM/yy, HH.mm', 'd MMM y, HH.mm.ss', 'd MMMM y HH.mm.ss z', 'EEEE, dd MMMM y HH.mm.ss zzzz',
  ],
  [
    'dd/MM/y HH:mm', 'dd MMM y HH:mm:ss', 'd \'ta\'’ MMMM y HH:mm:ss z', 'EEEE, d \'ta\'’ MMMM y HH:mm:ss zzzz',
  ],
  [
    'dd-MM-yy a H:mm', 'y၊ MMM d a HH:mm:ss', 'y၊ d MMMM z HH:mm:ss', 'y၊ MMMM d၊ EEEE zzzz HH:mm:ss',
  ],
  [
    'yy/M/d, HH:mm', 'y MMM d, HH:mm:ss', 'y MMMM d HH:mm:ss z', 'y MMMM d, EEEE HH:mm:ss zzzz',
  ],
  [
    'yy/M/d, h:mm a', 'y MMM d, h:mm:ss a', 'y MMMM d h:mm:ss a z', 'y MMMM d, EEEE h:mm:ss a zzzz',
  ],
  [
    'dd/MM/yy HH:mm', 'd MMM, y HH:mm:ss', '\'lyɛ\'̌ʼ d \'na\' MMMM, y, HH:mm:ss z',
    'EEEE , \'lyɛ\'̌ʼ d \'na\' MMMM, y,HH:mm:ss zzzz',
  ],
  [
    'd/MM/y h:mm a', 'd MMM y h:mm:ss a', 'd MMMM y z h:mm:ss a', 'EEEE d MMMM y zzzz h:mm:ss a',
  ],
  [
    'dd/MM/yy h:mm a', 'dd-MMM-y h:mm:ss a', 'dd MMMM y h:mm:ss a z', 'EEEE, MMMM d, y h:mm:ss a zzzz',
  ],
  [
    'dd/MM/yy HH:mm', 'dd-MMM-y HH:mm:ss', 'dd MMMM y HH:mm:ss z', 'EEEE, MMMM d, y HH:mm:ss zzzz',
  ],
  [
    'M/d/yy, h:mm a', 'MMM d, y, h:mm:ss a', 'h:mm:ss a z ଠାରେ MMMM d, y', 'h:mm:ss a zzzz ଠାରେ EEEE, MMMM d, y',
  ],
  [
    'dd.MM.yy, HH:mm', 'dd MMM y \'аз\', HH:mm:ss', 'd MMMM, y \'аз\', HH:mm:ss z',
    'EEEE, d MMMM, y \'аз\', HH:mm:ss zzzz',
  ],
  [
    'd/M/yy, h:mm a', 'd MMM y, h:mm:ss a', 'd MMMM y h:mm:ss a z', 'EEEE, d MMMM y h:mm:ss a zzzz',
  ],
  [
    'dd/MM/y HH:mm', 'd MMM y HH:mm:ss', 'd MMMM y \'fọ\' H:mm:ss z', 'EEEE, d MMMM y \'fọ\' HH:mm:ss zzzz',
  ],
  [
    'dd.MM.y, HH:mm', 'd MMM y, HH:mm:ss', 'd MMMM y HH:mm:ss z', 'EEEE, d MMMM y HH:mm:ss zzzz',
  ],
  [
    'y/M/d H:mm', 'y MMM d H:mm:ss', 'د y د MMMM d H:mm:ss (z)', 'EEEE د y د MMMM d H:mm:ss (zzzz)',
  ],
  [
    'y/M/d h:mm a', 'y MMM d h:mm:ss a', 'د y د MMMM d h:mm:ss a z', 'EEEE د y د MMMM d h:mm:ss a zzzz',
  ],
  [
    'dd/MM/yy, h:mm a', 'dd/MM/y, h:mm:ss a', 'd \'de\' MMMM \'de\' y \'às\' h:mm:ss a z',
    'EEEE, d \'de\' MMMM \'de\' y \'às\' h:mm:ss a zzzz',
  ],
  [
    'dd/MM/y HH:mm', 'd MMM y HH:mm:ss', 'HH:mm:ss z d MMMM y', 'EEEE, d MMMM, y HH:mm:ss zzzz',
  ],
  [
    'dd-MM-yy HH:mm', 'dd-MM-y HH:mm:ss', 'd MMMM y HH:mm:ss z', 'EEEE, \'ils\' d MMMM y HH:mm:ss zzzz',
  ],
  [
    'dd.MM.y, HH:mm', 'd MMM y, HH:mm:ss', 'd MMMM y, HH:mm:ss z', 'EEEE, d MMMM y, HH:mm:ss zzzz',
  ],
  [
    'dd.MM.y, HH:mm', 'd MMM y \'г\'., HH:mm:ss', 'd MMMM y \'г\'., HH:mm:ss z',
    'EEEE, d MMMM y \'г\'., HH:mm:ss zzzz',
  ],
  [
    'd/M/yy, h:mm a', 'd MMM y, h:mm:ss a', 'd MMMM y तदा h:mm:ss a z', 'EEEE, d MMMM y तदा h:mm:ss a zzzz',
  ],
  [
    'yy/M/d HH:mm', 'y, MMM d HH:mm:ss', 'y, MMMM d HH:mm:ss z', 'y \'сыл\' MMMM d \'күнэ\', EEEE HH:mm:ss zzzz',
  ],
  [
    'dd.MM.y HH:mm', 'd MMM y HH:mm:ss', 'd MMMM y HH:mm:ss z', 'EEEE d MMMM y HH:mm:ss zzzz',
  ],
  [
    'd/M/y HH:mm', 'd \'de\' MMM \'de\' y HH:mm:ss', 'd \'de\' MMMM \'de\' y HH:mm:ss z',
    'EEEE, d \'de\' MMMM \'de\' y HH:mm:ss zzzz',
  ],
  [
    'd. M. y H:mm', 'd. M. y, H:mm:ss', 'd. MMMM y, H:mm:ss z', 'EEEE d. MMMM y, H:mm:ss zzzz',
  ],
  [
    'd. MM. yy HH:mm', 'd. MMM y HH:mm:ss', 'dd. MMMM y HH:mm:ss z', 'EEEE, dd. MMMM y HH:mm:ss zzzz',
  ],
  [
    'd.M.y H.mm', 'MMM d. y \'tme\' H.mm.ss', 'MMMM d. y \'tme\' H.mm.ss z', 'EEEE, MMMM d. y \'tme\' H.mm.ss zzzz',
  ],
  [
    'dd/MM/yy h:mm a', 'dd-MMM-y h:mm:ss a', 'dd MMMM y h:mm:ss a z', 'EEEE, MMMM dd, y h:mm:ss a zzzz',
  ],
  [
    'dd/MM/yy HH:mm', 'dd-MMM-y HH:mm:ss', 'dd MMMM y HH:mm:ss z', 'EEEE, MMMM dd, y HH:mm:ss zzzz',
  ],
  [
    'd.M.yy, h:mm a', 'd MMM y, h:mm:ss a', 'd MMMM y \'në\' h:mm:ss a, z', 'EEEE, d MMMM y \'në\' h:mm:ss a, zzzz',
  ],
  [
    'd.M.yy, HH:mm', 'd MMM y, HH:mm:ss', 'd MMMM y \'në\' HH:mm:ss z', 'EEEE, d MMMM y \'në\' HH:mm:ss zzzz',
  ],
  [
    'd.M.yy. HH:mm', 'dd.MM.y. HH:mm:ss', 'dd. MMMM y. HH:mm:ss z', 'EEEE, dd. MMMM y. HH:mm:ss zzzz',
  ],
  [
    'yy-MM-dd HH:mm', 'yyyy-MM-dd HH:mm:ss', 'dd. MMMM yyyy. HH.mm.ss z',
    'EEEE, dd. MMMM yyyy. HH \'часова\', mm \'минута\', ss\' секунди\'',
  ],
  [
    'd.M.yy. HH.mm', 'dd.MM.yyyy. HH.mm.ss', 'dd.MM.yyyy. HH.mm.ss z', 'EEEE, dd.MMMM.yyyy. HH.mm.ss z',
  ],
  [
    'd/M/yy, H.mm', 'd MMM y, H.mm.ss', 'd MMMM y \'jam\' H.mm.ss z', 'EEEE, d MMMM y \'jam\' H.mm.ss zzzz',
  ],
  [
    'd/M/yy, a h:mm', 'd MMM, y, a h:mm:ss', 'd MMMM, y ’அன்று’ a h:mm:ss z', 'EEEE, d MMMM, y ’அன்று’ a h:mm:ss zzzz',
  ],
  [
    'd/M/yy, HH:mm', 'd MMM, y, HH:mm:ss', 'd MMMM, y ’அன்று’ HH:mm:ss z', 'EEEE, d MMMM, y ’அன்று’ HH:mm:ss zzzz',
  ],
  [
    'dd-MM-yy h:mm a', 'd MMM, y h:mm:ss a', 'd MMMM, y h:mm:ss a zకి', 'd, MMMM y, EEEE h:mm:ss a zzzzకి',
  ],
  [
    'dd/MM/yy HH:mm', 'dd MMM y HH:mm:ss', 'dd MMMM y HH:mm:ss z', 'EEEE, dd MMMM y HH:mm:ss zzzz',
  ],
  [
    'd/M/yy HH:mm', 'd MMM y HH:mm:ss', 'd MMMM G y H นาฬิกา mm นาที ss วินาที z',
    'EEEEที่ d MMMM G y H นาฬิกา mm นาที ss วินาที zzzz',
  ],
  [
    'd/M/yy HH:mm', 'd MMM y HH:mm:ss', 'd MMMM y H นาฬิกา mm นาที ss วินาที z',
    'EEEEที่ d MMMM GGGG y H นาฬิกา mm นาที ss วินาที zzzz',
  ],
  [
    'd/M/yyyy, H:mm\' น.\'', 'd MMM yyyy, H:mm:ss', 'd MMMM yyyy, H\' นาฬิกา \'m\' นาที\'',
    'EEEE\'ที่ \'d MMMM G yyyy, H\' นาฬิกา \'m\' นาที \'ss\' วินาที\'',
  ],
  [
    'dd/MM/yy h:mm a', 'dd-MMM-y h:mm:ss a', 'dd MMMM y h:mm:ss a z', 'EEEE፣ dd MMMM መዓልቲ y G h:mm:ss a zzzz',
  ],
  [
    'dd.MM.y HH:mm', 'd MMM y HH:mm:ss', 'd MMMM y HH:mm:ss z', 'd MMMM y EEEE HH:mm:ss zzzz',
  ],
  [
    'd/M/yy h:mm a', 'd MMM y, h:mm:ss a', 'd MMMM y, h:mm:ss a z', 'EEEE d MMMM y, h:mm:ss a zzzz',
  ],
  [
    'd.MM.y HH:mm', 'd MMM y HH:mm:ss', 'd MMMM y HH:mm:ss z', 'd MMMM y EEEE HH:mm:ss zzzz',
  ],
  [
    'd.MM.y h:mm a', 'd MMM y h:mm:ss a', 'd MMMM y h:mm:ss a z', 'd MMMM y EEEE h:mm:ss a zzzz',
  ],
  [
    'dd.MM.y, H:mm', 'd MMM, y \'ел\', H:mm:ss', 'd MMMM, y \'ел\', H:mm:ss z', 'd MMMM, y \'ел\', EEEE, H:mm:ss zzzz',
  ],
  [
    'y-MM-dd، h:mm a', 'd-MMM، y، h:mm:ss a', 'd-MMMM، y h:mm:ss a z', 'y d-MMMM، EEEE h:mm:ss a zzzz',
  ],
  [
    'dd.MM.yy, HH:mm', 'd MMM y \'р\'., HH:mm:ss', 'd MMMM y \'р\'. \'о\' HH:mm:ss z',
    'EEEE, d MMMM y \'р\'. \'о\' HH:mm:ss zzzz',
  ],
  [
    'd/M/yy h:mm a', 'd MMM، y h:mm:ss a', 'd MMMM، y h:mm:ss a z', 'EEEE، d MMMM، y h:mm:ss a zzzz',
  ],
  [
    'dd/MM/yy, HH:mm', 'd-MMM, y, HH:mm:ss', 'd-MMMM, y, H:mm:ss (z)', 'EEEE, d-MMMM, y, H:mm:ss (zzzz)',
  ],
  [
    'HH:mm, dd/MM/y', 'HH:mm:ss, d MMM, y', 'HH:mm:ss z d MMMM, y', 'HH:mm:ss zzzz EEEE, d MMMM, y',
  ],
  [
    'y-MM-dd HH:mm', 'd. MMM y HH:mm:ss', 'd. MMMM y HH:mm:ss z', 'EEEE, d. MMMM y HH:mm:ss zzzz',
  ],
  [
    'dd-MM-y - HH:mm', 'd MMM, y - HH:mm:ss', 'd MMMM, y \'ci\' HH:mm:ss z', 'EEEE, d MMM, y \'ci\' HH:mm:ss zzzz',
  ],
  [
    'dd/MM/yy HH:mm', 'dטן MMM y, HH:mm:ss', 'dטן MMMM y HH:mm:ss z', 'EEEE, dטן MMMM y HH:mm:ss zzzz',
  ],
  [
    'd/M/y H:m', 'd MM y H:m:s', 'd MMM y H:mm:ss z', 'EEEE, d MMM y HH:mm:ss zzzz',
  ],
  [
    'dd/MM/yy a hh:mm', 'dd-MMM-yy a hh:mm', 'dd MMM yyyy a hh:mm:ss', 'dd MMMM yyyy a hh:mm:ss',
  ],
  [
    'M/d/yy HH:mm', 'MMM d, y HH:mm:ss', 'MMMM d, y HH:mm:ss z', 'EEEE, MMMM d, y HH:mm:ss zzzz',
  ],
];

/** Date patterns, SHORT to FULL. */
const DATE_PATTERNS: ReadonlyArray<readonly string[]> = [
  [
    'y-MM-dd', 'y MMM d', 'y MMMM d', 'y MMMM d, EEEE',
  ],
  [
    'y/M/d', 'y年M月d日', 'y年M月d日', 'y年M月d日EEEE',
  ],
  [
    'd/M/y', 'y年M月d日', 'y年M月d日', 'y年M月d日EEEE',
  ],
  [
    'y/M/d', 'y年M月d日', 'y年M月d日', 'y年M月d日 EEEE',
  ],
  [
    'd/MM/y', 'd MMM y', 'd MMMM y', 'EEEE d MMMM y',
  ],
  [
    'dd-MM-y', 'd MMM y', 'd MMMM y', 'EEEE d MMMM y',
  ],
  [
    'd/M/yy', 'd MMM y', 'd MMMM y', 'EEEE, d MMMM y',
  ],
  [
    'y-MM-dd', 'MMM d, y', 'MMMM d, y', 'EEEE, MMMM d, y',
  ],
  [
    'd/MM/yy', 'd/MM/y', 'd MMMM y', 'EEEE, d MMMM y',
  ],
  [
    'dd/MM/y', 'd MMM y', 'd MMMM y', 'EEEE, d MMMM y',
  ],
  [
    'M/d/yy', 'MMM d, y', 'MMMM d, y', 'EEEE, MMMM d, y',
  ],
  [
    'd/MM/yy', 'd MMM y', 'd MMMM y', 'EEEE d MMMM y',
  ],
  [
    'y-MM-dd', 'd MMM y', 'd MMMM y', 'EEEE d MMMM y',
  ],
  [
    'dd/MM/y', 'd MMM y', 'd MMMM y', 'EEEE d MMMM y',
  ],
  [
    'dd.MM.yy', 'd MMM y', 'd MMMM y', 'EEEE, d MMMM y',
  ],
  [
    'dd.MM.yy', 'dd.MM.y', 'd. MMMM y', 'EEEE, d. MMMM y',
  ],
  [
    'dd/MM/yy', 'd MMM y', 'd MMMM y', 'EEEE d MMMM y',
  ],
  [
    'y/MM/dd', 'y/MM/dd', 'y年M月d日', 'y年M月d日EEEE',
  ],
  [
    'yy. M. d.', 'y. M. d.', 'y년 M월 d일', 'y년 M월 d일 EEEE',
  ],
  [
    'dd.MM.y', 'd. MMM y', 'd. MMMM y', 'EEEE d. MMMM y',
  ],
  [
    'dd/MM/y', 'd \'de\' MMM \'de\' y', 'd \'de\' MMMM \'de\' y', 'EEEE, d \'de\' MMMM \'de\' y',
  ],
  [
    'dd/MM/yy', 'dd/MM/y', 'd \'de\' MMMM \'de\' y', 'EEEE, d \'de\' MMMM \'de\' y',
  ],
  [
    'dd/MM/yy', 'd MMM y', 'd \'de\' MMMM \'de\' y', 'EEEE, d \'de\' MMMM \'de\' y',
  ],
  [
    'd/M/yy', 'd MMM y', 'd \'de\' MMMM \'de\' y', 'EEEE, d \'de\' MMMM \'de\' y',
  ],
  [
    'y-MM-dd', 'dd MMM y', 'dd MMMM y', 'EEEE dd MMMM y',
  ],
  [
    'd/M/y', 'd MMM, y', 'd MMMM y', 'EEEE d MMMM y',
  ],
  [
    'yy/MM/dd', 'y MMM d', 'y MMMM d', 'EEEE, y MMMM dd',
  ],
  [
    'dd/MM/y', 'd MMM y', 'd MMMM y', 'y MMMM d, EEEE',
  ],
  [
    'd\u200f/M\u200f/y', 'dd\u200f/MM\u200f/y', 'd MMMM y', 'EEEE، d MMMM y',
  ],
  [
    'd-M-y', 'dd-MM-y', 'd MMMM, y', 'EEEE, d MMMM, y',
  ],
  [
    'd/M/yy', 'd MMM y', 'd MMMM \'de\' y', 'EEEE, d MMMM \'de\' y',
  ],
  [
    'dd.MM.yy', 'd MMM y', 'd MMMM y', 'd MMMM y, EEEE',
  ],
  [
    'd.MM.yy', 'd.MM.y', 'd MMMM y \'г\'.', 'EEEE, d MMMM y \'г\'.',
  ],
  [
    'd.MM.yy \'г\'.', 'd.MM.y \'г\'.', 'd MMMM y \'г\'.', 'EEEE, d MMMM y \'г\'.',
  ],
  [
    'd/M/yy', 'd MMM, y', 'd MMMM, y', 'EEEE, d MMMM, y',
  ],
  [
    'y-MM-dd', 'y ལོའི་MMMཚེས་d', 'སྤྱི་ལོ་y MMMMའི་ཚེས་d', 'y MMMMའི་ཚེས་d, EEEE',
  ],
  [
    'd. M. y.', 'd. MMM y.', 'd. MMMM y.', 'EEEE, d. MMMM y.',
  ],
  [
    'y-MM-dd', 'y MMM d', 'dی MMMMی y', 'y MMMM d, EEEE',
  ],
  [
    'dd.MM.yy', 'd. M. y', 'd. MMMM y', 'EEEE d. MMMM y',
  ],
  [
    'dd/MM/yy', 'd MMM y', 'd MMMM y', 'EEEE, d MMMM y',
  ],
  [
    'dd.MM.y', 'd. MMM y', 'd. MMMM y', 'EEEE \'den\' d. MMMM y',
  ],
  [
    'd/M/yy', 'd, MMM y', 'd, MMMM y', 'EEEE, d, MMMM y',
  ],
  [
    'd.M.yy', 'd.M.y', 'd. MMMM y', 'EEEE, d. MMMM y',
  ],
  [
    'd/M/y', 'd MMM y', 'd MMMM y', 'EEEE d MMMM y',
  ],
  [
    'y-MM-dd', 'སྤྱི་ལོ་y ཟླ་MMM ཚེས་dd', 'སྤྱི་ལོ་y MMMM ཚེས་ dd', 'EEEE, སྤྱི་ལོ་y MMMM ཚེས་dd',
  ],
  [
    'M/d/yy', 'MMM d \'lia\', y', 'MMMM d \'lia\' y', 'EEEE, MMMM d \'lia\' y',
  ],
  [
    'dd/MM/yy', 'dd MMM y', 'd MMMM y', 'EEEE, d MMMM y',
  ],
  [
    'dd/MM/yy', 'dd MMM y', 'dd MMMM y', 'EEEE, dd MMMM y',
  ],
  [
    'dd/MM/yy', 'dd-MMM-y', 'dd MMMM y', 'EEEE, dd MMMM y',
  ],
  [
    'd/M/y', 'd MMM y', 'd MMMM y', 'EEEE, d MMMM y',
  ],
  [
    'dd/MM/yy', 'dd-MMM-y', 'd MMMM y', 'EEEE, d MMMM, y',
  ],
  [
    'dd/MM/y', 'dd MMM y', 'dd MMMM y', 'EEEE, d MMMM y',
  ],
  [
    'dd/MM/y', 'dd-MMM-y', 'd MMMM y', 'EEEE, d MMMM y',
  ],
  [
    'y-MM-dd', 'd MMM y', 'd MMMM y', 'EEEE, d MMMM y',
  ],
  [
    'y/MM/dd', 'dd MMM y', 'dd MMMM y', 'EEEE, dd MMMM y',
  ],
  [
    'd/M/y', 'dd MMM,y', 'dd MMMM y', 'EEEE, dd MMMM y',
  ],
  [
    'yy-MM-dd', 'y-MMM-dd', 'y-MMMM-dd', 'EEEE, d-\'a\' \'de\' MMMM y',
  ],
  [
    'd/M/yy', 'd MMM \'de\' y', 'd \'de\' MMMM \'de\' y', 'EEEE, d \'de\' MMMM \'de\' y',
  ],
  [
    'dd-MM-yy', 'dd-MM-y', 'd \'de\' MMMM \'de\' y', 'EEEE, d \'de\' MMMM \'de\' y',
  ],
  [
    'd/MM/yy', 'd/MM/y', 'd \'de\' MMMM \'de\' y', 'EEEE, d \'de\' MMMM \'de\' y',
  ],
  [
    'd/M/yy', 'd MMM y', 'dd \'de\' MMMM \'de\' y', 'EEEE dd \'de\' MMMM \'de\' y',
  ],
  [
    'MM/dd/yy', 'MM/dd/y', 'd \'de\' MMMM \'de\' y', 'EEEE, d \'de\' MMMM \'de\' y',
  ],
  [
    'd/MM/yy', 'd MMM y', 'd \'de\' MMMM \'de\' y', 'EEEE, d \'de\' MMMM \'de\' y',
  ],
  [
    'd/M/y', 'd MMM y', 'd \'de\' MMMM \'de\' y', 'EEEE, d \'de\' MMMM \'de\' y',
  ],
  [
    'dd.MM.yy', 'd. MMM y', 'd. MMMM y', 'EEEE, d. MMMM y',
  ],
  [
    'yy/M/d', 'y(\'e\')\'ko\' MMM d(\'a\')', 'y(\'e\')\'ko\' MMMM\'ren\' d(\'a\')',
    'y(\'e\')\'ko\' MMMM\'ren\' d(\'a\'), EEEE',
  ],
  [
    'y/M/d', 'd MMM y', 'd MMMM y', 'EEEE d MMMM y',
  ],
  [
    'd.M.y', 'd.M.y', 'd. MMMM y', 'EEEE d. MMMM y',
  ],
  [
    'dd/MM/yy', 'dd/MM/y', 'd \'di\' MMMM \'dal\' y', 'EEEE d \'di\' MMMM \'dal\' y',
  ],
  [
    'dd-MM-yy', 'd MMM y', 'd MMMM y', 'EEEE d MMMM y',
  ],
  [
    'dd/MM/y', 'd MMM y', 'd\'mh\' MMMM y', 'EEEE, d\'mh\' MMMM y',
  ],
  [
    'dd/MM/yy', 'd \'de\' MMM \'de\' y', 'd \'de\' MMMM \'de\' y', 'EEEE, d \'de\' MMMM \'de\' y',
  ],
  [
    'd/M/yy', 'd MMM, y', 'd MMMM, y', 'EEEE d MMMM, y',
  ],
  [
    'd.M.y', 'd בMMM y', 'd בMMMM y', 'EEEE, d בMMMM y',
  ],
  [
    'dd. MM. y.', 'd. MMM y.', 'd. MMMM y.', 'EEEE, d. MMMM y.',
  ],
  [
    'd. M. yy.', 'd. MMM y.', 'd. MMMM y.', 'EEEE, d. MMMM y.',
  ],
  [
    'y. MM. dd.', 'y. MMM d.', 'y. MMMM d.', 'y. MMMM d., EEEE',
  ],
  [
    'dd.MM.yy', 'dd MMM, y թ.', 'dd MMMM, y թ.', 'y թ. MMMM d, EEEE',
  ],
  [
    'dd-MM-y', 'd MMM y', 'd \'de\' MMMM y', 'EEEE \'le\' d \'de\' MMMM y',
  ],
  [
    'dd/MM/yy', 'd MMM y', 'd MMMM y', 'EEEE, dd MMMM y',
  ],
  [
    'd.M.y', 'd. MMM y', 'd. MMMM y', 'EEEE, d. MMMM y',
  ],
  [
    'yy/MM/dd', 'yyyy/MM/dd', 'yyyy/MM/dd', 'yyyy\'年\'M\'月\'d\'日\'',
  ],
  [
    'y-MM-dd', 'y MMM d', 'y MMMM d', 'EEEE, y MMMM dd',
  ],
  [
    'dd-MM-y', 'd MMM y', 'd MMMM y', 'EEEE, d MMMM y',
  ],
  [
    'dd.MM.yy', 'd MMM. y', 'd MMMM, y', 'EEEE, dd MMMM, y',
  ],
  [
    'dd/MM/y', 'd MMM y', 'd \'di\' MMMM \'di\' y', 'EEEE, d \'di\' MMMM \'di\' y',
  ],
  [
    'dd.MM.yy', 'y \'ж\'. dd MMM', 'y \'ж\'. d MMMM', 'y \'ж\'. d MMMM, EEEE',
  ],
  [
    'dd/MM y', 'd MMM y', 'd MMMM y', 'EEEE dd MMMM y',
  ],
  [
    'd/M/yy', 'd MMM y', 'd MMMM y', 'EEEE d MMMM y',
  ],
  [
    'd/M/yy', 'MMM d, y', 'MMMM d, y', 'EEEE, MMMM d, y',
  ],
  [
    'd-M-yy', 'd-MMM-y', 'd MMMM y', 'EEEE d MMMM y',
  ],
  [
    'd. M. y', 'd. MMM. y', 'd. MMMM y', 'EEEE, \'dä\' d. MMMM y',
  ],
  [
    'd/M/yy', 'y-\'ж\'., d-MMM', 'y-\'ж\'., d-MMMM', 'y-\'ж\'., d-MMMM, EEEE',
  ],
  [
    'd/M/y', 'd MMM y', 'd MMMM y', 'EEEE ທີ d MMMM G y',
  ],
  [
    'y-MM-dd', 'y-MM-dd', 'y \'m\'. MMMM d \'d\'.', 'y \'m\'. MMMM d \'d\'., EEEE',
  ],
  [
    'dd.MM.yy', 'y. \'gada\' d. MMM', 'y. \'gada\' d. MMMM', 'EEEE, y. \'gada\' d. MMMM',
  ],
  [
    'y-MM-dd', 'y MMM d', 'd MMMM y', 'EEEE d MMMM y',
  ],
  [
    'd.M.yy', 'd.M.y', 'd MMMM y', 'EEEE, d MMMM y',
  ],
  [
    'd/M/yy', 'y, MMM d', 'y, MMMM d', 'y, MMMM d, EEEE',
  ],
  [
    'y.MM.dd', 'y \'оны\' MMM\'ын\' d', 'y \'оны\' MMMM\'ын\' d', 'y \'оны\' MMMM\'ын\' d, EEEE \'гараг\'',
  ],
  [
    'd/M/yy', 'MMM d, y', 'MMMM d, y', 'MMMM d, y, EEEE',
  ],
  [
    'd/MM/yy', 'd MMM y', 'd MMMM y', 'EEEE, d MMMM y',
  ],
  [
    'd/MM/yy', 'd MMM y', 'd MMMM y', 'dd MMMM y',
  ],
  [
    'dd/MM/y', 'dd MMM y', 'd \'ta\'’ MMMM y', 'EEEE, d \'ta\'’ MMMM y',
  ],
  [
    'dd-MM-yy', 'y၊ MMM d', 'y၊ d MMMM', 'y၊ MMMM d၊ EEEE',
  ],
  [
    'yy/M/d', 'y MMM d', 'y MMMM d', 'y MMMM d, EEEE',
  ],
  [
    'dd/MM/yy', 'd MMM, y', '\'lyɛ\'̌ʼ d \'na\' MMMM, y', 'EEEE , \'lyɛ\'̌ʼ d \'na\' MMMM, y',
  ],
  [
    'dd/MM/yy', 'dd-MMM-y', 'dd MMMM y', 'EEEE, MMMM d, y',
  ],
  [
    'dd.MM.yy', 'dd MMM y \'аз\'', 'd MMMM, y \'аз\'', 'EEEE, d MMMM, y \'аз\'',
  ],
  [
    'dd.MM.y', 'd MMM y', 'd MMMM y', 'EEEE, d MMMM y',
  ],
  [
    'y/M/d', 'y MMM d', 'د y د MMMM d', 'EEEE د y د MMMM d',
  ],
  [
    'dd/MM/y', 'd MMM y', 'd MMMM y', 'EEEE, d MMMM, y',
  ],
  [
    'dd-MM-yy', 'dd-MM-y', 'd MMMM y', 'EEEE, \'ils\' d MMMM y',
  ],
  [
    'dd.MM.y', 'd MMM y \'г\'.', 'd MMMM y \'г\'.', 'EEEE, d MMMM y \'г\'.',
  ],
  [
    'yy/M/d', 'y, MMM d', 'y, MMMM d', 'y \'сыл\' MMMM d \'күнэ\', EEEE',
  ],
  [
    'dd.MM.y', 'd MMM y', 'd MMMM y', 'EEEE d MMMM y',
  ],
  [
    'd/M/y', 'd \'de\' MMM \'de\' y', 'd \'de\' MMMM \'de\' y', 'EEEE, d \'de\' MMMM \'de\' y',
  ],
  [
    'd. M. y', 'd. M. y', 'd. MMMM y', 'EEEE d. MMMM y',
  ],
  [
    'd. MM. yy', 'd. MMM y', 'dd. MMMM y', 'EEEE, dd. MMMM y',
  ],
  [
    'd.M.y', 'MMM d. y', 'MMMM d. y', 'EEEE, MMMM d. y',
  ],
  [
    'dd/MM/yy', 'dd-MMM-y', 'dd MMMM y', 'EEEE, MMMM dd, y',
  ],
  [
    'd.M.yy', 'd MMM y', 'd MMMM y', 'EEEE, d MMMM y',
  ],
  [
    'd.M.yy.', 'dd.MM.y.', 'dd. MMMM y.', 'EEEE, dd. MMMM y.',
  ],
  [
    'yy-MM-dd', 'yyyy-MM-dd', 'dd. MMMM yyyy.', 'EEEE, dd. MMMM yyyy.',
  ],
  [
    'd.M.yy.', 'dd.MM.yyyy.', 'dd.MM.yyyy.', 'EEEE, dd.MMMM.yyyy.',
  ],
  [
    'dd-MM-yy', 'd MMM, y', 'd MMMM, y', 'd, MMMM y, EEEE',
  ],
  [
    'd/M/yy', 'd MMM y', 'd MMMM G y', 'EEEEที่ d MMMM G y',
  ],
  [
    'd/M/yy', 'd MMM y', 'd MMMM y', 'EEEEที่ d MMMM GGGG y',
  ],
  [
    'd/M/yyyy', 'd MMM yyyy', 'd MMMM yyyy', 'EEEE\'ที่ \'d MMMM G yyyy',
  ],
  [
    'dd/MM/yy', 'dd-MMM-y', 'dd MMMM y', 'EEEE፣ dd MMMM መዓልቲ y G',
  ],
  [
    'dd.MM.y', 'd MMM y', 'd MMMM y', 'd MMMM y EEEE',
  ],
  [
    'd.MM.y', 'd MMM y', 'd MMMM y', 'd MMMM y EEEE',
  ],
  [
    'dd.MM.y', 'd MMM, y \'ел\'', 'd MMMM, y \'ел\'', 'd MMMM, y \'ел\', EEEE',
  ],
  [
    'y-MM-dd', 'd-MMM، y', 'd-MMMM، y', 'y d-MMMM، EEEE',
  ],
  [
    'dd.MM.yy', 'd MMM y \'р\'.', 'd MMMM y \'р\'.', 'EEEE, d MMMM y \'р\'.',
  ],
  [
    'd/M/yy', 'd MMM، y', 'd MMMM، y', 'EEEE، d MMMM، y',
  ],
  [
    'dd/MM/yy', 'd-MMM, y', 'd-MMMM, y', 'EEEE, d-MMMM, y',
  ],
  [
    'dd/MM/y', 'd MMM, y', 'd MMMM, y', 'EEEE, d MMMM, y',
  ],
  [
    'y-MM-dd', 'd. MMM y', 'd. MMMM y', 'EEEE, d. MMMM y',
  ],
  [
    'dd-MM-y', 'd MMM, y', 'd MMMM, y', 'EEEE, d MMM, y',
  ],
  [
    'dd/MM/yy', 'dטן MMM y', 'dטן MMMM y', 'EEEE, dטן MMMM y',
  ],
  [
    'd/M/y', 'd MM y', 'd MMM y', 'EEEE, d MMM y',
  ],
  [
    'dd/MM/yy', 'dd-MMM-yy', 'dd MMM yyyy', 'dd MMMM yyyy',
  ],
];

/** Time patterns, SHORT to FULL. */
const TIME_PATTERNS: ReadonlyArray<readonly string[]> = [
  [
    'HH:mm', 'HH:mm:ss', 'HH:mm:ss z', 'HH:mm:ss zzzz',
  ],
  [
    'ah:mm', 'ah:mm:ss', 'z ah:mm:ss', 'zzzz ah:mm:ss',
  ],
  [
    'ah:mm', 'ah:mm:ss', 'ah:mm:ss [z]', 'ah:mm:ss [zzzz]',
  ],
  [
    'h:mm a', 'h:mm:ss a', 'h:mm:ss a z', 'h:mm:ss a zzzz',
  ],
  [
    'HH:mm', 'HH:mm:ss', 'HH:mm:ss z', 'H \'h\' mm \'min\' ss \'s\' zzzz',
  ],
  [
    'HH \'h\' mm', 'HH \'h\' mm \'min\' ss \'s\'', 'HH \'h\' mm \'min\' ss \'s\' z',
    'HH \'h\' mm \'min\' ss \'s\' zzzz',
  ],
  [
    'HH:mm', 'HH:mm:ss', 'HH:mm:ss z', 'HH.mm:ss \'h\' zzzz',
  ],
  [
    'H:mm', 'H:mm:ss', 'H:mm:ss z', 'H時mm分ss秒 zzzz',
  ],
  [
    'a h:mm', 'a h:mm:ss', 'a h시 m분 s초 z', 'a h시 m분 s초 zzzz',
  ],
  [
    'H:mm', 'H:mm:ss', 'H:mm:ss z', 'H:mm:ss (zzzz)',
  ],
  [
    'H:mm', 'H:mm:ss', 'H:mm:ss z', 'H:mm:ss zzzz',
  ],
  [
    'a h.mm', 'a h.mm.ss', 'a h.mm.ss z', 'a h.mm.ss zzzz',
  ],
  [
    'HH:mm', 'HH:mm:ss', 'HH:mm:ss z', 'HH:mm:ss, zzzz',
  ],
  [
    'H:mm \'ч\'.', 'H:mm:ss \'ч\'.', 'H:mm:ss \'ч\'. z', 'H:mm:ss \'ч\'. zzzz',
  ],
  [
    'HH.mm', 'HH.mm.ss', 'HH.mm.ss z', 'HH.mm.ss zzzz',
  ],
  [
    'ཆུ་ཚོད་ h སྐར་མ་ mm a', 'ཆུ་ཚོད་h:mm:ss a', 'ཆུ་ཚོད་ h སྐར་མ་ mm:ss a z', 'ཆུ་ཚོད་ h སྐར་མ་ mm:ss a zzzz',
  ],
  [
    'a \'ga\' h:mm', 'a \'ga\' h:mm:ss', 'a \'ga\' h:mm:ss z', 'a \'ga\' h:mm:ss zzzz',
  ],
  [
    'H.mm', 'H.mm.ss', 'H.mm.ss z', 'H.mm.ss zzzz',
  ],
  [
    'HH:mm', 'HH:mm:ss', 'HH:mm:ss z', 'H-\'a\' \'horo\' \'kaj\' m:ss zzzz',
  ],
  [
    'HH:mm', 'HH:mm:ss', 'HH:mm:ss (z)', 'HH:mm:ss (zzzz)',
  ],
  [
    'H:mm', 'H:mm:ss', 'H:mm:ss (z)', 'H:mm:ss (zzzz)',
  ],
  [
    'hh:mm a', 'hh:mm:ss a', 'hh:mm:ss a z', 'hh:mm:ss a zzzz',
  ],
  [
    'HH:mm', 'HH:mm:ss', 'HH:mm:ss z', 'HH:mm:ss (zzzz)',
  ],
  [
    'H:mm \'hodź\'.', 'H:mm:ss', 'H:mm:ss z', 'H:mm:ss zzzz',
  ],
  [
    'H:mm', 'H:mm:ss', 'H:mm:ss z', 'H\'時\'mm\'分\'ss\'秒\' z',
  ],
  [
    'H:mm', 'H:mm:ss', 'H ໂມງ m ນາທີ ss ວິນາທີ z', 'H ໂມງ m ນາທີ ss ວິນາທີ zzzz',
  ],
  [
    'a H:mm', 'a HH:mm:ss', 'z HH:mm:ss', 'zzzz HH:mm:ss',
  ],
  [
    'HH:mm', 'HH:mm:ss', 'HH:mm:ss z', '\'kl\'. HH:mm:ss zzzz',
  ],
  [
    'h:mm a', 'h:mm:ss a', 'z h:mm:ss a', 'zzzz h:mm:ss a',
  ],
  [
    'HH:mm', 'HH:mm:ss', 'H:mm:ss z', 'HH:mm:ss zzzz',
  ],
  [
    'h:mm a', 'h:mm:ss a', 'h:mm:ss a, z', 'h:mm:ss a, zzzz',
  ],
  [
    'HH:mm', 'HH:mm:ss', 'HH.mm.ss z', 'HH \'часова\', mm \'минута\', ss\' секунди\'',
  ],
  [
    'HH.mm', 'HH.mm.ss', 'HH.mm.ss z', 'HH.mm.ss z',
  ],
  [
    'a h:mm', 'a h:mm:ss', 'a h:mm:ss z', 'a h:mm:ss zzzz',
  ],
  [
    'HH:mm', 'HH:mm:ss', 'H นาฬิกา mm นาที ss วินาที z', 'H นาฬิกา mm นาที ss วินาที zzzz',
  ],
  [
    'H:mm\' น.\'', 'H:mm:ss', 'H\' นาฬิกา \'m\' นาที\'', 'H\' นาฬิกา \'m\' นาที \'ss\' วินาที\'',
  ],
  [
    'HH:mm', 'HH:mm:ss', 'H:mm:ss (z)', 'H:mm:ss (zzzz)',
  ],
  [
    'H:m', 'H:m:s', 'H:mm:ss z', 'HH:mm:ss zzzz',
  ],
  [
    'a hh:mm', 'a hh:mm', 'a hh:mm:ss', 'a hh:mm:ss',
  ],
];

/** Month names, January first; months '|'-separated, a month's names '~'-separated. */
const MONTHS: readonly string[] = [
  'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec',
  '1月~一月|2月~二月|3月~三月|4月~四月|5月~五月|6月~六月|7月~七月|8月~八月|9月~九月|10月~十月|11月~十一月|12月~十二月',
  '1月|2月|3月|4月|5月|6月|7月|8月|9月|10月|11月|12月',
  'jan.~januari|feb.~februari|maart~mrt.|apr.~april|mei|jun.~juni|jul.~juli|aug.~augustus|sep.~september|okt.~o' +
    'ktober|nov.~november|dec.~december',
  'Jan~January|Feb~February|Mar~March|Apr~April|May|June|July|Aug~August|Sept~September|Oct~October|Nov~Novembe' +
    'r|Dec~December',
  'Jan.~January|Feb.~February|Mar.~March|Apr.~April|May|Jun.~June|Jul.~July|Aug.~August|Sep.~September|Oct.~Oct' +
    'ober|Nov.~November|Dec.~December',
  'Jan~January|Feb~February|Mar~March|Apr~April|May|Jun~June|Jul~July|Aug~August|Sep~September|Oct~October|Nov~' +
    'November|Dec~December',
  'Jan~January|Feb~February|Mar~March|Apr~April|May|Jun~June|Jul~July|Aug~August|Sept~September|Oct~October|Nov' +
    '~November|Dec~December',
  'janv.~janvier|févr.~février|mars|avr.~avril|mai|juin|juil.~juillet|août|sept.~septembre|oct.~octobre|nov.~no' +
    'vembre|déc.~décembre',
  'janv.~janvier|févr.~février|mars|avr.~avril|mai|juin|juill.~juillet|août|sept.~septembre|oct.~octobre|nov.~n' +
    'ovembre|déc.~décembre',
  'Jän.~Jänner|Feb.~Februar|März|Apr.~April|Mai|Juni|Juli|Aug.~August|Sep.~September|Okt.~Oktober|Nov.~November' +
    '|Dez.~Dezember',
  'Jan.~Januar|Feb.~Februar|März|Apr.~April|Mai|Juni|Juli|Aug.~August|Sept.~September|Okt.~Oktober|Nov.~Novembe' +
    'r|Dez.~Dezember',
  'gen~gennaio|feb~febbraio|mar~marzo|apr~aprile|mag~maggio|giu~giugno|lug~luglio|ago~agosto|set~settembre|ott~' +
    'ottobre|nov~novembre|dic~dicembre',
  '1월|2월|3월|4월|5월|6월|7월|8월|9월|10월|11월|12월',
  'jan.~januar|feb.~februar|mar.~mars|apr.~april|mai|jun.~juni|jul.~juli|aug.~august|sep.~september|okt.~oktobe' +
    'r|nov.~november|des.~desember',
  'jan.~janeiro|fev.~fevereiro|mar.~março|abr.~abril|mai.~maio|jun.~junho|jul.~julho|ago.~agosto|set.~setembro|' +
    'out.~outubro|nov.~novembro|dez.~dezembro',
  'ene.~enero|feb.~febrero|mar.~marzo|abr.~abril|may.~mayo|jun.~junio|jul.~julio|ago.~agosto|sep.~septiembre|oc' +
    't.~octubre|nov.~noviembre|dic.~diciembre',
  'ene~enero|feb~febrero|mar~marzo|abr~abril|may~mayo|jun~junio|jul~julio|ago~agosto|sept~septiembre|oct~octubr' +
    'e|nov~noviembre|dic~diciembre',
  'jan.~januari|feb.~februari|mars|apr.~april|maj|juni|juli|aug.~augusti|sep.~september|okt.~oktober|nov.~novem' +
    'ber|dec.~december',
  'Jan.~Januarie|Feb.~Februarie|Maart~Mrt.|Apr.~April|Mei|Jun.~Junie|Jul.~Julie|Aug.~Augustus|Sep.~September|Ok' +
    't.~Oktober|Nov.~November|Des.~Desember',
  'ndzɔ̀ŋɔ̀nùm~nùm|kɨz~ndzɔ̀ŋɔ̀kƗ̀zùʔ|ndzɔ̀ŋɔ̀tƗ̀dʉ̀ghà~tɨd|ndzɔ̀ŋɔ̀tǎafʉ̄ghā~taa|ndzɔ̀ŋèsèe~see|ndzɔ̀ŋɔ̀nzùghò' +
    '~nzu|dum~ndzɔ̀ŋɔ̀dùmlo|fɔe~ndzɔ̀ŋɔ̀kwîfɔ̀e|dzu~ndzɔ̀ŋɔ̀tƗ̀fʉ̀ghàdzughù|lɔm~ndzɔ̀ŋɔ̀ghǔuwelɔ̀m|kaa~ndzɔ̀ŋɔ̀ch' +
    'waʔàkaa wo|fwo~ndzɔ̀ŋèfwòo',
  'S-Ɔ~Sanda-Ɔpɛpɔn|K-Ɔ~Kwakwar-Ɔgyefuo|E-Ɔ~Ebɔw-Ɔbenem|E-O~Ebɔbira-Oforisuo|E-K~Esusow Aketseaba-Kɔtɔnimba|O-A' +
    '~Obirade-Ayɛwohomumu|A-K~Ayɛwoho-Kitawonsa|D-Ɔ~Difuu-Ɔsandaa|F-Ɛ~Fankwa-Ɛbɔ|Ɔ-A~Ɔbɛsɛ-Ahinime|Ɔ-O~Ɔberɛfɛw-O' +
    'bubuo|M-Ɔ~Mumu-Ɔpɛnimba',
  'ጃንዩ~ጃንዩወሪ|ፌብሩ~ፌብሩወሪ|ማርች|ኤፕሪ~ኤፕሪል|ሜይ|ጁን|ጁላይ|ኦገስ~ኦገስት|ሴፕቴ~ሴፕቴምበር|ኦክቶ~ኦክቶበር|ኖቬም~ኖቬምበር|ዲሴም~ዲሴምበር',
  'يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر',
  'جانفي|فيفري|مارس|أفريل|ماي|جوان|جويلية|أوت|سبتمبر|أكتوبر|نوفمبر|ديسمبر',
  'كانون الثاني|شباط|آذار|نيسان|أيار|حزيران|تموز|آب|أيلول|تشرين الأول~تشرين\u00a0الأول|تشرين الثاني|كانون الأول',
  'كانون الثاني|شباط|آذار|نيسان|أيار|حزيران|تموز|آب|أيلول|تشرين الأول|تشرين الثاني|كانون الأول',
  'يناير|فبراير|مارس|أبريل|ماي|يونيو|يوليوز|غشت|شتنبر|أكتوبر|نونبر|دجنبر',
  'يناير|فبراير|مارس|إبريل|مايو|يونيو|يوليو|أغشت|شتمبر|أكتوبر|نوفمبر|دجمبر',
  'জানু~জানুৱাৰী|ফেব্ৰু~ফেব্ৰুৱাৰী|মাৰ্চ|এপ্ৰিল|মে’|জুন|জুলাই|আগ~আগষ্ট|ছেপ্তে~ছেপ্তেম্বৰ|অক্টো~অক্টোবৰ|নৱে~নৱেম' +
    '্বৰ|ডিচে~ডিচেম্বৰ',
  'Jan~Januari|Feb~Februari|Mac~Machi|Apr~Aprili|Mei|Jun~Juni|Jul~Julai|Ago~Agosti|Sep~Septemba|Okt~Oktoba|Nov~' +
    'Novemba|Dec~Desemba',
  'de xineru~xin|de febreru~feb|de marzu~mar|abr~d’abril|de mayu~may|de xunu~xun|de xunetu~xnt|ago~d’agostu|de ' +
    'setiembre~set|d’ochobre~och|de payares~pay|avi~d’avientu',
  'yan~yanvar|fev~fevral|mar~mart|apr~aprel|may|iyn~iyun|iyl~iyul|avq~avqust|sen~sentyabr|okt~oktyabr|noy~noyab' +
    'r|dek~dekabr',
  'Kɔndɔŋ~kɔn|Màcɛ̂l~mac|Màtùmb~mat|Màtop~mto|M̀puyɛ~mpu|Hìlòndɛ̀~hil|Njèbà~nje|Hìkaŋ~hik|Dìpɔ̀s~dip|Bìòôm~bio|' +
    'Màyɛsèp~may|Lìbuy li ńyèe~liɓ',
  'сту~студзеня|лют~лютага|сак~сакавіка|кра~красавіка|мая|чэр~чэрвеня|ліп~ліпеня|жні~жніўня|вер~верасня|кас~кас' +
    'трычніка|ліс~лістапада|сне~снежня',
  'Jan~Januari|Feb~Februari|Mac~Machi|Epr~Epreo|Mei|Jun~Juni|Jul~Julai|Oga~Ogasti|Sep~Septemba|Okt~Oktoba|Nov~N' +
    'ovemba|Dis~Disemba',
  'Hut~pa mwedzi gwa hutala|Vil~pa mwedzi gwa wuvili|Dat~pa mwedzi gwa wudatu|Tai~pa mwedzi gwa wutai|Han~pa mw' +
    'edzi gwa wuhanu|Sit~pa mwedzi gwa sita|Sab~pa mwedzi gwa saba|Nan~pa mwedzi gwa nane|Tis~pa mwedzi gwa tisa|' +
    'Kum~pa mwedzi gwa kumi|Kmj~pa mwedzi gwa kumi na moja|Kmb~pa mwedzi gwa kumi na mbili',
  'яну~януари|фев~февруари|март|апр~април|май|юни|юли|авг~август|сеп~септември|окт~октомври|ное~ноември|дек~дек' +
    'ември',
  'zan~zanwuye|feb~feburuye|mar~marisi|awi~awirili|mɛ|zuw~zuwɛn|zul~zuluye|uti|sɛt~sɛtanburu|ɔku~ɔkutɔburu|now~' +
    'nowanburu|des~desanburu',
  'জানু~জানুয়ারী|ফেব~ফেব্রুয়ারী|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|অক্টোবর|নভেম্বর|ডিসেম্বর',
  'ཟླ་༡~ཟླ་བ་དང་པོ|ཟླ་༢~ཟླ་བ་གཉིས་པ|ཟླ་༣~ཟླ་བ་གསུམ་པ|ཟླ་༤~ཟླ་བ་བཞི་པ|ཟླ་༥~ཟླ་བ་ལྔ་པ|ཟླ་༦~ཟླ་བ་དྲུག་པ|ཟླ་༧~ཟླ་བ་' +
    'བདུན་པ|ཟླ་༨~ཟླ་བ་བརྒྱད་པ|ཟླ་༩~ཟླ་བ་དགུ་པ|ཟླ་༡༠~ཟླ་བ་བཅུ་པ|ཟླ་༡༡~ཟླ་བ་བཅུ་གཅིག་པ|ཟླ་༡༢~ཟླ་བ་བཅུ་གཉིས་པ',
  'Gen.~Genver|Cʼhwe.~Cʼhwevrer|Meur.~Meurzh|Ebr.~Ebrel|Mae|Mezh.~Mezheven|Goue.~Gouere|Eost|Gwen.~Gwengolo|Her' +
    'e|Du|Kerzu~Kzu.',
  'जानुवारी|फेब्रुवारी|मार्स|एफ्रिल|मे|जुन|जुलाइ|आगस्थ|सेबथेज्ब़र|अखथबर|नबेज्ब़र|दिसेज्ब़र',
  'jan~januar|feb~februar|mar~mart|apr~april|maj|jun~juni|jul~juli|aug~august|sep~septembar|okt~oktobar|nov~nov' +
    'embar|dec~decembar',
  'de gen.~de gener|de febr.~de febrer|de març|d’abr.~d’abril|de maig|de juny|de jul.~de juliol|d’ag.~d’agost|d' +
    'e set.~de setembre|d’oct.~d’octubre|de nov.~de novembre|de des.~de desembre',
  '𑄎𑄚𑄪~𑄎𑄚𑄪𑄠𑄢𑄨|𑄜𑄬𑄛𑄴~𑄜𑄬𑄛𑄴𑄝𑄳𑄢𑄪𑄠𑄢𑄨|𑄟𑄢𑄴𑄌𑄧|𑄃𑄬𑄛𑄳𑄢𑄨𑄣𑄴|𑄟𑄬|𑄎𑄪𑄚𑄴|𑄎𑄪𑄣𑄭|𑄃𑄉' +
    '𑄧𑄌𑄴𑄑𑄴|𑄥𑄬𑄛𑄴𑄑𑄬𑄟𑄴𑄝𑄧𑄢𑄴|𑄃𑄧𑄇𑄴𑄑𑄬𑄝𑄧𑄢𑄴~𑄃𑄧𑄇𑄴𑄑𑄮𑄝𑄧𑄢𑄴|𑄚𑄧𑄞𑄬𑄟𑄴𑄝𑄧𑄢𑄴|𑄓𑄨𑄥𑄬' +
    '𑄟𑄴𑄝𑄢𑄴~𑄓𑄨𑄥𑄬𑄟𑄴𑄝𑄧𑄢𑄴',
  'янв~январь|фев~февраль|мар~март|апр~апрель|май|июн~июнь|июл~июль|авг~август|сен~сентябрь|окт~октябрь|ноя~ноя' +
    'брь|дек~декабрь',
  'Ene~Enero|Peb~Pebrero|Mar~Marso|Abr~Abril|May~Mayo|Hun~Hunyo|Hul~Hulyo|Ago~Agosto|Set~Setyembre|Okt~Oktubre|' +
    'Nob~Nobyembre|Dis~Disyembre',
  'KBZ~Okwokubanza|KBR~Okwakabiri|KST~Okwakashatu|KKN~Okwakana|KTN~Okwakataana|KMK~Okwamukaaga|KMS~Okwamushanju' +
    '|KMN~Okwamunaana|KMW~Okwamwenda|KKM~Okwaikumi|KNK~Okwaikumi na kumwe|KNB~Okwaikumi na ibiri',
  'ᎤᏃ~ᎤᏃᎸᏔᏅ|ᎧᎦ~ᎧᎦᎵ|ᎠᏅ~ᎠᏅᏱ|ᎧᏬ~ᎧᏬᏂ|ᎠᏂ~ᎠᏂᏍᎬᏘ|ᏕᎭ~ᏕᎭᎷᏱ|ᎫᏰ~ᎫᏰᏉᏂ|ᎦᎶ~ᎦᎶᏂ|ᏚᎵ~ᏚᎵᏍᏗ|ᏚᏂ~ᏚᏂᏅᏗ|ᏅᏓ~ᏅᏓᏕᏆ|ᎥᏍ~ᎥᏍᎩᏱ',
  'کانوونی دووەم|شوبات|ئازار|نیسان|ئایار|حوزەیران|تەمووز|ئاب|ئەیلوول|تشرینی یەکەم|تشرینی دووەم|کانونی یەکەم',
  'led~ledna|úno~února|bře~března|dub~dubna|kvě~května|června~čvn|července~čvc|srp~srpna|zář~září|říj~října|lis' +
    '~listopadu|pro~prosince',
  'Ion~Ionawr|Chwef~Chwefror|Maw~Mawrth|Ebr~Ebrill|Mai|Meh~Mehefin|Gorff~Gorffennaf|Awst|Medi|Hyd~Hydref|Tach~T' +
    'achwedd|Rhag~Rhagfyr',
  'jan.~januar|feb.~februar|mar.~marts|apr.~april|maj|jun.~juni|jul.~juli|aug.~august|sep.~september|okt.~oktob' +
    'er|nov.~november|dec.~december',
  'Imb~Mori ghwa imbiri|Kaw~Mori ghwa kawi|Kad~Mori ghwa kadadu|Kan~Mori ghwa kana|Kas~Mori ghwa kasanu|Kar~Mor' +
    'i ghwa karandadu|Mfu~Mori ghwa mfungade|Mori ghwa wunyanya~Wun|Ike~Mori ghwa ikenda|Iku~Mori ghwa ikumi|Imw~' +
    'Mori ghwa ikumi na imweri|Iwi~Mori ghwa ikumi na iwi',
  'Žan~Žanwiye|Fee~Feewiriye|Mar~Marsi|Awi~Awiril|Me|Žuw~Žuweŋ|Žuy~Žuyye|Ut|Sek~Sektanbur|Okt~Oktoobur|Noo~Noow' +
    'anbur|Dee~Deesanbur',
  'जन.~जनवरी|फर.~फरवरी|मार्च|अप्रैल|मेई|जून|जुलाई|अग.~अगस्त|सित.~सितंबर|अक्तू.~अत्तूबर|नव.~नवंबर|दिस.~दिसंबर',
  'jan.~januara|feb.~februara|měr.~měrca|apr.~apryla|maj.~maja|jun.~junija|jul.~julija|awg.~awgusta|sep.~septem' +
    'bra|okt.~oktobra|now.~nowembra|dec.~decembra',
  'di~dimɔ́di|ŋgɔn~ŋgɔndɛ|sɔŋ~sɔŋɛ|diɓ~diɓáɓá|emi~emiasele|esɔ~esɔpɛsɔpɛ|mad~madiɓɛ́díɓɛ́|diŋ~diŋgindi|nyɛt~nyɛ' +
    'tɛki|may~mayésɛ́|tin~tiníní|elá~eláŋgɛ́',
  'Sa~Sanvie|Fe~Fébirie|Ma~Mars|Ab~Aburil|Me~Mee|Su~Sueŋ|Sú~Súuyee|Ut|Se~Settembar|Ok~Oktobar|No~Novembar|De~Di' +
    'sambar',
  '༡~ཟླ་དངཔ་|༢~ཟླ་གཉིས་པ་|༣~ཟླ་གསུམ་པ་|༤~ཟླ་བཞི་པ་|༥~ཟླ་ལྔ་པ་|༦~ཟླ་དྲུག་པ|༧~ཟླ་བདུན་པ་|༨~ཟླ་བརྒྱད་པ་|༩~ཟླ་དགུ་པ' +
    '་|༡༠~ཟླ་བཅུ་པ་|༡༡~ཟླ་བཅུ་གཅིག་པ་|12~ཟླ་བཅུ་གཉིས་པ་',
  'Mbe~Mweri wa mbere|Kai~Mweri wa kaĩri|Kat~Mweri wa kathatũ|Kan~Mweri wa kana|Gat~Mweri wa gatano|Gan~Mweri w' +
    'a gatantatũ|Mug~Mweri wa mũgwanja|Knn~Mweri wa kanana|Ken~Mweri wa kenda|Iku~Mweri wa ikũmi|Imw~Mweri wa ikũ' +
    'mi na ũmwe|Igi~Mweri wa ikũmi na Kaĩrĩ',
  'dzove~dzv|dzd~dzodze|ted~tedoxe|afɔ~afɔfĩe|dam~dama|mas~masa|sia~siamlɔm|dea~deasiamime|any~anyɔnyɔ|kel~kele' +
    '|ade~adeɛmekpɔxe|dzm~dzome',
  'Ιαν~Ιανουαρίου|Φεβ~Φεβρουαρίου|Μαρ~Μαρτίου|Απρ~Απριλίου|Μαΐ~Μαΐου|Ιουν~Ιουνίου|Ιουλ~Ιουλίου|Αυγ~Αυγούστου|Σε' +
    'π~Σεπτεμβρίου|Οκτ~Οκτωβρίου|Νοε~Νοεμβρίου|Δεκ~Δεκεμβρίου',
  'jan~januaro|feb~februaro|mar~marto|apr~aprilo|maj~majo|jun~junio|jul~julio|aŭg~aŭgusto|sep~septembro|okt~okt' +
    'obro|nov~novembro|dec~decembro',
  'ene.~enero|feb.~febrero|mar.~marzo|abr.~abril|may.~mayo|jun.~junio|jul.~julio|ago.~agosto|set.~setiembre|oct' +
    '.~octubre|nov.~noviembre|dic.~diciembre',
  'ene.~enero|feb.~febrero|mar.~marzo|abr.~abril|may.~mayo|jun.~junio|jul.~julio|ago.~agosto|sept.~septiembre|o' +
    'ct.~octubre|nov.~noviembre|dic.~diciembre',
  'jaan~jaanuar|veebr~veebruar|märts|apr~aprill|mai|juuni|juuli|aug~august|sept~september|okt~oktoober|nov~nove' +
    'mber|dets~detsember',
  'urt.~urtarrilak|ots.~otsailak|mar.~martxoak|api.~apirilak|mai.~maiatzak|eka.~ekainak|uzt.~uztailak|abu.~abuz' +
    'tuak|ira.~irailak|urr.~urriak|aza.~azaroak|abe.~abenduak',
  'ngo~ngɔn osú|ngb~ngɔn bɛ̌|ngl~ngɔn lála|ngn~ngɔn nyina|ngt~ngɔn tána|ngs~ngɔn saməna|ngz~ngɔn zamgbála|ngm~n' +
    'gɔn mwom|nge~ngɔn ebulú|nga~ngɔn awóm|ngad~ngɔn awóm ai dziá|ngab~ngɔn awóm ai bɛ̌',
  'ژانویهٔ|فوریهٔ|مارس|آوریل|مهٔ|ژوئن|ژوئیهٔ|اوت|سپتامبر|اکتبر|نوامبر|دسامبر',
  'جنو~جنوری|فبروری|مارچ|اپریل|می|جون|جول~جولای|اگست|سپتمبر|اکتوبر|نومبر|دسم~دسمبر',
  'sii~siilo|col~colte|mbo~mbooy|see~seeɗto|duu~duujal|kor~korse|mor~morso|juk~juko|siilto~slt|yar~yarkomaa|jol' +
    '~jolal|bow~bowte',
  'tammik.~tammikuuta|helmik.~helmikuuta|maalisk.~maaliskuuta|huhtik.~huhtikuuta|toukok.~toukokuuta|kesäk.~kesä' +
    'kuuta|heinäk.~heinäkuuta|elok.~elokuuta|syysk.~syyskuuta|lokak.~lokakuuta|marrask.~marraskuuta|jouluk.~joulu' +
    'kuuta',
  'jan.~januar|feb.~februar|mar.~mars|apr.~apríl|mai|jun.~juni|jul.~juli|aug.~august|sep.~september|okt.~oktobe' +
    'r|nov.~november|des.~desember',
  'jan.~janvier|fév.~février|mar.~mars|avr.~avril|mai|jui.~juin|juil.~juillet|août|sept.~septembre|oct.~octobre' +
    '|nov.~novembre|déc.~décembre',
  'Zen~Zenâr|Fev~Fevrâr|Mar~Març|Avr~Avrîl|Mai|Jug~Jugn|Lui|Avo~Avost|Set~Setembar|Otu~Otubar|Nov~Novembar|Dic~' +
    'Dicembar',
  'Jan~Jannewaris|Feb~Febrewaris|Maart~Mrt|Apr~April|Maaie~Mai|Jun~Juny|Jul~July|Aug~Augustus|Sep~Septimber|Okt' +
    '~Oktober|Nov~Novimber|Des~Desimber',
  'Ean~Eanáir|Feabh~Feabhra|Márta|Aib~Aibreán|Beal~Bealtaine|Meith~Meitheamh|Iúil|Lún~Lúnasa|MFómh~Meán Fómhair' +
    '|DFómh~Deireadh Fómhair|Samh~Samhain|Noll~Nollaig',
  'Faoi~dhen Fhaoilleach|Gearr~dhen Ghearran|Màrt~dhen Mhàrt|Gibl~dhen Ghiblean|Cèit~dhen Chèitean|dhen Ògmhios' +
    '~Ògmh|Iuch~dhen Iuchar|Lùna~dhen Lùnastal|Sult~dhen t-Sultain|Dàmh~dhen Dàmhair|Samh~dhen t-Samhain|Dùbh~dhe' +
    'n Dùbhlachd',
  'xan.~xaneiro|feb.~febreiro|mar.~marzo|abr.~abril|maio|xuño|xul.~xullo|ago.~agosto|set.~setembro|out.~outubro' +
    '|nov.~novembro|dec.~decembro',
  'Jan~Januar|Feb~Februar|Mär~März|Apr~April|Mai|Jun~Juni|Jul~Juli|Aug~Auguscht|Sep~Septämber|Okt~Oktoober|Nov~' +
    'Novämber|Dez~Dezämber',
  'જાન્યુ~જાન્યુઆરી|ફેબ્રુ~ફેબ્રુઆરી|માર્ચ|એપ્રિલ|મે|જૂન|જુલાઈ|ઑગસ્ટ|સપ્ટે~સપ્ટેમ્બર|ઑક્ટો~ઑક્ટોબર|નવે~નવેમ્બર|' +
    'ડિસે~ડિસેમ્બર',
  'Can~Chanuari|Feb~Feburari|Mac~Machi|Apiriri~Apr|Mei|Jun~Juni|Chulai~Cul|Agosti~Agt|Sep~Septemba|Okitoba~Okt|' +
    'Nob~Nobemba|Dis~Disemba',
  'J-guer~Jerrey-geuree|T-arree~Toshiaght-arree|Mayrnt|Averil~Avrril|Boaldyn|M-souree~Mean-souree|J-souree~Jerr' +
    'ey-souree|Luanistyn|M-fouyir~Mean-fouyir|J-fouyir~Jerrey-fouyir|M-Houney~Mee Houney|M-Nollick~Mee ny Nollick',
  'Jan~Janairu|Fab~Faburairu|Mar~Maris|Afi~Afirilu|May~Mayu|Yun~Yuni|Yul~Yuli|Agu~Agusta|Sat~Satumba|Okt~Oktoba' +
    '|Nuw~Nuwamba|Dis~Disamba',
  'Ian.~Ianuali|Pep.~Pepeluali|Mal.~Malaki|ʻAp.~ʻApelila|Mei|Iun.~Iune|Iul.~Iulai|ʻAu.~ʻAukake|Kep.~Kepakemapa|' +
    'ʻOk.~ʻOkakopa|Now.~Nowemapa|Kek.~Kekemapa',
  'ינואר~ינו׳|פברואר~פבר׳|מרץ|אפריל~אפר׳|מאי|יוני|יולי|אוגוסט~אוג׳|ספטמבר~ספט׳|אוקטובר~אוק׳|נובמבר~נוב׳|דצמבר~ד' +
    'צמ׳',
  'जनवरी~जन॰|फ़रवरी~फ़र॰|मार्च|अप्रैल|मई|जून|जुलाई~जुल॰|अगस्त~अग॰|सितंबर~सित॰|अक्तूबर~अक्तू॰|नवंबर~नव॰|दिसंबर~द' +
    'िस॰',
  'sij~siječnja|velj~veljače|ožu~ožujka|tra~travnja|svi~svibnja|lip~lipnja|srp~srpnja|kol~kolovoza|ruj~rujna|li' +
    's~listopada|stu~studenoga|pro~prosinca',
  'jan.~januara|feb.~februara|měr.~měrca|apr.~apryla|mej.~meje|jun.~junija|jul.~julija|awg.~awgusta|sep.~septem' +
    'bra|okt.~oktobra|now.~nowembra|dec.~decembra',
  'jan.~január|febr.~február|márc.~március|ápr.~április|máj.~május|jún.~június|júl.~július|aug.~augusztus|szept' +
    '.~szeptember|okt.~október|nov.~november|dec.~december',
  'հնվ~հունվարի|փետրվարի~փտվ|մարտի~մրտ|ապր~ապրիլի|մայիսի~մյս|հնս~հունիսի|հլս~հուլիսի|օգոստոսի~օգս|սեպ~սեպտեմբեր' +
    'ի|հոկ~հոկտեմբերի|նոյ~նոյեմբերի|դեկ~դեկտեմբերի',
  'jan~januario|feb~februario|mar~martio|apr~april|mai~maio|jun~junio|jul~julio|aug~augusto|sep~septembre|oct~o' +
    'ctobre|nov~novembre|dec~decembre',
  'Jan~Januari|Feb~Februari|Mar~Maret|Apr~April|Mei|Jun~Juni|Jul~Juli|Agu~Agustus|Sep~September|Okt~Oktober|Nov' +
    '~November|Des~Desember',
  'Jen~Jenụwarị|Feb~Febrụwarị|Maa~Maachị|Epr~Epreel|Mee|Juu~Juun|Jul~Julaị|Ọgọ~Ọgọọst|Sep~Septemba|Ọkt~Ọktoba|N' +
    'ov~Novemba|Dis~Disemba',
  'ꋍꆪ|ꑍꆪ|ꌕꆪ|ꇖꆪ|ꉬꆪ|ꃘꆪ|ꏃꆪ|ꉆꆪ|ꈬꆪ|ꊰꆪ|ꊰꊪꆪ|ꊰꑋꆪ',
  'jan.~janúar|feb.~febrúar|mar.~mars|apr.~apríl|maí|jún.~júní|júl.~júlí|ágú.~ágúst|sep.~september|okt.~október' +
    '|nóv.~nóvember|des.~desember',
  '1~1月|2~2月|3~3月|4~4月|5~5月|6~6月|7~7月|8~8月|9~9月|10~10月|11~11月|12~12月',
  'Nduŋmbi Saŋ|Pɛsaŋ Pɛ́pá|Pɛsaŋ Pɛ́tát|Pɛsaŋ Pɛ́nɛ́kwa|Pɛsaŋ Pataa|Pɛsaŋ Pɛ́nɛ́ntúkú|Pɛsaŋ Saambá|Pɛsaŋ Pɛ́nɛ́' +
    'fɔm|Pɛsaŋ Pɛ́nɛ́pfúꞋú|Pɛsaŋ Nɛgɛ́m|Pɛsaŋ Ntsɔ̌pmɔ́|Pɛsaŋ Ntsɔ̌ppá',
  'Jan~Januari|Feb~Februari|Mac~Machi|Apr~Aprilyi|Mei|Jun~Junyi|Jul~Julyai|Ago~Agusti|Sep~Septemba|Okt~Oktoba|N' +
    'ov~Novemba|Des~Desemba',
  'Jan~Januari|Feb~Februari|Mar~Maret|Apr~April|Mei|Jun~Juni|Jul~Juli|Agt~Agustus|Sep~September|Okt~Oktober|Nov' +
    '~November|Des~Desember',
  'იან~იანვარი|თებ~თებერვალი|მარ~მარტი|აპრ~აპრილი|მაი~მაისი|ივნ~ივნისი|ივლ~ივლისი|აგვ~აგვისტო|სექ~სექტემბერი|ოქ' +
    'ტ~ოქტომბერი|ნოე~ნოემბერი|დეკ~დეკემბერი',
  'Yen~Yennayer|Fur~Fuṛar|Meɣ~Meɣres|Yeb~Yebrir|May~Mayyu|Yun~Yunyu|Yul~Yulyu|Ɣuc~Ɣuct|Cte~Ctembeṛ|Tub~Tubeṛ|Nu' +
    'n~Nunembeṛ|Duǧ~Duǧembeṛ',
  'Mbe~Mwai wa mbee|Kel~Mwai wa kelĩ|Ktũ~Mwai wa katatũ|Kan~Mwai wa kana|Ktn~Mwai wa katano|Mwai wa thanthatũ~T' +
    'ha|Moo~Mwai wa muonza|Mwai wa nyaanya~Nya|Knd~Mwai wa kenda|Mwai wa ĩkumi~Ĩku|Mwai wa ĩkumi na ĩmwe~Ĩkm|Mwai' +
    ' wa ĩkumi na ilĩ~Ĩkl',
  'Jan~Mwedi Ntandi|Feb~Mwedi wa Pili|Mac~Mwedi wa Tatu|Apr~Mwedi wa Nchechi|Mei~Mwedi wa Nnyano|Jun~Mwedi wa N' +
    'nyano na Umo|Jul~Mwedi wa Nnyano na Mivili|Ago~Mwedi wa Nnyano na Mitatu|Mwedi wa Nnyano na Nchechi~Sep|Mwed' +
    'i wa Nnyano na Nnyano~Okt|Mwedi wa Nnyano na Nnyano na U~Nov|Des~Mwedi wa Nnyano na Nnyano na M',
  'Jan~Janeru|Feb~Febreru|Mar~Marsu|Abr~Abril|Mai~Maiu|Jun~Junhu|Jul~Julhu|Ago~Agostu|Set~Setenbru|Otu~Otubru|N' +
    'uv~Nuvenbru|Diz~Dizenbru',
  'JEN~Njenuarĩ|Mwere wa kerĩ~WKR|Mwere wa gatatũ~WGT|Mwere wa kana~WKN|Mwere wa gatano~WTN|Mwere wa gatandatũ~' +
    'WTD|Mwere wa mũgwanja~WMJ|Mwere wa kanana~WNN|Mwere wa kenda~WKD|Mwere wa ikũmi~WIK|Mwere wa ikũmi na ũmwe~W' +
    'MW|DIT~Ndithemba',
  'қаң.~қаңтар|ақп.~ақпан|нау.~наурыз|сәу.~сәуір|мам.~мамыр|мау.~маусым|шіл.~шілде|там.~тамыз|қыр.~қыркүйек|қаз' +
    '.~қазан|қар.~қараша|жел.~желтоқсан',
  'pamba|wanja|mbiyɔ mɛndoŋgɔ|Nyɔlɔmbɔŋgɔ|Mɔnɔ ŋgbanja|Nyaŋgwɛ ŋgbanja|kuŋgwɛ|fɛ|njapi|nyukul|M11|ɓulɓusɛ',
  'jan~januaarip|febr~februaarip|mar~marsip|apr~apriilip|maajip~maj|jun~juunip|jul~juulip|aggustip~aug|sept~sep' +
    'tembarip|okt~oktobarip|nov~novembarip|dec~decembarip',
  'Mul~Mulgul|Ngat~Ng’atyaato|Kiptaamo~Taa|Iwo~Iwootkuut|Mam~Mamuut|Paa~Paagi|Nge~Ng’eiyeet|Roo~Rooptui|Bur~Bur' +
    'eet|Epe~Epeeso|Kipsuunde ne taai~Kpt|Kipsuunde nebo aeng’~Kpa',
  'មករា|កុម្ភៈ|មីនា|មេសា|ឧសភា|មិថុនា|កក្កដា|សីហា|កញ្ញា|តុលា|វិច្ឆិកា|ធ្នូ',
  'ಜನವರಿ|ಫೆಬ್ರವರಿ|ಮಾರ್ಚ್|ಏಪ್ರಿ~ಏಪ್ರಿಲ್|ಮೇ|ಜೂನ್|ಜುಲೈ|ಆಗ~ಆಗಸ್ಟ್|ಸೆಪ್ಟೆಂ~ಸೆಪ್ಟೆಂಬರ್|ಅಕ್ಟೋ~ಅಕ್ಟೋಬರ್|ನವೆಂ~ನವೆಂಬರ್|ಡಿ' +
    'ಸೆಂ~ಡಿಸೆಂಬರ್',
  'जानेवारी|फेब्रुवारी|मार्च|एप्रील|मे|जून|जुलय|ऑगस्ट|सप्टेंबर|ऑक्टोबर|नोव्हेंबर|डिसेंबर',
  'جنؤری|فرؤری|مارٕچ|اپریل|میٔ|جوٗن|جوٗلایی|اگست|ستمبر|اکتوٗبر|نومبر|دسمبر',
  'Jan~Januali|Feb~Febluali|Mac~Machi|Aplili~Apr|Mei|Jun~Juni|Jul~Julai|Ago~Agosti|Sep~Septemba|Okt~Oktoba|Nov~' +
    'Novemba|Des~Desemba',
  'ŋ1~ŋwíí a ntɔ́ntɔ|ŋ2~ŋwíí akǝ bɛ́ɛ|ŋ3~ŋwíí akǝ ráá|ŋ4~ŋwíí akǝ nin|ŋ5~ŋwíí akǝ táan|ŋ6~ŋwíí akǝ táafɔk|ŋ7~ŋw' +
    'íí akǝ táabɛɛ|ŋ8~ŋwíí akǝ táaraa|ŋ9~ŋwíí akǝ táanin|ŋ10~ŋwíí akǝ ntɛk|ŋ11~ŋwíí akǝ ntɛk di bɔ́k|ŋ12~ŋwíí akǝ' +
    ' ntɛk di bɛ́ɛ',
  'Jan~Jannewa|Fäb~Fäbrowa|Mäz~Määz|Apr~Aprell|Mai|Jun~Juuni|Jul~Juuli|Ouj~Oujoß|Septämber~Säp|Okt~Oktohber|Nov' +
    '~Novämber|Dez~Dezämber',
  'rêb~rêbendanê|reş~reşemiyê|ada~adarê|avr~avrêlê|gul~gulanê|pûş~pûşperê|tîr~tîrmehê|gel~gelawêjê|rez~rezberê|' +
    'kew~kewçêrê|ser~sermawezê|ber~berfanbarê',
  'Gen~mis Genver|Hwe~mis Hwevrer|Meu~mis Meurth|Ebr~mis Ebrel|Me~mis Me|Met~mis Metheven|Gor~mis Gortheren|Est' +
    '~mis Est|Gwn~mis Gwynngala|Hed~mis Hedra|Du~mis Du|Kev~mis Kevardhu',
  'янв.~январь|фев.~февраль|мар.~март|апр.~апрель|май|июн.~июнь|июл.~июль|авг.~август|сен.~сентябрь|окт.~октябр' +
    'ь|ноя.~ноябрь|дек.~декабрь',
  'Fúngatɨ~Kʉfúngatɨ|Kʉnaanɨ~Naanɨ|Keenda~Kʉkeenda|Ikúmi~Kwiikumi|Inyambala~Kwiinyambála|Idwaata~Kwiidwaata|Kʉm' +
    'ʉʉnchɨ~Mʉʉnchɨ|Kʉvɨɨrɨ~Vɨɨrɨ|Kʉsaatʉ~Saatʉ|Inyi~Kwiinyi|Kʉsaano~Saano|Kʉsasatʉ~Sasatʉ',
  'Jan.~Januar|Feb.~Februar|Mäe.~Mäerz|Abr.~Abrëll|Mee|Juni|Juli|Aug.~August|Sep.~September|Okt.~Oktober|Nov.~N' +
    'ovember|Dez.~Dezember',
  'Jan~Janwaliyo|Feb~Febwaliyo|Mar~Marisi|Apu~Apuli|Maa~Maayi|Juu~Juuni|Jul~Julaayi|Agu~Agusito|Seb~Sebuttemba|' +
    'Oki~Okitobba|Nov~Novemba|Des~Desemba',
  'Wiótheȟika Wí|Thiyóȟeyuŋka Wí|Ištáwičhayazaŋ Wí|Pȟežítȟo Wí|Čhaŋwápetȟo Wí|Wípazukȟa-wašté Wí|Čhaŋpȟásapa Wí' +
    '|Wasútȟuŋ Wí|Čhaŋwápeǧi Wí|Čhaŋwápe-kasná Wí|Waníyetu Wí|Tȟahékapšuŋ Wí',
  'sánzá ya yambo~yan|fbl~sánzá ya míbalé|msi~sánzá ya mísáto|apl~sánzá ya mínei|mai~sánzá ya mítáno|sánzá ya m' +
    'otóbá~yun|sánzá ya nsambo~yul|agt~sánzá ya mwambe|stb~sánzá ya libwa|sánzá ya zómi~ɔtb|nvb~sánzá ya zómi na ' +
    'mɔ̌kɔ́|dsb~sánzá ya zómi na míbalé',
  'ມ.ກ.~ມັງກອນ|ກ.ພ.~ກຸມພາ|ມ.ນ.~ມີນາ|ມ.ສ.~ເມສາ|ພ.ພ.~ພຶດສະພາ|ມິ.ຖ.~ມິຖຸນາ|ກ.ລ.~ກໍລະກົດ|ສ.ຫ.~ສິງຫາ|ກ.ຍ.~ກັນຍາ|ຕ.ລ.' +
    '~ຕຸລາ|ພ.ຈ.~ພະຈິກ|ທ.ວ.~ທັນວາ',
  'جانڤیە|فئڤریە|مارس|آڤریل|مئی|جوٙأن|جوٙلا|آگوست|سئپتامر|ئوکتوڤر|نوڤامر|دئسامر',
  'saus.~sausio|vas.~vasario|kov.~kovo|bal.~balandžio|geg.~gegužės|birž.~birželio|liep.~liepos|rugp.~rugpjūčio|' +
    'rugs.~rugsėjo|spal.~spalio|lapkr.~lapkričio|gruod.~gruodžio',
  'Cio~Ciongo|Lui~Lùishi|Lus~Lusòlo|Muu~Mùuyà|Lum~Lumùngùlù|Luf~Lufuimi|Kab~Kabàlàshìpù|Lush~Lùshìkà|Lut~Lutong' +
    'olo|Lun~Lungùdi|Kas~Kaswèkèsè|Cis~Ciswà',
  'DAC~Dwe mar Achiel|DAR~Dwe mar Ariyo|DAD~Dwe mar Adek|DAN~Dwe mar Ang’wen|DAH~Dwe mar Abich|DAU~Dwe mar Auch' +
    'iel|DAO~Dwe mar Abiriyo|DAB~Dwe mar Aboro|DOC~Dwe mar Ochiko|DAP~Dwe mar Apar|DGI~Dwe mar gi achiel|DAG~Dwe ' +
    'mar Apar gi ariyo',
  'Jan~Januari|Feb~Februari|Machi~Mar|Apr~Aprili|Mei|Jun~Juni|Jul~Julai|Ago~Agosti|Sep~Septemba|Okt~Oktoba|Nov~' +
    'Novemba|Des~Desemba',
  'janv.~janvāris|febr.~februāris|marts|apr.~aprīlis|maijs|jūn.~jūnijs|jūl.~jūlijs|aug.~augusts|sept.~septembri' +
    's|okt.~oktobris|nov.~novembris|dec.~decembris',
  'Dal~Oladalʉ́|Ará~Arát|Ɔɛn~Ɔɛnɨ́ɔɨŋɔk|Doy~Olodoyíóríê inkókúâ|Lép~Oloilépūnyīē inkókúâ|Kújúɔrɔk~Rok|Mórusásin' +
    '~Sás|Bɔ́r~Ɔlɔ́ɨ́bɔ́rárɛ|Kús~Kúshîn|Gís~Olgísan|Pʉshʉ́ka~Shʉ́|Ntʉ́~Ntʉ́ŋʉ́s',
  'JAN~Januarĩ|FEB~Feburuarĩ|MAC~Machi|ĨPU~Ĩpurũ|MĨĨ~Mĩĩ|NJU~Njuni|NJR~Njuraĩ|AGA~Agasti|SPT~Septemba|OKT~Oktũb' +
    'a|NOV~Novemba|DEC~Dicemba',
  'zan~zanvie|fev~fevriye|mar~mars|avr~avril|me|zin|zil~zilye|out|sep~septam|okt~oktob|nov~novam|des~desam',
  'Jan~Janoary|Feb~Febroary|Mar~Martsa|Apr~Aprily|Mey|Jon~Jona|Jol~Jolay|Aog~Aogositra|Sep~Septambra|Okt~Oktobr' +
    'a|Nov~Novambra|Des~Desambra',
  'Kwa~Mweri wo kwanza|Mweri wo unayeli~Una|Mweri wo uneraru~Rar|Che~Mweri wo unecheshe|Mweri wo unethanu~Tha|M' +
    'oc~Mweri wo thanu na mocha|Mweri wo saba~Sab|Mweri wo nane~Nan|Mweri wo tisa~Tis|Kum~Mweri wo kumi|Moj~Mweri' +
    ' wo kumi na moja|Mweri wo kumi na yel’li~Yel',
  'iməg mbegtug~mbegtug|imeg àbùbì|imeg mbəŋchubi|iməg ngwə̀t|iməg fog|iməg ichiibɔd|iməg àdùmbə̀ŋ|iməg ichika|' +
    'iməg kud|iməg tèsiʼe|iməg zò|iməg krizmed',
  'Kohi~Kohitātea|Hui~Huitanguru|Pou~Poutūterangi|Pae~Paengawhāwhā|Hara~Haratua|Pipi~Pipiri|Hōngo~Hōngongoi|Her' +
    'e~Hereturikōkā|Mahu~Mahuru|Nuku~Whiringa-ā-nuku|Rangi~Whiringa-ā-rangi|Haki~Hakihea',
  'јан.~јануари|фев.~февруари|мар.~март|апр.~април|мај|јун.~јуни|јул.~јули|авг.~август|септ.~септември|окт.~окт' +
    'омври|ноем.~ноември|дек.~декември',
  'ജനു~ജനുവരി|ഫെബ്രു~ഫെബ്രുവരി|മാർ~മാർച്ച്|ഏപ്രി~ഏപ്രിൽ|മേയ്|ജൂൺ|ജൂലൈ|ഓഗ~ഓഗസ്റ്റ്|സെപ്റ്റം~സെപ്റ്റംബർ|ഒക്ടോ~ഒക്' +
    '\u200cടോബർ|നവം~നവംബർ|ഡിസം~ഡിസംബർ',
  '1-р сар~нэгдүгээр сар|2-р сар~хоёрдугаар сар|3-р сар~гуравдугаар сар|4-р сар~дөрөвдүгээр сар|5-р сар~тавдуга' +
    'ар сар|6-р сар~зургаадугаар сар|7-р сар~долоодугаар сар|8-р сар~наймдугаар сар|9-р сар~есдүгээр сар|10-р сар' +
    '~аравдугаар сар|11-р сар~арван нэгдүгээр сар|12-р сар~арван хоёрдугаар сар',
  'জানুৱারি|ফেব্রুৱারি|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|ওক্টোবর|নভেম্বর|ডিসেম্বর',
  'जाने~जानेवारी|फेब्रु~फेब्रुवारी|मार्च|एप्रि~एप्रिल|मे|जून|जुलै|ऑग~ऑगस्ट|सप्टें~सप्टेंबर|ऑक्टो~ऑक्टोबर|नोव्हे' +
    'ं~नोव्हेंबर|डिसें~डिसेंबर',
  'Jan~Januari|Feb~Februari|Mac|Apr~April|Mei|Jun|Jul~Julai|Ogo~Ogos|Sep~September|Okt~Oktober|Nov~November|Dis' +
    '~Disember',
  'Jan~Jannar|Fra~Frar|Mar~Marzu|Apr~April|Mej~Mejju|Ġun~Ġunju|Lul~Lulju|Aww~Awwissu|Set~Settembru|Ott~Ottubru|' +
    'Nov~Novembru|Diċ~Diċembru',
  'FLO~Fĩi Loo|CLA~Cokcwaklaŋne|CKI~Cokcwaklii|FMF~Fĩi Marfoo|MAD~Madǝǝuutǝbijaŋ|MBI~Mamǝŋgwãafahbii|MLI~Mamǝŋg' +
    'wãalii|MAM~Madǝmbii|FDE~Fĩi Dǝɓlii|FMU~Fĩi Mundaŋ|FGW~Fĩi Gwahlle|FYU~Fĩi Yuru',
  'ဇန်~ဇန်နဝါရီ|ဖေ~ဖေဖော်ဝါရီ|မတ်|ဧ~ဧပြီ|မေ|ဇွန်|ဇူ~ဇူလိုင်|ဩ~ဩဂုတ်|စက်~စက်တင်ဘာ|အောက်~အောက်တိုဘာ|နို~နိုဝင်ဘာ|' +
    'ဒီ~ဒီဇင်ဘာ',
  'ژانویه|فوریه|مارس|آوریل|مه|ژوئن|ژوئیه|اوت|سپتامبر|اکتبر|نوامبر|دسامبر',
  'Jan~ǃKhanni|Feb~ǃKhanǀgôab|Mar~ǀKhuuǁkhâb|Apr~ǃHôaǂkhaib|May~ǃKhaitsâb|Gamaǀaeb~Jun|Jul~ǂKhoesaob|Aoǁkhuumûǁ' +
    'khâb~Aug|Sep~Taraǀkhuumûǁkhâb|Oct~ǂNûǁnâiseb|Nov~ǀHooǂgaeb|Dec~Hôasoreǁkhâb',
  'Zib~Zibandlela|Nhlo~Nhlolanja|Mbi~Mbimbitho|Mab~Mabasa|Nkw~Nkwenkwezi|Nhla~Nhlangula|Ntu~Ntulikazi|Ncw~Ncwab' +
    'akazi|Mpan~Mpandula|Mfu~Mfumfu|Lwe~Lwezi|Mpal~Mpalakazi',
  'जनवरी|फेब्रुअरी|मार्च|अप्रिल|मे|जुन|जुलाई|अगस्ट|सेप्टेम्बर|अक्टोबर|नोभेम्बर|डिसेम्बर',
  'ng1~ngwɛn matáhra|ng2~ngwɛn ńmba|ng3~ngwɛn ńlal|ng4~ngwɛn ńna|ng5~ngwɛn ńtan|ng6~ngwɛn ńtuó|ng7~ngwɛn hɛmbuɛ' +
    'rí|ng8~ngwɛn lɔmbi|ng9~ngwɛn rɛbvuâ|ng10~ngwɛn wum|ng11~ngwɛn wum navǔr|kris~krísimin',
  'jan.~januar|feb.~februar|mars|apr.~april|mai|juni|juli|aug.~august|sep.~september|okt.~oktober|nov.~november' +
    '|des.~desember',
  'saŋ tsetsɛ̀ɛ lùm|saŋ kàg ngwóŋ|saŋ lepyè shúm|saŋ cÿó|saŋ tsɛ̀ɛ cÿó|saŋ njÿoláʼ|saŋ tyɛ̀b tyɛ̀b mbʉ̀ŋ|saŋ mb' +
    'ʉ̀ŋ|saŋ ngwɔ̀ʼ mbÿɛ|saŋ tàŋa tsetsáʼ|saŋ mejwoŋó|saŋ lùm',
  'Tiop~Tiop thar pɛt|Pɛt|Duɔ̱ɔ̱~Duɔ̱ɔ̱ŋ|Guak|Duä~Duät|Kor~Kornyoot|Pay~Pay yie̱tni|Thoo~Tho̱o̱r|Tɛɛ~Tɛɛr|Laa~L' +
    'aath|Kur|Tid~Tio̱p in di̱i̱t',
  'Ama~Amajjii|Gur~Guraandhala|Bit~Bitooteessa|Elb~Elba|Caamsa~Cam|Wax~Waxabajjii|Ado~Adooleessa|Hag~Hagayya|Fu' +
    'l~Fuulbana|Onk~Onkololeessa|Sad~Sadaasa|Mud~Muddee',
  'ଜାନୁଆରୀ|ଫେବୃଆରୀ|ମାର୍ଚ୍ଚ|ଅପ୍ରେଲ|ମଇ|ଜୁନ|ଜୁଲାଇ|ଅଗଷ୍ଟ|ସେପ୍ଟେମ୍ବର|ଅକ୍ଟୋବର|ନଭେମ୍ବର|ଡିସେମ୍ବର',
  'янв.~январы|фев.~февралы|мар.~мартъийы|апр.~апрелы|майы|июны|июлы|авг.~августы|сен.~сентябры|окт.~октябры|но' +
    'я.~ноябры|дек.~декабры',
  'ਜਨ~ਜਨਵਰੀ|ਫ਼ਰ~ਫ਼ਰਵਰੀ|ਮਾਰਚ|ਅਪ੍ਰੈ~ਅਪ੍ਰੈਲ|ਮਈ|ਜੂਨ|ਜੁਲਾ~ਜੁਲਾਈ|ਅਗ~ਅਗਸਤ|ਸਤੰ~ਸਤੰਬਰ|ਅਕਤੂ~ਅਕਤੂਬਰ|ਨਵੰ~ਨਵੰਬਰ|ਦਸੰ~ਦਸੰਬਰ',
  'Jén~Jénúári|Fẹ́b~Fẹ́búári|Mach|Épr~Éprel|Mee|Jun|Jul~Julai|Ọgọ~Ọgọst|Sẹp~Sẹptẹ́mba|Ọkt~Ọktóba|Nọv~Nọvẹ́mba|D' +
    'is~Disẹ́mba',
  'sty~stycznia|lut~lutego|mar~marca|kwi~kwietnia|maj~maja|cze~czerwca|lip~lipca|sie~sierpnia|wrz~września|paź~' +
    'października|lis~listopada|gru~grudnia',
  'جنوري|فبروري|مارچ|اپریل|مۍ|جون|جولای|اګست|سېپتمبر|اکتوبر|نومبر|دسمبر',
  'Ene~Enero|Feb~Febrero|Mar~Marzo|Abr~Abril|May~Mayo|Jun~Junio|Jul~Julio|Ago~Agosto|Set~Setiembre|Oct~Octubre|' +
    'Nov~Noviembre|Dic~Diciembre',
  'da schaner~schan.|da favrer~favr.|da mars~mars|avr.~d’avrigl|da matg~matg|da zercladur~zercl.|da fanadur~fan' +
    '.|avust~d’avust|da settember~sett.|d’october~oct.|da november~nov.|da december~dec.',
  'Mut.~Nzero|Gas.~Ruhuhuma|Ntwarante~Wer.|Mat.~Ndamukiza|Gic.~Rusama|Kam.~Ruheshi|Mukakaro~Nya.|Kan.~Nyandagar' +
    'o|Nyakanga~Nze.|Gitugutu~Ukw.|Munyonyo~Ugu.|Kigarama~Uku.',
  'ian.~ianuarie|feb.~februarie|mar.~martie|apr.~aprilie|mai|iun.~iunie|iul.~iulie|aug.~august|sept.~septembrie' +
    '|oct.~octombrie|noiembrie~nov.|dec.~decembrie',
  'M1~Mweri wa kwanza|M2~Mweri wa kaili|M3~Mweri wa katatu|M4~Mweri wa kaana|M5~Mweri wa tanu|M6~Mweri wa sita|' +
    'M7~Mweri wa saba|M8~Mweri wa nane|M9~Mweri wa tisa|M10~Mweri wa ikumi|M11~Mweri wa ikumi na moja|M12~Mweri w' +
    'a ikumi na mbili',
  'янв.~января|февр.~февраля|мар.~марта|апр.~апреля|мая|июн.~июня|июл.~июля|авг.~августа|сент.~сентября|окт.~ок' +
    'тября|нояб.~ноября|дек.~декабря',
  'Mutarama~mut.|Gashyantare~gas.|Werurwe~wer.|Mata~mat.|Gicuransi~gic.|Kamena~kam.|Nyakanga~nya.|Kanama~kan.|N' +
    'zeli~nze.|Ukwakira~ukw.|Ugushyingo~ugu.|Ukuboza~uku.',
  'जनवरी:~जनवरीमासः|फरवरी:~फरवरीमासः|मार्च:~मार्चमासः|अप्रैल:~अप्रैलमासः|मई~मईमासः|जून:~जूनमासः|जुलाई:~जुलाईमास' +
    'ः|अगस्त:~अगस्तमासः|सितंबर:~सितंबरमासः|अक्तूबर:~अक्तूबरमासः|नवंबर:~नवंबरमासः|दिसंबर:~दिसंबरमासः',
  'Тохс~Тохсунньу|Олун~Олунньу|Клн~Кулун тутар|Мсу~Муус устар|Ыам~Ыам ыйын|Бэс~Бэс ыйын|От ыйын~Отй|Атр~Атырдьы' +
    'х ыйын|Балаҕан ыйын~Блҕ|Алт~Алтынньы|Сэт~Сэтинньи|Ахс~ахсынньы',
  'Lapa le obo~Obo|Lapa le waare~Waa|Lapa le okuni~Oku|Lapa le ong’wan~Ong|Ime~Lapa le imet|Ile~Lapa le ile|Lap' +
    'a le sapa~Sap|Isi~Lapa le isiet|Lapa le saal~Saa|Lapa le tomon~Tom|Lapa le tomon obo~Tob|Lapa le tomon waare' +
    '~Tow',
  'ᱡᱟᱱ~ᱡᱟᱱᱣᱟᱨᱤ|ᱯᱷᱟ~ᱯᱷᱟᱨᱣᱟᱨᱤ|ᱢᱟᱨ~ᱢᱟᱨᱪ|ᱟᱯᱨ~ᱟᱯᱨᱮᱞ|ᱢᱮ|ᱡᱩᱱ|ᱡᱩᱞ~ᱡᱩᱞᱟᱭ|ᱟᱜᱟ~ᱟᱜᱟᱥᱛ|ᱥᱮᱯ~ᱥᱮᱯᱴᱮᱢᱵᱟᱨ|ᱚᱠᱴ~ᱚᱠᱴᱚᱵᱟᱨ|ᱱᱟᱣ~ᱱᱟᱣᱟᱢᱵᱟ' +
    'ᱨ|ᱫᱤᱥ~ᱫᱤᱥᱟᱢᱵᱟᱨ',
  'Mup~Mupalangulwa|Mwi~Mwitope|Msh~Mushende|Mun~Munyi|Mag~Mushende Magali|Muj~Mujimbi|Msp~Mushipepo|Mpg~Mupugu' +
    'to|Munyense~Mye|Mok~Mokhu|Mus~Musongandembwe|Muh~Muhaano',
  'جنوري|فيبروري|مارچ|اپريل|مئي|جون|جولاءِ|آگسٽ|سيپٽمبر|آڪٽوبر|نومبر|ڊسمبر',
  'ođđajagemánnu~ođđj|guov~guovvamánnu|njuk~njukčamánnu|cuo~cuoŋománnu|mies~miessemánnu|geas~geassemánnu|suoi~s' +
    'uoidnemánnu|borg~borgemánnu|čakč~čakčamánnu|golg~golggotmánnu|skáb~skábmamánnu|juov~juovlamánnu',
  'ođđajagemánnu~ođđj|guov~guovvamánnu|njuk~njukčamánnu|cuoŋ~cuoŋománnu|mies~miessemánnu|geas~geassemánnu|suoi~' +
    'suoidnemánnu|borg~borgemánnu|čakč~čakčamánnu|golg~golggotmánnu|skáb~skábmamánnu|juov~juovlamánnu',
  'Jan~Janeiro|Fev~Fevreiro|Mar~Marco|Abr~Abril|Mai~Maio|Jun~Junho|Jul~Julho|Aug~Augusto|Set~Setembro|Otu~Otubr' +
    'o|Nov~Novembro|Dec~Decembro',
  'Nye~Nyenye|Ful~Fulundïgi|Mbä~Mbängü|Ngu~Ngubùe|Bêl~Bêläwü|Fön~Föndo|Len~Lengua|Kük~Kükürü|Mvu~Mvuka|Ngb~Ngbe' +
    'rere|Nab~Nabändüru|Kak~Kakauka',
  'ⵉⵏⵏ~ⵉⵏⵏⴰⵢⵔ|ⴱⵕⴰ~ⴱⵕⴰⵢⵕ|ⵎⴰⵕ~ⵎⴰⵕⵚ|ⵉⴱⵔ~ⵉⴱⵔⵉⵔ|ⵎⴰⵢ~ⵎⴰⵢⵢⵓ|ⵢⵓⵏ~ⵢⵓⵏⵢⵓ|ⵢⵓⵍ~ⵢⵓⵍⵢⵓⵣ|ⵖⵓⵛ~ⵖⵓⵛⵜ|ⵛⵓⵜ~ⵛⵓⵜⴰⵏⴱⵉⵔ|ⴽⵜⵓ~ⴽⵜⵓⴱⵔ|ⵏⵓⵡ~ⵏ' +
    'ⵓⵡⴰⵏⴱⵉⵔ|ⴷⵓⵊ~ⴷⵓⵊⴰⵏⴱⵉⵔ',
  'ජන~ජනවාරි|පෙබ~පෙබරවාරි|මාර්තු|අප්\u200dරේල්|මැයි|ජූනි|ජූලි|අගෝ~අගෝස්තු|සැප්~සැප්තැම්බර්|ඔක්~ඔක්තෝබර්|නොවැ~නො' +
    'වැම්බර්|දෙසැ~දෙසැම්බර්',
  'jan~januára|feb~februára|mar~marca|apr~apríla|máj~mája|jún~júna|júl~júla|aug~augusta|sep~septembra|okt~októb' +
    'ra|nov~novembra|dec~decembra',
  'jan.~januar|feb.~februar|mar.~marec|apr.~april|maj|jun.~junij|jul.~julij|avg.~avgust|sep.~september|okt.~okt' +
    'ober|nov.~november|dec.~december',
  'uđiv~uđđâivemáánu|kuovâ~kuovâmáánu|njuhčâ~njuhčâmáánu|cuáŋui~cuáŋuimáánu|vyesi~vyesimáánu|kesi~kesimáánu|sye' +
    'ini~syeinimáánu|porge~porgemáánu|čohčâ~čohčâmáánu|roovvâd~roovvâdmáánu|skammâ~skammâmáánu|juovlâ~juovlâmáánu',
  'Ndi~Ndira|Kuk~Kukadzi|Kur~Kurume|Kub~Kubvumbi|Chivabvu~Chv|Chikumi~Chk|Chg~Chikunguru|Nya~Nyamavhuvhu|Gun~Gu' +
    'nyana|Gum~Gumiguru|Mbu~Mbudzi|Zvi~Zvita',
  'Bisha Koobaad~Jan|Bisha Labaad~Feb|Bisha Saddexaad~Mar|Abr~Bisha Afraad|Bisha Shanaad~May|Bisha Lixaad~Jun|B' +
    'isha Todobaad~Lul|Bisha Sideedaad~Ogs|Bisha Sagaalaad~Seb|Bisha Tobnaad~Okt|Bisha Kow iyo Tobnaad~Nof|Bisha ' +
    'Laba iyo Tobnaad~Dis',
  'jan~janar|shk~shkurt|mar~mars|pri~prill|maj|qer~qershor|korr~korrik|gush~gusht|sht~shtator|tet~tetor|nën~nën' +
    'tor|dhj~dhjetor',
  'јан~јануар|феб~фебруар|мар~март|апр~април|мај|јун|јул|авг~август|сеп~септембар|окт~октобар|нов~новембар|дец~' +
    'децембар',
  'јан~јануар|феб~фебруар|мар~март|апр~април|мај|јун~јуни|јул~јули|авг~август|сеп~септембар|окт~октобар|нов~нов' +
    'ембар|дец~децембар',
  'Jan~Januari|Péb~Pébruari|Mar~Maret|Apr~April|Méi|Jun~Juni|Jul~Juli|Ags~Agustus|Sép~Séptémber|Okt~Oktober|Nop' +
    '~Nopémber|Dés~Désémber',
  'Jan~Januari|Feb~Februari|Mac~Machi|Apr~Aprili|Mei|Jun~Juni|Jul~Julai|Ago~Agosti|Sep~Septemba|Okt~Oktoba|Nov~' +
    'Novemba|Des~Desemba',
  'ஜன.~ஜனவரி|பிப்.~பிப்ரவரி|மார்.~மார்ச்|ஏப்.~ஏப்ரல்|மே|ஜூன்|ஜூலை|ஆக.~ஆகஸ்ட்|செப்.~செப்டம்பர்|அக்.~அக்டோபர்|நவ.' +
    '~நவம்பர்|டிச.~டிசம்பர்',
  'జన~జనవరి|ఫిబ్ర~ఫిబ్రవరి|మార్చి|ఏప్రి~ఏప్రిల్|మే|జూన్|జులై|ఆగ~ఆగస్టు|సెప్టెం~సెప్టెంబర్|అక్టో~అక్టోబర్|నవం~నవ' +
    'ంబర్|డిసెం~డిసెంబర్',
  'Orara~Rar|Muk~Omuk|Kwa~Okwamg’|Dun~Odung’el|Mar~Omaruk|Mod~Omodok’king’ol|Jol~Ojola|Opedel~Ped|Osokosokoma~S' +
    'ok|Otibar~Tib|Lab~Olabor|Opoo~Poo',
  'Янв~Январ|Фев~Феврал|Мар~Март|Апр~Апрел|Май|Июн|Июл|Авг~Август|Сен~Сентябр|Окт~Октябр|Ноя~Ноябр|Дек~Декабр',
  'ม.ค.~มกราคม|ก.พ.~กุมภาพันธ์|มี.ค.~มีนาคม|เม.ย.~เมษายน|พ.ค.~พฤษภาคม|มิ.ย.~มิถุนายน|ก.ค.~กรกฎาคม|ส.ค.~สิงหาคม|' +
    'ก.ย.~กันยายน|ต.ค.~ตุลาคม|พ.ย.~พฤศจิกายน|ธ.ค.~ธันวาคม',
  'ጥሪ|ለካ~ለካቲት|መጋ~መጋቢት|ሚያ~ሚያዝያ|ግን~ግንቦት|ሰነ|ሓም~ሓምለ|ነሓ~ነሓሰ|መስ~መስከረም|ጥቅ~ጥቅምቲ|ሕዳ~ሕዳር|ታሕ~ታሕሳስ',
  'ýan~ýanwar|few~fewral|mart|apr~aprel|maý|iýun|iýul|awg~awgust|sen~sentýabr|okt~oktýabr|noý~noýabr|dek~dekabr',
  'Sān~Sānuali|Fēp~Fēpueli|Maʻa~Maʻasi|ʻEpe~ʻEpeleli|Mē|Sun~Sune|Siu~Siulai|ʻAok~ʻAokosi|Sep~Sepitema|ʻOka~ʻOka' +
    'topa|Nōv~Nōvema|Tīs~Tīsema',
  'Oca~Ocak|Şub~Şubat|Mar~Mart|Nis~Nisan|May~Mayıs|Haz~Haziran|Tem~Temmuz|Ağu~Ağustos|Eyl~Eylül|Eki~Ekim|Kas~Ka' +
    'sım|Ara~Aralık',
  'гыйн.~гыйнвар|фев.~февраль|мар.~март|апр.~апрель|май|июнь|июль|авг.~август|сент.~сентябрь|окт.~октябрь|нояб.' +
    '~ноябрь|дек.~декабрь',
  'Yen~Yennayer|Yeb~Yebrayer|Mar~Mars|Ibr~Ibrir|May~Mayyu|Yun~Yunyu|Yul~Yulyuz|Ɣuc~Ɣuct|Cut~Cutanbir|Kṭu~Kṭuber' +
    '|Nwa~Nwanbir|Duj~Dujanbir',
  'يانۋار|فېۋرال|مارت|ئاپرېل|ماي|ئىيۇن|ئىيۇل|ئاۋغۇست|سېنتەبىر|ئۆكتەبىر|نويابىر|دېكابىر',
  'січ.~січня|лют.~лютого|бер.~березня|квіт.~квітня|трав.~травня|черв.~червня|лип.~липня|серп.~серпня|вер.~вере' +
    'сня|жовт.~жовтня|лист.~листопада|груд.~грудня',
  'جنوری|فروری|مارچ|اپریل|مئی|جون|جولائی|اگست|ستمبر|اکتوبر|نومبر|دسمبر',
  'yan~yanvar|fev~fevral|mar~mart|apr~aprel|may|iyn~iyun|iyl~iyul|avg~avgust|sen~sentabr|okt~oktabr|noy~noyabr|' +
    'dek~dekabr',
  'ꖨꖕ ꕪꕴ ꔞꔀꕮꕊ~ꖨꖕꔞ|ꕒꕡ~ꕒꕡꖝꖕ|ꕾꖺ|ꖢꖕ|ꖑꕱ|ꖱꘋ|ꖱꕞ~ꖱꕞꔤ|ꗛꔕ|ꕢꕌ|ꕭꖃ|ꔞꘋ~ꔞꘋꕔꕿ ꕸꖃꗏ|ꖨꖕ ꕪꕴ ꗏꖺꕮꕊ~ꖨꖕꗏ',
  'thg 1~tháng 1|thg 2~tháng 2|thg 3~tháng 3|thg 4~tháng 4|thg 5~tháng 5|thg 6~tháng 6|thg 7~tháng 7|thg 8~thán' +
    'g 8|thg 9~tháng 9|thg 10~tháng 10|thg 11~tháng 11|thg 12~tháng 12',
  'Jen~Jenner|Hor~Hornig|Mär~Märze|Abr~Abrille|Mei~Meije|Brá~Bráčet|Hei~Heiwet|Öig~Öigšte|Her~Herbštmánet|Wím~W' +
    'ímánet|Win~Wintermánet|Chr~Chrištmánet',
  'Sam~Samwiyee|Few~Fewriyee|Mar~Mars|Awr~Awril|Mee|Suw~Suwe|Sul~Sulet|Ut|Sàt~Sàttumbar|Okt~Oktoobar|Now~Nowàmb' +
    'ar|Des~Desàmbar',
  'Jan~Janyuwari|Feb~Februwari|Mat~Matshi|Epr~Epreli|Mey~Meyi|Jun~Juni|Jul~Julayi|Aga~Agasti|Sep~Septemba|Okt~O' +
    'kthoba|Nov~Novemba|Dis~Disemba',
  'o.1~pikítíkítie, oólí ú kutúan|o.2~siɛyɛ́, oóli ú kándíɛ|o.3~ɔnsúmbɔl, oóli ú kátátúɛ|mesiŋ, oóli ú kénie~o.' +
    '4|ensil, oóli ú kátánuɛ~o.5|o.6~ɔsɔn|efute~o.7|o.8~pisuyú|imɛŋ i puɔs~o.9|imɛŋ i putúk,oóli ú kátíɛ~o.10|mak' +
    'andikɛ~o.11|o.12~pilɔndɔ́',
  'יאַנואַר|פֿעברואַר|מערץ|אַפּריל|מיי|יוני|יולי|אויגוסט|סעפּטעמבער|אקטאבער|נאוועמבער|דעצעמבער',
  'Oṣù Ṣẹ́rẹ́~Ṣẹ́r|Oṣù Èrèlè~Èrèl|Oṣù Ẹrẹ̀nà~Ẹrẹ̀n|Oṣù Ìgbé~Ìgb|Oṣù Ẹ̀bibi~Ẹ̀bi|Oṣù Òkúdu~Òkú|Agẹ~Oṣù Agẹmọ|Oṣù' +
    ' Ògún~Ògú|Owe~Oṣù Owewe|Oṣù Ọ̀wàrà~Ọ̀wà|Bél~Oṣù Bélú|Oṣù Ọ̀pẹ̀~Ọ̀pẹ',
  'Oshù Shɛ́rɛ́~Shɛ́r|Oshù Èrèlè~Èrèl|Oshù Ɛrɛ̀nà~Ɛrɛ̀n|Oshù Ìgbé~Ìgb|Oshù Ɛ̀bibi~Ɛ̀bi|Oshù Òkúdu~Òkú|Agɛ~Oshù ' +
    'Agɛmɔ|Oshù Ògún~Ògú|Oshù Owewe~Owe|Oshù Ɔ̀wàrà~Ɔ̀wà|Bél~Oshù Bélú|Oshù Ɔ̀pɛ̀~Ɔ̀pɛ',
  '一月|二月|三月|四月|五月|六月|七月|八月|九月|十月|十一月|十二月',
  'Jan~Januwari|Feb~Februwari|Mas~Mashi|Eph~Ephreli|Mey~Meyi|Jun~Juni|Jul~Julayi|Aga~Agasti|Sep~Septhemba|Okt~O' +
    'kthoba|Nov~Novemba|Dis~Disemba',
];

/** Long weekday names, Sunday first, '|'-separated. */
const WEEKDAYS: readonly string[] = [
  'Sun|Mon|Tue|Wed|Thu|Fri|Sat',
  '星期日|星期一|星期二|星期三|星期四|星期五|星期六',
  'zondag|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag',
  'Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday',
  'dimanche|lundi|mardi|mercredi|jeudi|vendredi|samedi',
  'Sonntag|Montag|Dienstag|Mittwoch|Donnerstag|Freitag|Samstag',
  'domenica|lunedì|martedì|mercoledì|giovedì|venerdì|sabato',
  '日曜日|月曜日|火曜日|水曜日|木曜日|金曜日|土曜日',
  '일요일|월요일|화요일|수요일|목요일|금요일|토요일',
  'søndag|mandag|tirsdag|onsdag|torsdag|fredag|lørdag',
  'domingo|segunda-feira|terça-feira|quarta-feira|quinta-feira|sexta-feira|sábado',
  'domingo|lunes|martes|miércoles|jueves|viernes|sábado',
  'söndag|måndag|tisdag|onsdag|torsdag|fredag|lördag',
  'Sondag|Maandag|Dinsdag|Woensdag|Donderdag|Vrydag|Saterdag',
  'tsuʔntsɨ|tsuʔukpà|tsuʔughɔe|tsuʔutɔ̀mlò|tsuʔumè|tsuʔughɨ̂m|tsuʔndzɨkɔʔɔ',
  'Kwesida|Dwowda|Benada|Wukuda|Yawda|Fida|Memeneda',
  'እሑድ|ሰኞ|ማክሰኞ|ረቡዕ|ሐሙስ|ዓርብ|ቅዳሜ',
  'الأحد|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت',
  'দেওবাৰ|সোমবাৰ|মঙ্গলবাৰ|বুধবাৰ|বৃহস্পতিবাৰ|শুক্ৰবাৰ|শনিবাৰ',
  'Jumapili|Jumatatu|Jumanne|Jumatano|Alhamisi|Ijumaa|Jumamosi',
  'domingu|llunes|martes|miércoles|xueves|vienres|sábadu',
  'bazar|bazar ertəsi|çərşənbə axşamı|çərşənbə|cümə axşamı|cümə|şənbə',
  'ŋgwà nɔ̂y|ŋgwà njaŋgumba|ŋgwà ûm|ŋgwà ŋgê|ŋgwà mbɔk|ŋgwà kɔɔ|ŋgwà jôn',
  'нядзеля|панядзелак|аўторак|серада|чацвер|пятніца|субота',
  'Pa Mulungu|Palichimo|Palichibuli|Palichitatu|Palichine|Palichisano|Pachibelushi',
  'pa mulungu|pa shahuviluha|pa hivili|pa hidatu|pa hitayi|pa hihanu|pa shahulembela',
  'неделя|понеделник|вторник|сряда|четвъртък|петък|събота',
  'kari|ntɛnɛ|tarata|araba|alamisa|juma|sibiri',
  'রবিবার|সোমবার|মঙ্গলবার|বুধবার|বৃহস্পতিবার|শুক্রবার|শনিবার',
  'གཟའ་ཉི་མ་|གཟའ་ཟླ་བ་|གཟའ་མིག་དམར་|གཟའ་ལྷག་པ་|གཟའ་ཕུར་བུ་|གཟའ་པ་སངས་|གཟའ་སྤེན་པ་',
  'Sul|Lun|Meurzh|Mercʼher|Yaou|Gwener|Sadorn',
  'रबिबार|समबार|मंगलबार|बुदबार|बिसथिबार|सुखुरबार|सुनिबार',
  'nedjelja|ponedjeljak|utorak|srijeda|četvrtak|petak|subota',
  'diumenge|dilluns|dimarts|dimecres|dijous|divendres|dissabte',
  '𑄢𑄧𑄝𑄨𑄝𑄢𑄴|𑄥𑄧𑄟𑄴𑄝𑄢𑄴|𑄟𑄧𑄁𑄉𑄧𑄣𑄴𑄝𑄢𑄴|𑄝𑄪𑄖𑄴𑄝𑄢𑄴|𑄝𑄳𑄢𑄨𑄥𑄪𑄛𑄴𑄝𑄢𑄴|𑄥𑄪𑄇𑄴𑄇𑄮𑄢𑄴𑄝' +
    '𑄢𑄴|𑄥𑄧𑄚𑄨𑄝𑄢𑄴',
  'кӀира|оршот|шинара|кхаара|еара|пӀераска|шуот',
  'Domingo|Lunes|Martes|Miyerkules|Huwebes|Biyernes|Sabado',
  'Sande|Orwokubanza|Orwakabiri|Orwakashatu|Orwakana|Orwakataano|Orwamukaaga',
  'ᎤᎾᏙᏓᏆᏍᎬ|ᎤᎾᏙᏓᏉᏅᎯ|ᏔᎵᏁᎢᎦ|ᏦᎢᏁᎢᎦ|ᏅᎩᏁᎢᎦ|ᏧᎾᎩᎶᏍᏗ|ᎤᎾᏙᏓᏈᏕᎾ',
  'یەکشەممە|دووشەممە|سێشەممە|چوارشەممە|پێنجشەممە|ھەینی|شەممە',
  'neděle|pondělí|úterý|středa|čtvrtek|pátek|sobota',
  'Dydd Sul|Dydd Llun|Dydd Mawrth|Dydd Mercher|Dydd Iau|Dydd Gwener|Dydd Sadwrn',
  'Ituku ja jumwa|Kuramuka jimweri|Kuramuka kawi|Kuramuka kadadu|Kuramuka kana|Kuramuka kasanu|Kifula nguwo',
  'Alhadi|Atinni|Atalaata|Alarba|Alhamisi|Alzuma|Asibti',
  'ऐतबार|सोमबार|मंगलबार|बुधबार|बीरबार|शुक्रबार|शनीबार',
  'njeźela|pónjeźele|wałtora|srjoda|stwórtk|pětk|sobota',
  'éti|mɔ́sú|kwasú|mukɔ́sú|ŋgisú|ɗónɛsú|esaɓasú',
  'Dimas|Teneŋ|Talata|Alarbay|Aramisay|Arjuma|Sibiti',
  'གཟའ་ཟླ་བ་|གཟའ་མིག་དམར་|གཟའ་ལྷག་པ་|གཟའ་ཕུར་བུ་|གཟའ་པ་སངས་|གཟའ་སྤེན་པ་|གཟའ་ཉི་མ་',
  'Kiumia|Njumatatu|Njumaine|Njumatano|Aramithi|Njumaa|NJumamothii',
  'kɔsiɖa|dzoɖa|blaɖa|kuɖa|yawoɖa|fiɖa|memleɖa',
  'Κυριακή|Δευτέρα|Τρίτη|Τετάρτη|Πέμπτη|Παρασκευή|Σάββατο',
  'dimanĉo|lundo|mardo|merkredo|ĵaŭdo|vendredo|sabato',
  'pühapäev|esmaspäev|teisipäev|kolmapäev|neljapäev|reede|laupäev',
  'igandea|astelehena|asteartea|asteazkena|osteguna|ostirala|larunbata',
  'sɔ́ndɔ|mɔ́ndi|sɔ́ndɔ məlú mə́bɛ̌|sɔ́ndɔ məlú mə́lɛ́|sɔ́ndɔ məlú mə́nyi|fúladé|séradé',
  'یکشنبه|دوشنبه|سه\u200cشنبه|چهارشنبه|پنجشنبه|جمعه|شنبه',
  'dewo|aaɓnde|mawbaare|njeslaare|naasaande|mawnde|hoore-biir',
  'sunnuntaina|maanantaina|tiistaina|keskiviikkona|torstaina|perjantaina|lauantaina',
  'Linggo|Lunes|Martes|Miyerkules|Huwebes|Biyernes|Sabado',
  'sunnudagur|mánadagur|týsdagur|mikudagur|hósdagur|fríggjadagur|leygardagur',
  'domenie|lunis|martars|miercus|joibe|vinars|sabide',
  'snein|moandei|tiisdei|woansdei|tongersdei|freed|sneon',
  'Dé Domhnaigh|Dé Luain|Dé Máirt|Dé Céadaoin|Déardaoin|Dé hAoine|Dé Sathairn',
  'DiDòmhnaich|DiLuain|DiMàirt|DiCiadain|DiarDaoin|DihAoine|DiSathairne',
  'domingo|luns|martes|mércores|xoves|venres|sábado',
  'Sunntig|Määntig|Ziischtig|Mittwuch|Dunschtig|Friitig|Samschtig',
  'રવિવાર|સોમવાર|મંગળવાર|બુધવાર|ગુરુવાર|શુક્રવાર|શનિવાર',
  'Chumapiri|Chumatato|Chumaine|Chumatano|Aramisi|Ichuma|Esabato',
  'Jedoonee|Jelhein|Jemayrt|Jercean|Jerdein|Jeheiney|Jesarn',
  'Lahadi|Litinin|Talata|Laraba|Alhamis|Jummaʼa|Asabar',
  'Lāpule|Poʻakahi|Poʻalua|Poʻakolu|Poʻahā|Poʻalima|Poʻaono',
  'יום ראשון|יום שני|יום שלישי|יום רביעי|יום חמישי|יום שישי|יום שבת',
  'रविवार|सोमवार|मंगलवार|बुधवार|गुरुवार|शुक्रवार|शनिवार',
  'njedźela|póndźela|wutora|srjeda|štwórtk|pjatk|sobota',
  'vasárnap|hétfő|kedd|szerda|csütörtök|péntek|szombat',
  'կիրակի|երկուշաբթի|երեքշաբթի|չորեքշաբթի|հինգշաբթի|ուրբաթ|շաբաթ',
  'dominica|lunedi|martedi|mercuridi|jovedi|venerdi|sabbato',
  'Minggu|Senin|Selasa|Rabu|Kamis|Jumat|Sabtu',
  'Sọndee|Mọnde|Tiuzdee|Wenezdee|Tọọzdee|Fraịdee|Satọdee',
  'ꑭꆏꑍ|ꆏꊂꋍ|ꆏꊂꑍ|ꆏꊂꌕ|ꆏꊂꇖ|ꆏꊂꉬ|ꆏꊂꃘ',
  'sunnudagur|mánudagur|þriðjudagur|miðvikudagur|fimmtudagur|föstudagur|laugardagur',
  'Sɔ́ndi|Mɔ́ndi|Ápta Mɔ́ndi|Wɛ́nɛsɛdɛ|Tɔ́sɛdɛ|Fɛlâyɛdɛ|Sásidɛ',
  'Jumapilyi|Jumatatuu|Jumanne|Jumatanu|Alhamisi|Ijumaa|Jumamosi',
  'Ahad|Senin|Selasa|Rabu|Kamis|Jumat|Sabtu',
  'კვირა|ორშაბათი|სამშაბათი|ოთხშაბათი|ხუთშაბათი|პარასკევი|შაბათი',
  'Yanass|Sanass|Kraḍass|Kuẓass|Samass|Sḍisass|Sayass',
  'Wa kyumwa|Wa kwambĩlĩlya|Wa kelĩ|Wa katatũ|Wa kana|Wa katano|Wa thanthatũ',
  'Liduva lyapili|Liduva lyatatu|Liduva lyanchechi|Liduva lyannyano|Liduva lyannyano na linji|Liduva lyannyano ' +
    'na mavili|Liduva litandi',
  'dumingu|sigunda-fera|tersa-fera|kuarta-fera|kinta-fera|sesta-fera|sábadu',
  'Alhadi|Atini|Atalata|Alarba|Alhamiisa|Aljuma|Assabdu',
  'Kiumia|Njumatatũ|Njumaine|Njumatana|Aramithi|Njumaa|Njumamothi',
  'жексенбі|дүйсенбі|сейсенбі|сәрсенбі|бейсенбі|жұма|сенбі',
  'sɔndi|lundi|mardi|mɛrkɛrɛdi|yedi|vaŋdɛrɛdi|mɔnɔ sɔndi',
  'sapaat|ataasinngorneq|marlunngorneq|pingasunngorneq|sisamanngorneq|tallimanngorneq|arfininngorneq',
  'Kotisap|Kotaai|Koaeng’|Kosomok|Koang’wan|Komuut|Kolo',
  'អាទិត្យ|ច័ន្ទ|អង្គារ|ពុធ|ព្រហស្បតិ៍|សុក្រ|សៅរ៍',
  'ಭಾನುವಾರ|ಸೋಮವಾರ|ಮಂಗಳವಾರ|ಬುಧವಾರ|ಗುರುವಾರ|ಶುಕ್ರವಾರ|ಶನಿವಾರ',
  'आयतार|सोमार|मंगळार|बुधवार|बिरेस्तार|शुक्रार|शेनवार',
  'اَتھوار|ژٔندرٕروار|بۆموار|بودوار|برؠسوار|جُمہ|بٹوار',
  'Jumaapii|Jumaatatu|Jumaane|Jumaatano|Alhamisi|Ijumaa|Jumaamosi',
  'sɔ́ndǝ|lǝndí|maadí|mɛkrɛdí|jǝǝdí|júmbá|samdí',
  'Sunndaach|Mohndaach|Dinnsdaach|Metwoch|Dunnersdaach|Friidaach|Samsdaach',
  'yekşem|duşem|sêşem|çarşem|pêncşem|în|şemî',
  'dy Sul|dy Lun|dy Meurth|dy Merher|dy Yow|dy Gwener|dy Sadorn',
  'жекшемби|дүйшөмбү|шейшемби|шаршемби|бейшемби|жума|ишемби',
  'Jumapíiri|Jumatátu|Jumaíne|Jumatáano|Alamíisi|Ijumáa|Jumamóosi',
  'Sonndeg|Méindeg|Dënschdeg|Mëttwoch|Donneschdeg|Freideg|Samschdeg',
  'Sabbiiti|Balaza|Lwakubiri|Lwakusatu|Lwakuna|Lwakutaano|Lwamukaaga',
  'Aŋpétuwakȟaŋ|Aŋpétuwaŋži|Aŋpétunuŋpa|Aŋpétuyamni|Aŋpétutopa|Aŋpétuzaptaŋ|Owáŋgyužažapi',
  'eyenga|mokɔlɔ mwa yambo|mokɔlɔ mwa míbalé|mokɔlɔ mwa mísáto|mokɔlɔ ya mínéi|mokɔlɔ ya mítáno|mpɔ́sɔ',
  'ວັນອາທິດ|ວັນຈັນ|ວັນອັງຄານ|ວັນພຸດ|ວັນພະຫັດ|ວັນສຸກ|ວັນເສົາ',
  'sekmadienis|pirmadienis|antradienis|trečiadienis|ketvirtadienis|penktadienis|šeštadienis',
  'Lumingu|Nkodya|Ndàayà|Ndangù|Njòwa|Ngòvya|Lubingu',
  'Jumapil|Wuok Tich|Tich Ariyo|Tich Adek|Tich Ang’wen|Tich Abich|Ngeso',
  'Jumapiri|Jumatatu|Jumanne|Jumatano|Murwa wa Kanne|Murwa wa Katano|Jumamosi',
  'svētdiena|pirmdiena|otrdiena|trešdiena|ceturtdiena|piektdiena|sestdiena',
  'Jumapílí|Jumatátu|Jumane|Jumatánɔ|Alaámisi|Jumáa|Jumamósi',
  'Kiumia|Muramuko|Wairi|Wethatu|Wena|Wetano|Jumamosi',
  'dimans|lindi|mardi|merkredi|zedi|vandredi|samdi',
  'Alahady|Alatsinainy|Talata|Alarobia|Alakamisy|Zoma|Asabotsy',
  'Sabato|Jumatatu|Jumanne|Jumatano|Arahamisi|Ijumaa|Jumamosi',
  'Aneg 1|Aneg 2|Aneg 3|Aneg 4|Aneg 5|Aneg 6|Aneg 7',
  'Rātapu|Rāhina|Rātū|Rāapa|Rāpare|Rāmere|Rāhoroi',
  'недела|понеделник|вторник|среда|четврток|петок|сабота',
  'ഞായറാഴ്\u200cച|തിങ്കളാഴ്\u200cച|ചൊവ്വാഴ്ച|ബുധനാഴ്\u200cച|വ്യാഴാഴ്\u200cച|വെള്ളിയാഴ്\u200cച|ശനിയാഴ്\u200cച',
  'ням|даваа|мягмар|лхагва|пүрэв|баасан|бямба',
  'নোংমাইজিং|নিংথৌকাবা|লৈবাকপোকপা|য়ুমশকৈশা|শগোলশেন|ইরাই|থাংজ',
  'रविवार|सोमवार|मंगळवार|बुधवार|गुरुवार|शुक्रवार|शनिवार',
  'Ahad|Isnin|Selasa|Rabu|Khamis|Jumaat|Sabtu',
  'Il-Ħadd|It-Tnejn|It-Tlieta|L-Erbgħa|Il-Ħamis|Il-Ġimgħa|Is-Sibt',
  'Com’yakke|Comlaaɗii|Comzyiiɗii|Comkolle|Comkaldǝɓlii|Comgaisuu|Comzyeɓsuu',
  'တနင်္ဂနွေ|တနင်္လာ|အင်္ဂါ|ဗုဒ္ဓဟူး|ကြာသပတေး|သောကြာ|စနေ',
  'Sontaxtsees|Mantaxtsees|Denstaxtsees|Wunstaxtsees|Dondertaxtsees|Fraitaxtsees|Satertaxtsees',
  'Sonto|Mvulo|Sibili|Sithathu|Sine|Sihlanu|Mgqibelo',
  'आइतबार|सोमबार|मङ्गलबार|बुधबार|बिहिबार|शुक्रबार|शनिबार',
  'sɔ́ndɔ|mɔ́ndɔ|sɔ́ndɔ mafú mába|sɔ́ndɔ mafú málal|sɔ́ndɔ mafú mána|mabágá má sukul|sásadi',
  'søndag|måndag|tysdag|onsdag|torsdag|fredag|laurdag',
  'lyɛʼɛ́ sẅíŋtè|mvfò lyɛ̌ʼ|mbɔ́ɔntè mvfò lyɛ̌ʼ|tsètsɛ̀ɛ lyɛ̌ʼ|mbɔ́ɔntè tsetsɛ̀ɛ lyɛ̌ʼ|mvfò màga lyɛ̌ʼ|màga lyɛ' +
    '̌ʼ',
  'Cäŋ kuɔth|Jiec la̱t|Rɛw lätni|Diɔ̱k lätni|Ŋuaan lätni|Dhieec lätni|Bäkɛl lätni',
  'Dilbata|Wiixata|Qibxata|Roobii|Kamiisa|Jimaata|Sanbata',
  'ରବିବାର|ସୋମବାର|ମଙ୍ଗଳବାର|ବୁଧବାର|ଗୁରୁବାର|ଶୁକ୍ରବାର|ଶନିବାର',
  'хуыцаубон|къуырисӕр|дыццӕг|ӕртыццӕг|цыппӕрӕм|майрӕмбон|сабат',
  'ਐਤਵਾਰ|ਸੋਮਵਾਰ|ਮੰਗਲਵਾਰ|ਬੁੱਧਵਾਰ|ਵੀਰਵਾਰ|ਸ਼ੁੱਕਰਵਾਰ|ਸ਼ਨਿੱਚਰਵਾਰ',
  'Sọ́ndè|Mọ́ndè|Tiúzdè|Wẹ́nẹ́zdè|Tọ́zdè|Fraídè|Sátọdè',
  'niedziela|poniedziałek|wtorek|środa|czwartek|piątek|sobota',
  'يونۍ|دونۍ|درېنۍ|څلرنۍ|پينځنۍ|جمعه|اونۍ',
  'Domingo|Lunes|Martes|Miércoles|Jueves|Viernes|Sábado',
  'dumengia|glindesdi|mardi|mesemna|gievgia|venderdi|sonda',
  'Ku w’indwi|Ku wa mbere|Ku wa kabiri|Ku wa gatatu|Ku wa kane|Ku wa gatanu|Ku wa gatandatu',
  'duminică|luni|marți|miercuri|joi|vineri|sâmbătă',
  'Ijumapili|Ijumatatu|Ijumanne|Ijumatano|Alhamisi|Ijumaa|Ijumamosi',
  'воскресенье|понедельник|вторник|среда|четверг|пятница|суббота',
  'Ku cyumweru|Kuwa mbere|Kuwa kabiri|Kuwa gatatu|Kuwa kane|Kuwa gatanu|Kuwa gatandatu',
  'रविवासरः|सोमवासरः|मंगलवासरः|बुधवासरः|गुरुवासर:|शुक्रवासरः|शनिवासरः',
  'баскыһыанньа|бэнидиэнньик|оптуорунньук|сэрэдэ|чэппиэр|Бээтиҥсэ|субуота',
  'Mderot ee are|Mderot ee kuni|Mderot ee ong’wan|Mderot ee inet|Mderot ee ile|Mderot ee sapa|Mderot ee kwe',
  'ᱥᱤᱸᱜᱮ|ᱚᱛᱮ|ᱵᱟᱞᱮ|ᱥᱟᱹᱜᱩᱱ|ᱥᱟᱹᱨᱫᱤ|ᱡᱟᱹᱨᱩᱢ|ᱧᱩᱦᱩᱢ',
  'Mulungu|Jumatatu|Jumanne|Jumatano|Alahamisi|Ijumaa|Jumamosi',
  'آچر|سومر|اڱارو|اربع|خميس|جمعو|ڇنڇر',
  'sotnabeaivi|vuossárga|maŋŋebárga|gaskavahkku|duorasdat|bearjadat|lávvardat',
  'sotnabeaivi|mánnodat|disdat|gaskavahkku|duorastat|bearjadat|lávvordat',
  'Dimingu|Chiposi|Chipiri|Chitatu|Chinai|Chishanu|Sabudu',
  'Alhadi|Atinni|Atalaata|Alarba|Alhamiisa|Alzuma|Asibti',
  'Bikua-ôko|Bïkua-ûse|Bïkua-ptâ|Bïkua-usïö|Bïkua-okü|Lâpôsö|Lâyenga',
  'ⴰⵙⴰⵎⴰⵙ|ⴰⵢⵏⴰⵙ|ⴰⵙⵉⵏⴰⵙ|ⴰⴽⵕⴰⵙ|ⴰⴽⵡⴰⵙ|ⵙⵉⵎⵡⴰⵙ|ⴰⵙⵉⴹⵢⴰⵙ',
  'ඉරිදා|සඳුදා|අඟහරුවාදා|බදාදා|බ්\u200dරහස්පතින්දා|සිකුරාදා|සෙනසුරාදා',
  'nedeľa|pondelok|utorok|streda|štvrtok|piatok|sobota',
  'nedelja|ponedeljek|torek|sreda|četrtek|petek|sobota',
  'pasepeeivi|vuossaargâ|majebaargâ|koskoho|tuorâstuv|vástuppeeivi|lávurduv',
  'Svondo|Muvhuro|Chipiri|Chitatu|China|Chishanu|Mugovera',
  'Axad|Isniin|Talaado|Arbaco|Khamiis|Jimco|Sabti',
  'e diel|e hënë|e martë|e mërkurë|e enjte|e premte|e shtunë',
  'недеља|понедељак|уторак|среда|четвртак|петак|субота',
  'недеља|понедељак|уторак|сриједа|четвртак|петак|субота',
  'Minggu|Senén|Salasa|Rebo|Kemis|Jumaah|Saptu',
  'ஞாயிறு|திங்கள்|செவ்வாய்|புதன்|வியாழன்|வெள்ளி|சனி',
  'ఆదివారం|సోమవారం|మంగళవారం|బుధవారం|గురువారం|శుక్రవారం|శనివారం',
  'Nakaejuma|Nakaebarasa|Nakaare|Nakauni|Nakaung’on|Nakakany|Nakasabiti',
  'Якшанбе|Душанбе|Сешанбе|Чоршанбе|Панҷшанбе|Ҷумъа|Шанбе',
  'วันอาทิตย์|วันจันทร์|วันอังคาร|วันพุธ|วันพฤหัสบดี|วันศุกร์|วันเสาร์',
  'ሰንበት|ሰኑይ|ሠሉስ|ረቡዕ|ኃሙስ|ዓርቢ|ቀዳም',
  'ýekşenbe|duşenbe|sişenbe|çarşenbe|penşenbe|anna|şenbe',
  'Sāpate|Mōnite|Tūsite|Pulelulu|Tuʻapulelulu|Falaite|Tokonaki',
  'Pazar|Pazartesi|Salı|Çarşamba|Perşembe|Cuma|Cumartesi',
  'якшәмбе|дүшәмбе|сишәмбе|чәршәмбе|пәнҗешәмбе|җомга|шимбә',
  'Asamas|Aynas|Asinas|Akras|Akwas|Asimwas|Asiḍyas',
  'يەكشەنبە|دۈشەنبە|سەيشەنبە|چارشەنبە|پەيشەنبە|جۈمە|شەنبە',
  'неділя|понеділок|вівторок|середа|четвер|пʼятниця|субота',
  'اتوار|پیر|منگل|بدھ|جمعرات|جمعہ|ہفتہ',
  'yakshanba|dushanba|seshanba|chorshanba|payshanba|juma|shanba',
  'ꕞꕌꔵ|ꗳꗡꘉ|ꕚꕞꕚ|ꕉꕞꕒ|ꕉꔤꕆꕢ|ꕉꔤꕀꕮ|ꔻꔬꔳ',
  'Chủ Nhật|Thứ Hai|Thứ Ba|Thứ Tư|Thứ Năm|Thứ Sáu|Thứ Bảy',
  'Sunntag|Mäntag|Zištag|Mittwuč|Fróntag|Fritag|Samštag',
  'Dibéer|Altine|Talaata|Àlarba|Alxamis|Àjjuma|Aseer',
  'Cawe|Mvulo|Lwesibini|Lwesithathu|Lwesine|Lwesihlanu|Mgqibelo',
  'Sabiiti|Balaza|Owokubili|Owokusatu|Olokuna|Olokutaanu|Olomukaaga',
  'sɔ́ndiɛ|móndie|muányáŋmóndie|metúkpíápɛ|kúpélimetúkpiapɛ|feléte|séselé',
  'זונטיק|מאָנטיק|דינסטיק|מיטוואך|דאנערשטיק|פֿרײַטיק|שבת',
  'Ọjọ́ Àìkú|Ọjọ́ Ajé|Ọjọ́ Ìsẹ́gun|Ọjọ́rú|Ọjọ́bọ|Ọjọ́ Ẹtì|Ọjọ́ Àbámẹ́ta',
  'Ɔjɔ́ Àìkú|Ɔjɔ́ Ajé|Ɔjɔ́ Ìsɛ́gun|Ɔjɔ́rú|Ɔjɔ́bɔ|Ɔjɔ́ Ɛtì|Ɔjɔ́ Àbámɛ́ta',
  'ⴰⵙⴰⵎⴰⵙ|ⴰⵢⵏⴰⵙ|ⴰⵙⵉⵏⴰⵙ|ⴰⴽⵕⴰⵙ|ⴰⴽⵡⴰⵙ|ⴰⵙⵉⵎⵡⴰⵙ|ⴰⵙⵉⴹⵢⴰⵙ',
  'ISonto|UMsombuluko|ULwesibili|ULwesithathu|ULwesine|ULwesihlanu|UMgqibelo',
];

/** Short weekday names, Sunday first, '|'-separated. */
const SHORT_WEEKDAYS: readonly string[] = [
  'Sun|Mon|Tue|Wed|Thu|Fri|Sat',
  '周日|周一|周二|周三|周四|周五|周六',
  '週日|週一|週二|週三|週四|週五|週六',
  'zo|ma|di|wo|do|vr|za',
  'Sun.|Mon.|Tue.|Wed.|Thu.|Fri.|Sat.',
  'dim.|lun.|mar.|mer.|jeu.|ven.|sam.',
  'So.|Mo.|Di.|Mi.|Do.|Fr.|Sa.',
  'dom|lun|mar|mer|gio|ven|sab',
  '日|月|火|水|木|金|土',
  '일|월|화|수|목|금|토',
  'søn.|man.|tir.|ons.|tor.|fre.|lør.',
  'dom.|seg.|ter.|qua.|qui.|sex.|sáb.',
  'domingo|segunda|terça|quarta|quinta|sexta|sábado',
  'dom|lun|mar|mié|jue|vie|sáb',
  'sön|mån|tis|ons|tors|fre|lör',
  'So.|Ma.|Di.|Wo.|Do.|Vr.|Sa.',
  'nts|kpa|ghɔ|tɔm|ume|ghɨ|dzk',
  'Kwe|Dwo|Ben|Wuk|Yaw|Fia|Mem',
  'እሑድ|ሰኞ|ማክሰ|ረቡዕ|ሐሙስ|ዓርብ|ቅዳሜ',
  'الأحد|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت',
  'দেও|সোম|মঙ্গল|বুধ|বৃহ|শুক্ৰ|শনি',
  'Jpi|Jtt|Jnn|Jtn|Alh|Ijm|Jmo',
  'dom|llu|mar|mié|xue|vie|sáb',
  'B.|B.e.|Ç.a.|Ç.|C.a.|C.|Ş.',
  'nɔy|nja|uum|ŋge|mbɔ|kɔɔ|jon',
  'нд|пн|аў|ср|чц|пт|сб',
  'Pa Mulungu|Palichimo|Palichibuli|Palichitatu|Palichine|Palichisano|Pachibelushi',
  'Mul|Vil|Hiv|Hid|Hit|Hih|Lem',
  'нд|пн|вт|ср|чт|пт|сб',
  'kar|ntɛ|tar|ara|ala|jum|sib',
  'রবি|সোম|মঙ্গল|বুধ|বৃহস্পতি|শুক্র|শনি',
  'ཉི་མ་|ཟླ་བ་|མིག་དམར་|ལྷག་པ་|ཕུར་བུ་|པ་སངས་|སྤེན་པ་',
  'Sul|Lun|Meu.|Mer.|Yaou|Gwe.|Sad.',
  'रबि|सम|मंगल|बुद|बिसथि|सुखुर|सुनि',
  'ned|pon|uto|sri|čet|pet|sub',
  'dg.|dl.|dt.|dc.|dj.|dv.|ds.',
  '𑄢𑄧𑄝𑄨|𑄥𑄧𑄟𑄴|𑄟𑄧𑄁𑄉𑄧𑄣𑄴|𑄝𑄪𑄖𑄴|𑄝𑄳𑄢𑄨𑄥𑄪𑄛𑄴|𑄥𑄪𑄇𑄴𑄇𑄮𑄢𑄴|𑄥𑄧𑄚𑄨',
  'кӀи|ор|ши|кха|еа|пӀе|шуо',
  'Dom|Lun|Mar|Miy|Huw|Biy|Sab',
  'SAN|ORK|OKB|OKS|OKN|OKT|OMK',
  'ᏆᏍᎬ|ᏉᏅᎯ|ᏔᎵᏁ|ᏦᎢᏁ|ᏅᎩᏁ|ᏧᎾᎩ|ᏈᏕᎾ',
  'یەکشەممە|دووشەممە|سێشەممە|چوارشەممە|پێنجشەممە|ھەینی|شەممە',
  'ne|po|út|st|čt|pá|so',
  'Sul|Llun|Maw|Mer|Iau|Gwen|Sad',
  'Jum|Jim|Kaw|Kad|Kan|Kas|Ngu',
  'Alh|Ati|Ata|Ala|Alm|Alz|Asi',
  'ऐत|सोम|मंगल|बुध|बीर|शुक्र|शनि',
  'nje|pón|wał|srj|stw|pět|sob',
  'ét|mɔ́s|kwa|muk|ŋgi|ɗón|esa',
  'Dim|Ten|Tal|Ala|Ara|Arj|Sib',
  'ཟླ་|མིར་|ལྷག་|ཕུར་|སངས་|སྤེན་|ཉི་',
  'Kma|Tat|Ine|Tan|Arm|Maa|NMM',
  'kɔs|dzo|bla|kuɖ|yaw|fiɖ|mem',
  'Κυρ|Δευ|Τρί|Τετ|Πέμ|Παρ|Σάβ',
  'di|lu|ma|me|ĵa|ve|sa',
  'P|E|T|K|N|R|L',
  'ig.|al.|ar.|az.|og.|or.|lr.',
  'sɔ́n|mɔ́n|smb|sml|smn|fúl|sér',
  'یکشنبه|دوشنبه|سه\u200cشنبه|چهارشنبه|پنجشنبه|جمعه|شنبه',
  'dew|aaɓ|maw|nje|naa|mwd|hbi',
  'su|ma|ti|ke|to|pe|la',
  'Lin|Lun|Mar|Miy|Huw|Biy|Sab',
  'sun.|mán.|týs.|mik.|hós.|frí.|ley.',
  'dom|lun|mar|mie|joi|vin|sab',
  'si|mo|ti|wo|to|fr|so',
  'Domh|Luan|Máirt|Céad|Déar|Aoine|Sath',
  'DiD|DiL|DiM|DiC|Dia|Dih|DiS',
  'dom.|luns|mar.|mér.|xov.|ven.|sáb.',
  'Su.|Mä.|Zi.|Mi.|Du.|Fr.|Sa.',
  'રવિ|સોમ|મંગળ|બુધ|ગુરુ|શુક્ર|શનિ',
  'Cpr|Ctt|Cmn|Cmt|Ars|Icm|Est',
  'Jed|Jel|Jem|Jerc|Jerd|Jeh|Jes',
  'Lah|Lit|Tal|Lar|Alh|Jum|Asa',
  'LP|P1|P2|P3|P4|P5|P6',
  'יום א׳|יום ב׳|יום ג׳|יום ד׳|יום ה׳|יום ו׳|שבת',
  'रवि|सोम|मंगल|बुध|गुरु|शुक्र|शनि',
  'nje|pón|wut|srj|štw|pja|sob',
  'V|H|K|Sze|Cs|P|Szo',
  'կիր|երկ|երք|չրք|հնգ|ուր|շբթ',
  'dom|lun|mar|mer|jov|ven|sab',
  'Min|Sen|Sel|Rab|Kam|Jum|Sab',
  'Sọn|Mọn|Tiu|Wen|Tọọ|Fraị|Sat',
  'ꑭꆏ|ꆏꋍ|ꆏꑍ|ꆏꌕ|ꆏꇖ|ꆏꉬ|ꆏꃘ',
  'sun.|mán.|þri.|mið.|fim.|fös.|lau.',
  'Sɔ́ndi|Mɔ́ndi|Ápta Mɔ́ndi|Wɛ́nɛsɛdɛ|Tɔ́sɛdɛ|Fɛlâyɛdɛ|Sásidɛ',
  'Jpi|Jtt|Jnn|Jtn|Alh|Iju|Jmo',
  'Ahad|Sen|Sel|Rab|Kam|Jum|Sab',
  'კვი|ორშ|სამ|ოთხ|ხუთ|პარ|შაბ',
  'Yan|San|Kraḍ|Kuẓ|Sam|Sḍis|Say',
  'Wky|Wkw|Wkl|Wtũ|Wkn|Wtn|Wth',
  'Ll2|Ll3|Ll4|Ll5|Ll6|Ll7|Ll1',
  'dum|sig|ter|kua|kin|ses|sab',
  'Alh|Ati|Ata|Ala|Alm|Alj|Ass',
  'KMA|NTT|NMN|NMT|ART|NMA|NMM',
  'жс|дс|сс|ср|бс|жм|сб',
  'sɔndi|lundi|mardi|mɛrkɛrɛdi|yedi|vaŋdɛrɛdi|mɔnɔ sɔndi',
  'sap|ata|mar|pin|sis|tal|arf',
  'Kts|Kot|Koo|Kos|Koa|Kom|Kol',
  'អាទិត្យ|ចន្ទ|អង្គារ|ពុធ|ព្រហ|សុក្រ|សៅរ៍',
  'ಭಾನು|ಸೋಮ|ಮಂಗಳ|ಬುಧ|ಗುರು|ಶುಕ್ರ|ಶನಿ',
  'आयतार|सोमार|मंगळार|बुधवार|बिरेस्तार|शुक्रार|शेनवार',
  'آتھوار|ژٔندٕروار|بۆموار|بودوار|برؠسوار|جُمہ|بٹوار',
  'Jpi|Jtt|Jmn|Jtn|Alh|Iju|Jmo',
  'sɔ́n|lǝn|maa|mɛk|jǝǝ|júm|sam',
  'Su.|Mo.|Di.|Me.|Du.|Fr.|Sa.',
  'yş|dş|sş|çş|pş|în|ş',
  'Sul|Lun|Mth|Mhr|Yow|Gwe|Sad',
  'жек.|дүй.|шейш.|шарш.|бейш.|жума|ишм.',
  'Píili|Táatu|Íne|Táano|Alh|Ijm|Móosi',
  'Son.|Méi.|Dën.|Mët.|Don.|Fre.|Sam.',
  'Sab|Bal|Lw2|Lw3|Lw4|Lw5|Lw6',
  'Aŋpétuwakȟaŋ|Aŋpétuwaŋži|Aŋpétunuŋpa|Aŋpétuyamni|Aŋpétutopa|Aŋpétuzaptaŋ|Owáŋgyužažapi',
  'eye|ybo|mbl|mst|min|mtn|mps',
  'ອາທິດ|ຈັນ|ອັງຄານ|ພຸດ|ພະຫັດ|ສຸກ|ເສົາ',
  'sk|pr|an|tr|kt|pn|št',
  'Lum|Nko|Ndy|Ndg|Njw|Ngv|Lub',
  'JMP|WUT|TAR|TAD|TAN|TAB|NGS',
  'J2|J3|J4|J5|Al|Ij|J1',
  'svētd.|pirmd.|otrd.|trešd.|ceturtd.|piektd.|sestd.',
  'KIU|MRA|WAI|WET|WEN|WTN|JUM',
  'dim|lin|mar|mer|ze|van|sam',
  'Alah|Alats|Tal|Alar|Alak|Zom|Asab',
  'Sab|Jtt|Jnn|Jtn|Ara|Iju|Jmo',
  'Aneg 1|Aneg 2|Aneg 3|Aneg 4|Aneg 5|Aneg 6|Aneg 7',
  'Tap|Hin|Tū|Apa|Par|Mer|Hor',
  'нед.|пон.|вт.|сре.|чет.|пет.|саб.',
  'ഞായർ|തിങ്കൾ|ചൊവ്വ|ബുധൻ|വ്യാഴം|വെള്ളി|ശനി',
  'Ня|Да|Мя|Лх|Пү|Ба|Бя',
  'নোংমাইজিং|নিংথৌকাবা|লৈবাকপোকপা|য়ুমশকৈশা|শগোলশেন|ইরাই|থাংজ',
  'रवि|सोम|मंगळ|बुध|गुरु|शुक्र|शनि',
  'Ahd|Isn|Sel|Rab|Kha|Jum|Sab',
  'Ħad|Tne|Tli|Erb|Ħam|Ġim|Sib',
  'Cya|Cla|Czi|Cko|Cka|Cga|Cze',
  'တနင်္ဂနွေ|တနင်္လာ|အင်္ဂါ|ဗုဒ္ဓဟူး|ကြာသပတေး|သောကြာ|စနေ',
  'Son|Ma|De|Wu|Do|Fr|Sat',
  'Son|Mvu|Sib|Sit|Sin|Sih|Mgq',
  'आइत|सोम|मङ्गल|बुध|बिहि|शुक्र|शनि',
  'sɔ́n|mɔ́n|smb|sml|smn|mbs|sas',
  'sø.|må.|ty.|on.|to.|fr.|la.',
  'lyɛʼɛ́ sẅíŋtè|mvfò lyɛ̌ʼ|mbɔ́ɔntè mvfò lyɛ̌ʼ|tsètsɛ̀ɛ lyɛ̌ʼ|mbɔ́ɔntè tsetsɛ̀ɛ lyɛ̌ʼ|mvfò màga lyɛ̌ʼ|màga lyɛ' +
    '̌ʼ',
  'Cäŋ|Jiec|Rɛw|Diɔ̱k|Ŋuaan|Dhieec|Bäkɛl',
  'Dil|Wix|Qib|Rob|Kam|Jim|San',
  'ରବି|ସୋମ|ମଙ୍ଗଳ|ବୁଧ|ଗୁରୁ|ଶୁକ୍ର|ଶନି',
  'хцб|крс|дцг|ӕрт|цпр|мрб|сбт',
  'ਐਤ|ਸੋਮ|ਮੰਗਲ|ਬੁੱਧ|ਵੀਰ|ਸ਼ੁੱਕਰ|ਸ਼ਨਿੱਚਰ',
  'Sọ́n|Mọ́n|Tiú|Wẹ́n|Tọ́z|Fraí|Sát',
  'niedz.|pon.|wt.|śr.|czw.|pt.|sob.',
  'يونۍ|دونۍ|درېنۍ|څلرنۍ|پينځنۍ|جمعه|اونۍ',
  'Dom|Lun|Mar|Mié|Jue|Vie|Sab',
  'du|gli|ma|me|gie|ve|so',
  'cu.|mbe.|kab.|gtu.|kan.|gnu.|gnd.',
  'dum.|lun.|mar.|mie.|joi|vin.|sâm.',
  'Dum|Lun|Mar|Mie|Joi|Vin|Sâm',
  'Ijp|Ijt|Ijn|Ijtn|Alh|Iju|Ijm',
  'вс|пн|вт|ср|чт|пт|сб',
  'cyu.|mbe.|kab.|gtu.|kan.|gnu.|gnd.',
  'бс|бн|оп|сэ|чп|бэ|сб',
  'Are|Kun|Ong|Ine|Ile|Sap|Kwe',
  'ᱥᱤᱸ|ᱚᱛ|ᱵᱟ|ᱥᱟᱹ|ᱥᱟᱹᱨ|ᱡᱟᱹ|ᱧᱩ',
  'Mul|Jtt|Jnn|Jtn|Alh|Iju|Jmo',
  'آچر|سومر|اڱارو|اربع|خميس|جمعو|ڇنڇر',
  'sotn|vuos|maŋ|gask|duor|bear|láv',
  'so|má|di|ga|du|be|lá',
  'Dim|Pos|Pir|Tat|Nai|Sha|Sab',
  'Bk1|Bk2|Bk3|Bk4|Bk5|Lâp|Lây',
  'ⴰⵙⴰ|ⴰⵢⵏ|ⴰⵙⵉ|ⴰⴽⵕ|ⴰⴽⵡ|ⴰⵙⵉⵎ|ⴰⵙⵉⴹ',
  'ඉරිදා|සඳුදා|අඟහ|බදාදා|බ්\u200dරහස්|සිකු|සෙන',
  'ne|po|ut|st|št|pi|so',
  'ned.|pon.|tor.|sre.|čet.|pet.|sob.',
  'pas|vuo|maj|kos|tuo|vás|láv',
  'Svo|Muv|Chp|Cht|Chn|Chs|Mug',
  'Axd|Isn|Tldo|Arbc|Khms|Jmc|Sbti',
  'Die|Hën|Mar|Mër|Enj|Pre|Sht',
  'нед|пон|уто|сре|чет|пет|суб',
  'нед|пон|уто|сри|чет|пет|суб',
  'Mng|Sen|Sal|Reb|Kem|Jum|Sap',
  'Jumapili|Jumatatu|Jumanne|Jumatano|Alhamisi|Ijumaa|Jumamosi',
  'ஞாயி.|திங்.|செவ்.|புத.|வியா.|வெள்.|சனி',
  'ఆది|సోమ|మంగళ|బుధ|గురు|శుక్ర|శని',
  'Jum|Bar|Aar|Uni|Ung|Kan|Sab',
  'Яшб|Дшб|Сшб|Чшб|Пшб|Ҷмъ|Шнб',
  'อา.|จ.|อ.|พ.|พฤ.|ศ.|ส.',
  'ሰን|ሰኑ|ሰሉ|ረቡ|ሓሙ|ዓር|ቀዳ',
  'ýek|duş|siş|çar|pen|ann|şen',
  'Sāp|Mōn|Tūs|Pul|Tuʻa|Fal|Tok',
  'Paz|Pzt|Sal|Çar|Per|Cum|Cmt',
  'якш.|дүш.|сиш.|чәр.|пәнҗ.|җом.|шим.',
  'Asa|Ayn|Asn|Akr|Akw|Asm|Asḍ',
  'يە|دۈ|سە|چا|پە|جۈ|شە',
  'اتوار|پیر|منگل|بدھ|جمعرات|جمعہ|ہفتہ',
  'Yak|Dush|Sesh|Chor|Pay|Jum|Shan',
  'ꕞꕌꔵ|ꗳꗡꘉ|ꕚꕞꕚ|ꕉꕞꕒ|ꕉꔤꕆꕢ|ꕉꔤꕀꕮ|ꔻꔬꔳ',
  'CN|Th 2|Th 3|Th 4|Th 5|Th 6|Th 7',
  'Sun|Män|Ziš|Mit|Fró|Fri|Sam',
  'Dib|Alt|Tal|Àla|Alx|Àjj|Ase',
  'Caw|Mvu|Bin|Tha|Sin|Hla|Mgq',
  'Sabi|Bala|Kubi|Kusa|Kuna|Kuta|Muka',
  'sd|md|mw|et|kl|fl|ss',
  'זונטיק|מאָנטיק|דינסטיק|מיטוואך|דאנערשטיק|פֿרײַטיק|שבת',
  'Àìk|Aj|Ìsẹ́g|Ọjọ́r|Ọjọ́b|Ẹt|Àbám',
  'Àìk|Aj|Ìsɛ́g|Ɔjɔ́r|Ɔjɔ́b|Ɛt|Àbám',
  '星期日|星期一|星期二|星期三|星期四|星期五|星期六',
  'Son|Mso|Bil|Tha|Sin|Hla|Mgq',
];

/** BC then AD names, '|'-separated, an era's names '~'-separated. */
const ERAS: readonly string[] = [
  'BCE|CE',
  '公元前|公元',
  '西元前|西元',
  'v.Chr.~voor Christus|n.Chr.~na Christus',
  'BC~Before Christ|AD~Anno Domini',
  'av. J.-C.~avant Jésus-Christ|ap. J.-C.~après Jésus-Christ',
  'v. Chr.|n. Chr.',
  'a.C.~avanti Cristo|d.C.~dopo Cristo',
  '紀元前|西暦',
  'BC~기원전|AD~서기',
  'f.Kr.~før Kristus|e.Kr.~etter Kristus',
  'a.C.~antes de Cristo|d.C.~depois de Cristo',
  'a. C.~antes de Cristo|d. C.~después de Cristo',
  'f.Kr.~före Kristus|e.Kr.~efter Kristus',
  'v.C.~voor Christus|n.C.~na Christus',
  'SK~Sěe Kɨ̀lesto|BK~Bǎa Kɨ̀lesto',
  'AK~Ansa Kristo|KE~Kristo Ekyiri',
  'ዓ/ዓ~ዓመተ ዓለም|ዓ/ም~ዓመተ ምሕረት',
  'ق.م~قبل الميلاد|م~ميلادي',
  'খ্ৰীঃ পূঃ~খ্ৰীষ্টপূৰ্ব|খ্ৰীঃ~খ্ৰীষ্টাব্দ',
  'KM~Kabla yakwe Yethu|BM~Baada yakwe Yethu',
  'e.C.~enantes de Cristu|d.C.~después de Cristu',
  'e.ə.~eramızdan əvvəl|y.e.~yeni era',
  'b.Y.K~bisū bi Yesù Krǐstò|i mbūs Yesù Krǐstò~m.Y.K',
  'да н.э.~да нараджэння Хрыстова|ад нараджэння Хрыстова~н.э.',
  'BC~Before Yesu|AD~After Yesu',
  'KM~Kabla ya Mtwaa|BM~Baada ya Mtwaa',
  'пр.Хр.~преди Христа|сл.Хр.~след Христа',
  'J.-C. ɲɛ~jezu krisiti ɲɛ|jezu krisiti minkɛ~ni J.-C.',
  'খ্রিস্টপূর্ব|খৃষ্টাব্দ~খ্রীষ্টাব্দ',
  'སྤྱི་ལོ་སྔོན་|སྤྱི་ལོ་',
  'a-raok J.K.~a-raok Jezuz-Krist|goude J.K.~goude Jezuz-Krist',
  'ईसा.पूर्व|सन',
  'p. n. e.~prije nove ere|n. e.~nove ere',
  'aC~abans de Crist|dC~després de Crist',
  '𑄈𑄳𑄢𑄨𑄌𑄴𑄑𑄴𑄛𑄫𑄢𑄴𑄝𑄧|𑄈𑄳𑄢𑄨𑄌𑄴𑄑𑄛𑄴𑄘𑄧',
  'в. э. тӀ. я~Ӏийса пайхамар вина де кхачале|в. э~Ӏийса пайхамар вина дийнахь дуьйна',
  'BC~Sa Wala Pa Si Kristo|AD~Anno Domini',
  'BC~Kurisito Atakaijire|AD~Kurisito Yaijire',
  'BC~ᏧᏓᎷᎸ ᎤᎷᎯᏍᏗ ᎦᎶᏁᏛ|AD~ᎠᏃ ᏙᎻᏂ',
  'پێش زایین|زایینی',
  'př. n. l.~před naším letopočtem|n. l.~našeho letopočtu',
  'CC~Cyn Crist|OC~Oed Crist',
  'f.Kr.|e.Kr.',
  'KK~Kabla ya Kristo|BK~Baada ya Kristo',
  'IJ~Isaa jine|IZ~Isaa zamanoo',
  'BCE~ई.पू.|ई. सन्~ईसवी',
  'pś.Chr.n.~pśed Kristusowym naroźenim|pó Chr.n.~pó Kristusowem naroźenju',
  'ɓ.Ys~ɓoso ɓwá yáɓe lá|mb.Ys~mbúsa kwédi a Yés',
  'ArY~Ariŋuu Yeesu|AtY~Atooŋe Yeesu',
  'MK~Mbere ya Kristo|TK~Thutha wa Kristo',
  'HYV~Hafi Yesu Va|Yesu ŋɔli~Yŋ',
  'π.Χ.~προ Χριστού|μ.Χ.~μετά Χριστόν',
  'aK|pK',
  'eKr~enne Kristust|pKr~pärast Kristust',
  'K.a.|K.o.~Kristo ondoren',
  'osúsúa Yésus kiri~oyk|ayk~ámvus Yésus Kirís',
  'ق.م.~قبل از میلاد|م.~میلادی',
  'H-I~Hade Iisa|C-I~Caggal Iisa',
  'eKr.~ennen Kristuksen syntymää|jKr.~jälkeen Kristuksen syntymän',
  'f.Kr.~fyri Krist|e.Kr.~eftir Krist',
  'pdC|ddC',
  'Foar Kristus~f.Kr.|n.Kr.~nei Kristus',
  'RC~Roimh Chríost|AD~Anno Domini',
  'RC~Ro Chrìosta|AD~An dèidh Chrìosta',
  'a.C.~antes de Cristo|d.C.~despois de Cristo',
  'ઈ.સ.પૂર્વે~ઈસવીસન પૂર્વે|ઇસવીસન~ઈ.સ.',
  'YA~Yeso ataiborwa|YK~Yeso kaiboirwe',
  'RC|AD',
  'K.H~Kafin haihuwar annab|BHAI~Bayan haihuwar annab',
  'לפנה״ס~לפני הספירה|לספירה',
  'ईसा-पूर्व|ईसवी सन~ईस्वी',
  'pr. Kr.~prije Krista|po. Kr.~poslije Krista',
  'př.Chr.n.~před Chrystowym narodźenjom|po Chr.n.~po Chrystowym narodźenju',
  'Krisztus előtt~i. e.|i. sz.~időszámításunk szerint',
  'Քրիստոսից առաջ~մ.թ.ա.|Քրիստոսից հետո~մ.թ.',
  'a.Chr.~ante Christo|p.Chr.~post Christo',
  'SM~Sebelum Masehi|M~Masehi',
  'T.K.~Tupu Kraist|A.K.~Afọ Kraịst',
  'ꃅꋊꂿ|ꃅꋊꊂ',
  'f.Kr.~fyrir Krist|e.Kr.~eftir Krist',
  'BCE~tsɛttsɛt mɛŋguꞌ mi ɛ́ lɛɛnɛ Kɛlísɛtɔ gɔ ńɔ́|CE~tsɛttsɛt mɛŋguꞌ mi ɛ́ fúnɛ Kɛlísɛtɔ tɔ́ mɔ́',
  'KK~Kabla ya Kristu|BK~Baada ya Kristu',
  'SM~Sakdurunge Masehi|M~Masehi',
  'ძვ. წ.~ძველი წელთაღრიცხვით|ახ. წ.~ახალი წელთაღრიცხვით',
  'send talalit n Ɛisa~snd. T.Ɛ|seld talalit n Ɛisa~sld. T.Ɛ',
  'MY~Mbee wa Yesũ|IY~Ĩtina wa Yesũ',
  'AY~Akanapawa Yesu|NY~Nankuida Yesu',
  'AK~antis di Kristu|DK~dispos di Kristu',
  'IJ~Isaa jine|IZ~Isaa jamanoo',
  'Біздің заманымызға дейін~б.з.д.|б.з.~біздің заманымыз',
  'AM~Amait kesich Jesu|KO~Kokakesich Jesu',
  'មុន គ.ស.~មុន\u200bគ្រិស្តសករាជ|គ.ស.~គ្រិស្តសករាជ',
  'ಕ್ರಿ.ಪೂ~ಕ್ರಿಸ್ತ ಪೂರ್ವ|ಕ್ರಿ.ಶ~ಕ್ರಿಸ್ತ ಶಕ',
  'क्रिस्तपूर्व|क्रिस्तशखा',
  'بی سی~قبٕل مسیٖح|اے ڈی~عیٖسوی سنہٕ',
  'KK~Kabla ya Klisto|BK~Baada ya Klisto',
  'd.Y.~di Yɛ́sus aká yálɛ|cámɛɛn kǝ kǝbɔpka Y~k.Y.',
  'v. Chr.~vür Krestos|n. Chr.~noh Krestos',
  'BZ~berî zayînê|PZ~piştî zayînê',
  'б.з.ч.~биздин заманга чейин|б.з.~биздин заман',
  'KSA~Kɨrɨsitʉ sɨ anavyaal|KA~Kɨrɨsitʉ akavyaalwe',
  'BC~Kulisito nga tannaza|AD~Bukya Kulisito Azaal',
  'Yambo ya Yézu Krís~libóso ya|Nsima ya Yézu Krís~nsima ya Y',
  'ກ່ອນ ຄ.ສ.~ກ່ອນຄຣິດສັກກະລາດ|ຄ.ສ.~ຄຣິດສັກກະລາດ',
  'pr. Kr.~prieš Kristų|po Kr.~po Kristaus',
  'Kumpala kwa Yezu Kli~kmp. Y.K.|Kunyima kwa Yezu Kli~kny. Y. K.',
  'BC~Kapok Kristo obiro|AD~Ka Kristo osebiro',
  'BC~Imberi ya Kuuza Kwa|AD~Muhiga Kuvita Kuuza',
  'p.m.ē.~pirms mūsu ēras|m.ē.~mūsu ērā',
  'ईसा-पूर्व|ईस्वी',
  'MY~Meínō Yɛ́sʉ|EY~Eínō Yɛ́sʉ',
  'MK~Mbere ya Kristũ|NK~Nyuma ya Kristũ',
  'av. Z-K~avan Zezi-Krist|ap. Z-K~apre Zezi-Krist',
  'Alohan’i JK~BC|AD~Aorian’i JK',
  'HY~Hinapiya yesu|YY~Yopia yesu',
  'п.н.е.~пред нашата ера|н.е.~од нашата ера',
  'ക്രി.മു.~ക്രിസ്\u200cതുവിന് മുമ്പ്|ആന്നോ ഡൊമിനി~എഡി',
  'МЭӨ~манай эриний өмнөх|МЭ~манай эриний',
  'খৃ: মমাং|খৃ: মতুং',
  'इ. स. पू.~ईसवीसनपूर्व|इ. स.~ईसवीसन',
  'S.M.|TM',
  'QK~Qabel Kristu|WK~Wara Kristu',
  'KK~KǝPel Kristu|PK~Pel Kristu',
  'ခရစ်တော် မပေါ်မီနှစ်~ဘီစီ|ခရစ်နှစ်~အဒေီ',
  'قبل میلاد~پ.م|بعد میلاد~م.',
  'BC~Xristub aiǃâ|AD~Xristub khaoǃgâ',
  'BC~UKristo angakabuyi|AD~Ukristo ebuyile',
  'ईसा पूर्व|सन्',
  'BL~Bó Lahlɛ̄|PB~Pfiɛ Burī',
  'm.z.Y.~mé zyé Yěsô|m.g.n.Y.~mé gÿo ńzyé Yěsô',
  'A ka̱n Yecu ni dap~AY|Ɛ ca Yecu dap~ƐY',
  'BCE~Dheengadda Jeesu|CE',
  'KD|CE',
  'BC~ଖ୍ରୀଷ୍ଟପୂର୍ବ|AD~ଖ୍ରୀଷ୍ଟାବ୍ଦ',
  'н.д.а.|н.д.',
  'ਈ. ਪੂ.~ਈਸਵੀ ਪੂਰਵ|ਈਸਵੀ ਸੰਨ~ਸੰਨ',
  'BK~Bifọ́ Kraist|KIY~Kraist Im Yiẹ',
  'p.n.e.~przed naszą erą|n.e.~naszej ery',
  'له میلاد وړاندې~له میلاد څخه وړاندې|له میلاد څخه وروسته~م.',
  'BCE|d.C.',
  'av. Cr.~avant Cristus|s. Cr.~suenter Cristus',
  'Mb.Y.~Mbere ya Yezu|Ny.Y~Nyuma ya Yezu',
  'î.Hr.~înainte de Hristos|d.Hr.~după Hristos',
  'KM~Kabla ya Mayesu|BM~Baada ya Mayesu',
  'до Рождества Христова~до н. э.|н. э.~от Рождества Христова',
  'б. э. и.|б. э',
  'KK~Kabla ya Christo|BK~Baada ya Christo',
  'ᱥᱮᱨᱢᱟ ᱞᱟᱦᱟ|ᱤᱥᱣᱤ',
  'AK~Ashanali uKilisito|PK~Pamwandi ya Kilisto',
  'BC~قبل مسيح|CD~عيسوي کان پهرين',
  'o.Kr.~ovdal Kristtusa|m.Kr.~maŋŋel Kristtusa',
  'oKr.~ovdal Kristusa|mKr.~maŋŋel Kristusa',
  'AC~Antes de Cristo|AD~Anno Domini',
  'KnK~Kôzo na Krîstu|Na pekô tî Krîstu~NpK',
  'ⴷⴰⵄ~ⴷⴰⵜ ⵏ ⵄⵉⵙⴰ|ⴷⴼⴼⵉⵔ ⵏ ⵄⵉⵙⴰ~ⴷⴼⵄ',
  'ක්\u200dරි.පූ.~ක්\u200dරිස්තු පූර්ව|ක්\u200dරි.ව.~ක්\u200dරිස්තු වර්ෂ',
  'pred Kr.~pred Kristom|po Kr.~po Kristovi',
  'pr. Kr.~pred Kristusom|po Kr.~po Kristusu',
  'Ovdil Kristus šoddâm~oKr.|mKr.~maŋa Kristus šoddâm',
  'BC~Kristo asati auya|AD~mugore ramambo vedu',
  'CH~Ciise Hortii|CD~Ciise Dabadii',
  'p.K.~para Krishtit|mb.K.~mbas Krishtit',
  'п. н. е.~пре нове ере|н. е.~нове ере',
  'п. н. е.|н. е~н. е.',
  'SM|M',
  'கி.மு.~கிறிஸ்துவுக்கு முன்|அன்னோ டோமினி~கி.பி.',
  'క్రీపూ~క్రీస్తు పూర్వం|క్రీశ~క్రీస్తు శకం',
  'ПеМ~Пеш аз милод|ПаМ~Пас аз милод',
  'ก่อน ค.ศ.~ปีก่อนคริสตกาล|ค.ศ.~คริสต์ศักราช',
  'BC|พ.ศ.~พุทธศักราช',
  'ቅድመ ክርስቶስ~ዓ/ዓ|ዓ/ም~ዓመተ ምህረት',
  'ዓ/ዓ~ዓመተ ዓለም|ዓ/ም~ዓመተ ምህረት',
  'B.e.öň~Isadan öň|B.e.~Isadan soň',
  'KM~ki muʻa|TS~taʻu ʻo Sīsū',
  'Milattan Önce~MÖ|MS~Milattan Sonra',
  'б.э.к.~безнең эрага кадәр|CE~милади',
  'Zdat Ɛisa (TAƔ)~ZƐ|Ḍeffir Ɛisa (TAƔ)~ḌƐ',
  'BCE~مىلادىيەدىن بۇرۇن|مىلادىيە',
  'до н. е.~до нашої ери|н. е.~нашої ери',
  'قبل مسیح|عیسوی',
  'm.a.~miloddan avvalgi|milodiy',
  'Trước CN~Trước Thiên Chúa|Sau CN~Sau Công Nguyên',
  'v. Chr.|n. Chr',
  'JC~av. JC|AD',
  'BC|AD',
  'AZ~Kulisto nga azilawo|AF~Kulisto nga affile',
  'k.Y.~katikupíen Yésuse|+J.C.~ékélémkúnupíén n',
  'BCE~Saju Kristi|AD~Lehin Kristi',
];

/** AM then PM names, '|'-separated, a marker's names '~'-separated. */
const AM_PM: readonly string[] = [
  'AM|PM',
  '上午|下午',
  'a.m.|p.m.',
  'am|pm',
  '午前|午後',
  '오전|오후',
  'da manhã|da tarde',
  'a.\u00a0m.|p.\u00a0m.',
  'fm|em',
  'vm.|nm.',
  'a.g|a.k',
  'AN|EW',
  'ጥዋት|ከሰዓት',
  'ص|م',
  'পূৰ্বাহ্ন|অপৰাহ্ন',
  'icheheavo|ichamthi',
  'de la mañana|de la tarde',
  'I bikɛ̂glà|I ɓugajɔp',
  'uluchelo|akasuba',
  'pamilau|pamunyi',
  'пр.об.|сл.об.',
  'སྔ་དྲོ་|ཕྱི་དྲོ་',
  'A.M.|G.M.',
  'फुं|बेलासे',
  'prijepodne|popodne',
  'ᏌᎾᎴ|ᏒᎯᏱᎢᏗᏢ',
  'ب.ن|د.ن',
  'dop.|odp.',
  'yb|yh',
  'Luma lwa K|luma lwa p',
  'Subbaahi|Zaarikay b',
  'सवेर|बाद दपैहर',
  'dopołdnja|wótpołdnja',
  'idiɓa|ebyámu',
  'སྔ་ཆ་|ཕྱི་ཆ་',
  'KI|UT',
  'ŋdi|ɣetrɔ',
  'π.μ.|μ.μ.',
  'atm|ptm',
  'kíkíríg|ngəgógəle',
  'قبل\u200cازظهر|بعدازظهر',
  'subaka|kikiiɗe',
  'ap.|ip.',
  'matin|soir',
  'a.|p.',
  'r.n.|i.n.',
  'm|f',
  'am Vormittag|am Namittag',
  'Mambia|Mog',
  'Safiya|Yamma',
  'לפנה״צ|אחה״צ',
  'dopołdnja|popołdnju',
  'de.|du.',
  'N’ụtụtụ|N’abali',
  'ꎸꄑ|ꁯꋒ',
  'f.h.|e.h.',
  'mbaꞌmbaꞌ|ŋka mbɔ́t nji',
  'utuko|kyiukonyi',
  'Isuk|Wengi',
  'n tufat|n tmeddit',
  'Ĩyakwakya|Ĩyawĩoo',
  'Muhi|Chilo',
  'Adduha|Aluula',
  'Kiroko|Hwaĩ-inĩ',
  'karoon|kooskoliny',
  'ಪೂರ್ವಾಹ್ನ|ಅಪರಾಹ್ನ',
  'makeo|nyiaghuo',
  'sárúwá|cɛɛ́nko',
  'Uhr vörmiddaachs|Uhr nommendaachs',
  'BN|PN',
  'таңкы|түштөн кийинки',
  'TOO|MUU',
  'moies|nomëttes',
  'ntɔ́ngɔ́|mpókwa',
  'ກ່ອນທ່ຽງ|ຫຼັງທ່ຽງ',
  'priešpiet|popiet',
  'Dinda|Dilolo',
  'OD|OT',
  'priekšpusdienā|pēcpusdienā',
  'Ɛnkakɛnyá|Ɛndámâ',
  'RŨ|ŨG',
  'wichishu|mchochil’l',
  'претпладне|попладне',
  'ү.ө.|ү.х.',
  'এ এম|পি এম',
  'PG|PTG',
  'comme|lilli',
  'နံနက်|ညနေ',
  'ǁgoagas|ǃuias',
  'पूर्वाह्न|अपराह्न',
  'maná|kugú',
  'formiddag|ettermiddag',
  'mbaʼámbaʼ|ncwònzém',
  'RW|TŊ',
  'WD|WB',
  'ӕмбисбоны размӕ|ӕмбисбоны фӕстӕ',
  'ਪੂ.ਦੁ.|ਬਾ.ਦੁ.',
  'Fọ mọ́nin|Fọ ívnin',
  'غ.م.|غ.و.',
  'Z.MU.|Z.MW.',
  'kang’ama|kingoto',
  'ЭИ|ЭК',
  'Tesiran|Teipa',
  'ᱥᱮᱛᱟᱜ|ᱧᱤᱫᱟᱹ',
  'Lwamilawu|Pashamihe',
  'صبح، منجهند|منجهند، شام',
  'iđitbeaivet|eahketbeaivet',
  'ib|eb',
  'ND|LK',
  'ⵜⵉⴼⴰⵡⵜ|ⵜⴰⴷⴳⴳⵯⴰⵜ',
  'පෙ.ව.|ප.ව.',
  'dop.|pop.',
  'ip.|ep.',
  'GH|GD',
  'e paradites|e pasdites',
  'пре подне|по подне',
  'முற்பகல்|பிற்பகல்',
  'Taparachu|Ebongi',
  'ก่อนเที่ยง|หลังเที่ยง',
  'ቅድመ ፍርቂ-መዓልቲ|ደሕረ ፍርቀ-መዓልቲ',
  'günortadan öň|günortadan soň',
  'hengihengi|efiafi',
  'ÖÖ|ÖS',
  'Zdat azal|Ḍeffir aza',
  'چۈشتىن بۇرۇن|چۈشتىن كېيىن',
  'дп|пп',
  'TO|TK',
  'SA|CH',
  'Sub|Ngo',
  'Munkyo|Eigulo',
  'kiɛmɛ́ɛm|kisɛ́ndɛ',
  'פֿאַרמיטאָג|נאָכמיטאָג',
  'Àárọ̀|Ọ̀sán',
  'Àárɔ̀|Ɔ̀sán',
];

/** Minus sign, NaN, infinity and exponent separator, '|'-separated. */
const NUMBERS: readonly string[] = [
  '-|NaN|∞|E',
  '-|非數值|∞|E',
  '-|NaN|∞|e',
  '−|NaN|∞|E',
  '−|NaN|∞|×10^',
  '\u061c-|ليس\u00a0رقم|∞|اس',
  '\u200e-|ليس\u00a0رقمًا|∞|E',
  '-|ND|∞|E',
  '-|Терхьаш\u00a0дац|∞|E',
  '\u200f-|NaN|∞|اس',
  '-|ཨང་མད|གྲངས་མེད|E',
  '-|mnn|∞|E',
  '-|NaN|∞|×10^',
  '-|NaN|INF|E',
  '\u200e−|ناعدد|∞|×۱۰^',
  '−|epäluku|∞|E',
  '-|Nuimh|∞|E',
  '\u200e-|NaN|∞|E',
  '-|ՈչԹ|∞|E',
  '-|�|∞|E',
  '-|არ\u00a0არის\u00a0რიცხვი|∞|E',
  '-|сан\u00a0емес|∞|E',
  '\u200e-\u200e|NaN|∞|×۱۰^',
  '-|сан\u00a0эмес|∞|E',
  '-|ບໍ່\u200bແມ່ນ\u200bໂຕ\u200bເລກ|∞|E',
  '-|NS|∞|E',
  '-|ဂဏန်းမဟုတ်သော|∞|E',
  '-|НН|∞|E',
  '-|не\u00a0число|∞|E',
  '-|чыыһыла\u00a0буотах|∞|E',
  '\u061c-|NaN|∞|اس',
  '−|NaN|∞|·10^',
  '−|NaN|∞|e',
  '-|epiloho|∞|E',
  '-|MaL|∞|E',
  '-|san\u00a0däl|∞|E',
  '-|TF|∞|E',
  '-|NaN|∞|Е',
  '-|son\u00a0emas|∞|E',
];

/** Locale names a time-zone name starts with or is a prefix of, '|'-separated. */
const ZONE_NAME_PREFIXES: readonly string[] = [
  'AM|CE|Mar|Nov|PM',
  '',
  'ma|wo|zo',
  'AD|Mar|Nov|am|pm',
  'AD',
  'AM|PM|mars',
  'mars',
  'AM|PM|Samstag',
  'AM|PM|mag|mar|martedì|nov',
  '日',
  'AD|수|월|일|토',
  'AM|PM',
  'mar|martes',
  'mar|martes|nov',
  'dum',
  'AK|AN',
  'Nov',
  'mar|martes|xin',
  'AM|PM|mar|mart',
  'AM|PM|кра',
  'AD|After Yesu|Nov',
  'ср',
  'AM|PM|ala|ara|mar',
  'AM|PM|মে',
  'Du',
  'सम',
  'mar|mart|nov|pet|petak|pon',
  'aC',
  'AM|PM|𑄟𑄬',
  'AM|PM|мар|сен',
  'AD|AM|Mar|Martes|PM',
  'AD|AM|KST|PM',
  'AD|ᎠᏂ',
  'ne|po|pá|so|st',
  'Awst|CC|Maw',
  'AM|PM|marts',
  'Kan',
  'Ala|Alm|Mar|Me|Ut',
  'srj',
  'AM|Ala|Ara|AtY|Fe|Ma|Mars|Me|No|PM|Sa|Se|Su|Ut',
  'CE',
  'Arm|KI|Kan|TK|UT',
  'AD|AM|Mar|Nov|PM',
  'AD|Mar|Nov',
  'aK|ma|mar|marto|me|nov|pK|sa|ve',
  'AM|E|K|L|N|P|PM|R|T|nov',
  'AM|PM|asteartea|asteazkena|astelehena|martxoak|uzt.|uztailak',
  'col|kor|maw',
  'ke|ma|pe|su|ti|to',
  'AD|AM|Lin|Mar|Martes|PM',
  'Mar|Nov|mar|martars',
  'AM|Nov|PM|fr|mo|si|so|ti|to|wo',
  'AD|f|m',
  'martes',
  'AM|PM|મે',
  'Ars|Est|YA',
  'Mar',
  'AM|CE|PM',
  'am|pm',
  'AM|PM|kol|pet|petak|pon',
  'Cs|H|K|P|V',
  'AM|PM|ուր',
  'AM|PM|mar|martedi|martio|nov|ven',
  'AM|M|Mar|Nov|PM',
  'M|Mar|Nov',
  'AM|PM|მარ|პარ|სამ',
  'Sam',
  'Kan|MY',
  'AK|Mar|am|dum|pm',
  'ART|TK|WGT',
  'AM|CE|PM|mar|nov',
  'AM|KO|Kos',
  'AM|PM|मे',
  'sam',
  'Metwoch|Nov',
  'BN|gul',
  'AD|Du|Est|Me|Met',
  'KA',
  'mst',
  'an|pr|tr',
  'Cis',
  'AD|Al|Mar|Nov',
  'ceturtd.|ceturtdiena|marts',
  'MY',
  'NOV|WET|Wetano|Wethatu',
  'AM|PM|lin|mar|mars|me|nov|sam|van',
  'AD|AM|Mar|Martsa|Nov|PM',
  'Ara',
  'AM|CE|PM|Par',
  'AM|PM|മാർ',
  'Ба',
  'Nov|PG|TM',
  'AM|Mar|Nov|PM',
  'PK',
  'နို|ဖေ|မေ|ဩ',
  'AD|Fr|Ma|Mar|Nov',
  'AD|AM|PM|Sin',
  'मे',
  'sas',
  'Kor',
  'Ama|CE',
  'Ama|CE|KD',
  'AD|AM|PM',
  'AM|PM|gru|mar',
  'Mar|Martes|Nov',
  'AM|PM|du|ma|mars|me|so|ve',
  'Mut.',
  'martie',
  'Dum|Mar|martie',
  'AM|PM|вс|ср',
  'AM|CE|Mutarama|PM|mut.',
  'Tom',
  'AK|Mag|Mus|PK',
  'CD',
  'gask',
  'be|du|ga|geas|juov|so',
  'AC|AD|AM|Mar|Nov|PM',
  'ND',
  'AM|PM|mar|ne|nov|pi|po|so|st|ut|št',
  'pet.|petek',
  'kos',
  'AD|AM|China|Chs|PM',
  'CD|CH|GD|GH|Mar|Sbti',
  'Mar|mar|mars',
  'авг|мар|нов|пет|пон|сре',
  'AM|PM|авг|мар|нов|пет|пон',
  'AM|PM|авг|мар|нов|пет|пон|сре',
  'AM|M|Mar|PM',
  'AM|Nov|PM',
  'மே',
  'Bar|Kan|Mar',
  'mart|sen|ýek',
  'Tok',
  'Ara|MS|Mar|Mart|Per',
  'Mar|Mars',
  'سە|شە|چا',
  'AM|PM|پیر',
  'TK|TO|Yak|mar|mart|sen|yan',
  'CH|SA',
  'AM|Chr|Mit|PM|Sam',
  'AD|Mar|Mars|Sam|Ut',
  'AD|AM|Nov|PM|Sin',
  'AF|AZ|Mar|Nov',
  'md|metúkpíápɛ|sd|ss',
];

/** A zone name, its offset in ms and the longer zone names starting with it, '~'-separated. */
const FIXED_ZONE_NAMES: readonly string[] = [
  'ACWST~31500000',
  'Australian Central Daylight Time (South Australia)~37800000',
  'Australian Central Daylight Time (South Australia/New South Wales)~37800000',
  'Australian Central Standard Time (Northern Territory)~34200000',
  'Australian Central Standard Time (South Australia)~34200000',
  'Australian Central Standard Time (South Australia/New South Wales)~34200000',
  'Australian Central Western Standard Time~31500000',
  'Australian Eastern Daylight Time (New South Wales)~39600000',
  'Australian Eastern Daylight Time (Tasmania)~39600000',
  'Australian Eastern Daylight Time (Victoria)~39600000',
  'Australian Eastern Standard Time (New South Wales)~36000000',
  'Australian Eastern Standard Time (Queensland)~36000000',
  'Australian Eastern Standard Time (Tasmania)~36000000',
  'Australian Eastern Standard Time (Victoria)~36000000',
  'CHUT~36000000',
  'Chuuk Time~36000000',
  'Coordinated Universal Time~0',
  'DDUT~36000000',
  'Dumont-d\'Urville Time~36000000',
  'JST~32400000',
  'Japan Standard Time~32400000',
  'PGT~36000000',
  'Papua New Guinea Time~36000000',
  'South Georgia Standard Time~-7200000',
  'UTC~0',
  'Mountain 标准时间~-25200000',
  '协调世界时~0',
  '南乔治亚岛时间~-7200000',
  '夏威夷标准时间~-36000000',
  '巴布亚新几内亚时间~36000000',
  '日本标准时间~32400000',
  '楚克时间~36000000',
  '澳大利亚中西部标准时间~31500000',
  '澳大利亚中部标准时间~34200000',
  '澳大利亚西部标准时间~28800000',
  '迪蒙迪尔维尔时间~36000000',
  'HST~-36000000',
  '世界標準時間~0',
  '南喬治亞時間~-7200000',
  '夏威夷標準時間~-36000000',
  '山區標準時間~-25200000',
  '巴布亞新畿內亞時間~36000000',
  '日本標準時間~32400000',
  '楚克島時間~36000000',
  '澳洲中西部標準時間~31500000',
  '澳洲中部標準時間~34200000',
  '澳洲西部標準時間~28800000',
  '迪蒙迪維爾時間~36000000',
  '巴布亞紐幾內亞時間~36000000',
  '杜蒙杜比爾時間~36000000',
  'Chuukse tijd~36000000',
  'Dumont-d’Urville-tijd~36000000',
  'Hawaii Standard Time~-36000000',
  'Japanse standaardtijd~32400000',
  'Midden-Australische standaardtijd~34200000',
  'Midden-Australische westelijke standaardtijd~31500000',
  'Mountain Standard Time~-25200000',
  'Papoea-Nieuw-Guineese tijd~36000000',
  'Zuid-Georgische tijd~-7200000',
  'gecoördineerde wereldtijd~0',
  'AKST~-32400000',
  'Australian Central Standard Time~34200000',
  'Australian Western Standard Time~28800000',
  'Dumont-d’Urville Time~36000000',
  'South Georgia Time~-7200000',
  'Heure normale d\'Hawaï~-36000000',
  'Temps universel coordonné~0',
  'UTC~0~UTC+05:00~UTC+13:00~UTC−03:00',
  'heure de Chuuk~36000000',
  'heure de Dumont-d’Urville~36000000',
  'heure de Géorgie du Sud~-7200000',
  'heure de la Papouasie-Nouvelle-Guinée~36000000',
  'heure normale de l’Ouest de l’Australie~28800000',
  'heure normale du Japon~32400000',
  'heure normale du centre de l’Australie~34200000',
  'heure normale du centre-ouest de l’Australie~31500000',
  'temps universel coordonné~0',
  'Chuuk-Zeit~36000000',
  'Dumont-d’Urville-Zeit~36000000',
  'Hawaii Normalzeit~-36000000',
  'Japanische Normalzeit~32400000',
  'Koordinierte Weltzeit~0',
  'Papua-Neuguinea-Zeit~36000000',
  'Rocky Mountains Normalzeit~-25200000',
  'Südgeorgische Zeit~-7200000',
  'Westaustralische Normalzeit~28800000',
  'Zentral-/Westaustralische Normalzeit~31500000',
  'Zentralaustralische Normalzeit~34200000',
  'Ora del Chuuk~36000000',
  'Ora della Georgia del Sud~-7200000',
  'Ora della Papua Nuova Guinea~36000000',
  'Ora di Dumont-d’Urville~36000000',
  'Ora solare USA occidentale~-25200000',
  'Ora solare delle Isole Hawaii~-36000000',
  'Ora standard del Giappone~32400000',
  'Ora standard dell’Australia centrale~34200000',
  'Ora standard dell’Australia centroccidentale~31500000',
  'Ora standard dell’Australia occidentale~28800000',
  'Tempo coordinato universale~0',
  'オーストラリア中西部標準時~31500000',
  'オーストラリア中部標準時~34200000',
  'オーストラリア西部標準時~28800000',
  'サウスジョージア時間~-7200000',
  'チューク時間~36000000',
  'デュモン・デュルヴィル基地時間~36000000',
  'ハワイ標準時~-36000000',
  'パプアニューギニア時間~36000000',
  '協定世界時~0',
  '山地標準時~-25200000',
  '日本標準時~32400000',
  '뒤몽뒤르빌 시간~36000000',
  '사우스 조지아 시간~-7200000',
  '산지 표준시~-25200000',
  '오스트레일리아 서부 표준시~28800000',
  '오스트레일리아 중부 표준시~34200000',
  '오스트레일리아 중서부 표준시~31500000',
  '일본 표준시~32400000',
  '추크 시간~36000000',
  '파푸아뉴기니 시간~36000000',
  '하와이 표준시~-36000000',
  '협정 세계시~0',
  'japansk normaltid~32400000',
  'koordinert universaltid~0',
  'papuansk tid~36000000',
  'sentralaustralsk normaltid~34200000',
  'tidssone for Chuukøyene~36000000',
  'tidssone for Dumont d’Urville~36000000',
  'tidssone for Sør-Georgia~-7200000',
  'Fuso horário padrão das montanhas~-25200000',
  'Fuso horário padrão do Havaí~-36000000',
  'Horário Padrão da Austrália Central~34200000',
  'Horário Padrão da Austrália Centro-Ocidental~31500000',
  'Horário Padrão da Austrália Ocidental~28800000',
  'Horário Padrão do Japão~32400000',
  'Horário Universal Coordenado~0',
  'Horário da Geórgia do Sul~-7200000',
  'Horário de Chuuk~36000000',
  'Horário de Dumont-d’Urville~36000000',
  'Horário de Papua-Nova Guiné~36000000',
  'ACST~34200000',
  'Hora Coordenada Universal~0',
  'Hora da Geórgia do Sul~-7200000',
  'Hora de Chuuk~36000000',
  'Hora de Dumont-d’Urville~36000000',
  'Hora de Papua Nova Guiné~36000000',
  'Hora padrão da Austrália Central~34200000~Hora padrão da Austrália Central Ocidental',
  'Hora padrão da Austrália Ocidental~28800000',
  'Hora padrão do Japão~32400000',
  'Hora estándar de Hawaii~-36000000',
  'Hora estándar de las Rocosas~-25200000',
  'hora de Chuuk~36000000',
  'hora de Dumont-d’Urville~36000000',
  'hora de Georgia del Sur~-7200000',
  'hora de Papúa Nueva Guinea~36000000',
  'hora estándar de Australia central~34200000',
  'hora estándar de Australia centroccidental~31500000',
  'hora estándar de Australia occidental~28800000',
  'hora estándar de Japón~32400000',
  'hora universal coordinada~0',
  'tiempo universal coordinado~0',
  'Chuuktid~36000000',
  'Dumont d’Urville-tid~36000000',
  'Hawaii, normaltid~-36000000',
  'Mountain, normaltid~-25200000',
  'Papua Nya Guineas tid~36000000',
  'centralaustralisk normaltid~34200000',
  'koordinerad universell tid~0',
  'sydgeorgisk tid~-7200000',
  'västaustralisk normaltid~28800000',
  'västcentralaustralisk normaltid~31500000',
  'Chuuk-tyd~36000000',
  'Dumont-d’Urville-tyd~36000000',
  'Gekoördineerde universele tyd~0',
  'Japan-standaardtyd~32400000',
  'Papoea-Nieu-Guinee-tyd~36000000',
  'Sentraal-Australiese standaardtyd~34200000',
  'Sentraal-westelike Australiese standaard-tyd~31500000',
  'Suid-Georgië-tyd~-7200000',
  'የተቀነባበረ ሁለገብ ሰዓት~0',
  'የቹክ ሰዓት~36000000',
  'የአውስትራሊያ መካከለኛ መደበኛ የሰዓት አቆጣጠር~34200000',
  'የአውስትራሊያ መካከለኛ ምስራቃዊ መደበኛ ሰዓት አቆጣጠር~31500000',
  'የአውስትራሊያ ምስራቃዊ መደበኛ ሰዓት አቆጣጠር~28800000',
  'የደቡብ ጂዮርጂያ ሰዓት~-7200000',
  'የዱሞንት-ዱርቪል ሰዓት~36000000',
  'የጃፓን መደበኛ ሰዓት~32400000',
  'የፓፗ ኒው ጊኒ ሰዓት~36000000',
  'ጂ ኤም ቲ~0~ጂ ኤም ቲ+0500~ጂ ኤም ቲ+1300~ጂ ኤም ቲ-0300',
  'التوقيت العالمي المنسق~0',
  'توقيت اليابان الرسمي~32400000',
  'توقيت بابوا غينيا الجديدة~36000000',
  'توقيت جنوب جورجيا~-7200000',
  'توقيت دي مونت دو روفيل~36000000',
  'توقيت شوك~36000000',
  'توقيت غرب أستراليا الرسمي~28800000',
  'توقيت غرب وسط أستراليا الرسمي~31500000',
  'توقيت وسط أستراليا الرسمي~34200000',
  'غرينتش~0~غرينتش+٠٥:٠٠~غرينتش+١٣:٠٠~غرينتش-٠٣:٠٠',
  'غرينتش~0~غرينتش+05:00~غرينتش+13:00~غرينتش-03:00',
  'অষ্ট্ৰেলিয়াৰ কেন্দ্ৰীয় পাশ্চাত্য মান সময়~31500000',
  'অষ্ট্ৰেলিয়াৰ কেন্দ্ৰীয় মান সময়~34200000',
  'অষ্ট্ৰেলিয়াৰ পাশ্চাত্য মান সময়~28800000',
  'চ্চুকৰ সময়~36000000',
  'জাপানৰ মান সময়~32400000',
  'ডুমোণ্ট-ডি আৰ্ভিলৰ সময়~36000000',
  'দক্ষিণ জৰ্জিয়াৰ সময়~-7200000',
  'পাপুৱা নিউ গিনিৰ সময়~36000000',
  'সমন্বিত সাৰ্বজনীন সময়~0',
  'Hora coordinada universal~0',
  'Hora de Papúa Nueva Guinea~36000000',
  'Hora de Xeorxa del Sur~-7200000',
  'Hora estándar de Xapón~32400000',
  'Hora estándar d’Australia central~34200000~Hora estándar d’Australia central del oeste',
  'Hora estándar d’Australia del oeste~28800000',
  'Cənubi Corciya Vaxtı~-7200000',
  'Dümon-d’Ürvil Vaxtı~36000000',
  'Koordinasiya edilmiş ümumdünya vaxtı~0',
  'Mərkəzi Avstraliya Standart Vaxtı~34200000',
  'Mərkəzi Qərbi Avstraliya Standart Vaxtı~31500000',
  'Papua Yeni Qvineya Vaxtı~36000000',
  'Qərbi Avstraliya Standart Vaxtı~28800000',
  'Yaponiya Standart Vaxtı~32400000',
  'Çuuk Vaxtı~36000000',
  'Стандартны цэнтральна-заходні час Аўстраліі~31500000',
  'Стандартны час Японіі~32400000',
  'Стандартны час заходняй Аўстраліі~28800000',
  'Стандартны час цэнтральнай Аўстраліі~34200000',
  'Універсальны каардынаваны час~0',
  'Час Папуа-Новай Гвінеі~36000000',
  'Час Паўднёвай Георгіі~-7200000',
  'Час Трука~36000000',
  'Час станцыі Дзюмон-Дзюрвіль~36000000',
  'Австралия – западно централно стандартно време~31500000',
  'Гринуич~0~Гринуич+05:00~Гринуич+13:00~Гринуич-03:00',
  'Дюмон Дюрвил~36000000',
  'Западноавстралийско стандартно време~28800000',
  'Координирано универсално време~0',
  'Папуа Нова Гвинея~36000000',
  'Централноавстралийско стандартно време~34200000',
  'Чуюк~36000000',
  'Южна Джорджия~-7200000',
  'Японско стандартно време~32400000',
  'অস্ট্রেলীয় কেন্দ্রীয় পশ্চিমি মানক সময়~31500000',
  'অস্ট্রেলীয় কেন্দ্রীয় মানক সময়~34200000',
  'অস্ট্রেলীয় পশ্চিমি মানক সময়~28800000',
  'চুক সময়~36000000',
  'জাপান মানক সময়~32400000',
  'ডুমন্ট-দ্য’উরভিলে সময়~36000000',
  'দক্ষিণ জর্জিয়া সময়~-7200000',
  'পাপুয়া নিউ গিনি সময়~36000000',
  'স্থানাংকিত আন্তর্জাতিক সময়~0',
  'amzer hollvedel kenurzhiet~0',
  'eur Chuuk~36000000',
  'eur Dumont-d’Urville~36000000',
  'eur Georgia ar Su~-7200000',
  'eur Papoua-Ginea-Nevez~36000000',
  'eur cʼhoañv Aostralia ar Cʼhornôg~28800000',
  'eur cʼhoañv Japan~32400000',
  'eur cʼhoañv Kreizaostralia~34200000~eur cʼhoañv Kreizaostralia ar Cʼhornôg',
  'जपान स्टैंडर्ड टाईम~32400000',
  'ट्रुक स्टैंडर्ड टाईम~36000000',
  'ड्युमों ड्युरवील स्टैंडर्ड टाईम~36000000',
  'दक्षिण ओस्ट्रेलिया स्टैंडर्ड टाईम~28800000',
  'पापुआ न्यु गीनी स्टैंडर्ड टाईम~36000000',
  'मध्य ओस्ट्रेलिया स्टैंडर्ड टाईम~34200000',
  'मध्य-पश्चीम ओस्ट्रेलिया स्टैंडर्ड टाईम~31500000',
  'साऊथ जॉर्जिया स्टैंडर्ड टाईम~-7200000',
  'Australijsko centralnozapadno standardno vrijeme~31500000',
  'Centralnoaustralijsko standardno vrijeme~34200000',
  'Japansko standardno vrijeme~32400000',
  'Južnodžordžijsko vrijeme~-7200000',
  'Koordinirano svjetsko vrijeme~0',
  'Vrijeme na Papui Novoj Gvineji~36000000',
  'Vrijeme stanice Dumont-d’Urville~36000000',
  'Zapadnoaustralijsko standardno vrijeme~28800000',
  'Čučko vrijeme~36000000',
  'Hora de Dumont d’Urville~36000000',
  'Hora de Geòrgia del Sud~-7200000',
  'Hora de Papua Nova Guinea~36000000',
  'Hora estàndard del Japó~32400000',
  'Hora estàndard d’Austràlia Central~34200000',
  'Hora estàndard d’Austràlia Occidental~28800000',
  'Hora estàndard d’Austràlia centre-occidental~31500000',
  'Temps universal coordinat~0',
  '𑄃𑄧𑄌𑄴𑄑𑄳𑄢𑄬𑄣𑄨𑄠𑄧 𑄃𑄏𑄧𑄣𑄴 𑄉𑄧𑄢𑄳𑄦𑄢𑄴 𑄟𑄚𑄧𑄇𑄴 𑄃𑄧𑄇𑄴𑄖𑄧~34200000',
  '𑄃𑄧𑄌𑄴𑄑𑄳𑄢𑄬𑄣𑄨𑄠𑄧 𑄛𑄧𑄏𑄨𑄟𑄬𑄘𑄨 𑄟𑄚𑄧𑄇𑄴 𑄃𑄧𑄇𑄴𑄖𑄧~28800000',
  '𑄌𑄪𑄇𑄴 𑄃𑄧𑄇𑄴𑄖𑄧~36000000',
  '𑄎𑄛𑄚𑄴 𑄟𑄚𑄧𑄇𑄴 𑄃𑄧𑄇𑄴𑄖𑄧~32400000',
  '𑄓𑄪𑄟𑄧𑄚𑄴𑄑𑄴-𑄘𑄳𑄠𑄧 𑄅𑄪𑄢𑄴𑄞𑄨𑄣𑄬 𑄃𑄧𑄇𑄴𑄖𑄧~36000000',
  '𑄘𑄇𑄴𑄘𑄨𑄠 𑄛𑄨𑄖𑄴𑄗𑄨𑄟𑄨𑄢𑄴 𑄃𑄧𑄇𑄴𑄖𑄧~0',
  '𑄘𑄧𑄉𑄨𑄚𑄴 𑄎𑄧𑄢𑄴𑄎𑄨𑄠 𑄃𑄧𑄇𑄴𑄖𑄧~-7200000',
  '𑄛𑄛𑄪𑄠 𑄚𑄨𑄃𑄪 𑄉𑄨𑄚𑄨 𑄃𑄧𑄇𑄴𑄖𑄧~36000000',
  'Дюмон-д’Юрвиль~36000000',
  'Къилба Георги~-7200000',
  'Малхбузен Австрали, стандартан хан~28800000',
  'Папуа – Керла Гвиней~36000000',
  'Чуук~36000000',
  'Юккъера Австрали, малхбузен стандартан хан~31500000',
  'Юккъера Австрали, стандартан хан~34200000',
  'Япон, стандартан хан~32400000',
  'Gikoordinar nga Kinatibuk-ang Oras~0',
  'Oras sa Chuuk~36000000',
  'Oras sa Dumont-d’Urville~36000000',
  'Oras sa Papua New Guinea~36000000',
  'Oras sa South Georgia~-7200000',
  'Tamdanang Oras sa Central Australia~34200000',
  'Tamdanang Oras sa Central Western Australia~31500000',
  'Tamdanang Oras sa Japan~32400000',
  'Tamdanang Oras sa Western Australia~28800000',
  'ᎠᏰᏟ ᎡᎳᏗᏜ ᎠᏟᎶᏍᏗ ᎠᏟᎢᎵᏒ~34200000',
  'ᎠᏰᏟ ᎡᎳᏗᏜ ᏭᏕᎵᎬ ᏗᏜ ᎠᏟᎶᏍᏗ ᎠᏟᎢᎵᏒ~31500000',
  'ᎡᎳᏗᏜ ᏭᏕᎵᎬ ᏗᏜ ᎠᏟᎶᏍᏗ ᎠᏟᎢᎵᏒ~28800000',
  'ᎢᎩᏠᏱ ᏂᎦᏓ ᎠᏟᎢᎵᏒ~0',
  'ᏆᏇ ᎢᏤ ᎩᎢᏂ ᎠᏟᎢᎵᏒ~36000000',
  'ᏚᎼᎾᏘ-Ꮧ’ᎤᎵᏫᎵ ᎠᏟᎢᎵᏒ~36000000',
  'ᏣᏩᏂᏏ ᎠᏟᎶᏍᏗ ᎠᏟᎢᎵᏒ~32400000',
  'ᏧᎦᎾᏮ ᏣᎠᏥᎢ ᎠᏟᎢᎵᏒ~-7200000',
  'ᏧᎩ ᎠᏟᎢᎵᏒ~36000000',
  'Chuukský čas~36000000',
  'Japonský standardní čas~32400000',
  'Koordinovaný světový čas~0',
  'Středoaustralský standardní čas~34200000',
  'Středozápadní australský standardní čas~31500000',
  'Západoaustralský standardní čas~28800000',
  'Čas Jižní Georgie~-7200000',
  'Čas Papuy-Nové Guiney~36000000',
  'Čas stanice Dumonta d’Urvilla~36000000',
  'Amser Chuuk~36000000',
  'Amser Cyffredniol Cydlynol~0',
  'Amser De Georgia~-7200000',
  'Amser Dumont-d’Urville~36000000',
  'Amser Papua Guinea Newydd~36000000',
  'Amser Safonol Canolbarth Awstralia~34200000',
  'Amser Safonol Canolbarth Gorllewin Awstralia~31500000',
  'Amser Safonol Gorllewin Awstralia~28800000',
  'Amser Safonol Japan~32400000',
  'Centralaustralsk normaltid~34200000',
  'Chuuk-tid~36000000',
  'Dumont-d’Urville-tid~36000000',
  'Japansk normaltid~32400000',
  'Koordineret universaltid~0',
  'Papua Ny Guinea-tid~36000000',
  'South Georgia-tid~-7200000',
  'तालमेली आलमी समां~0',
  'Chuukski cas~36000000',
  'DumontDUrville cas~36000000',
  'Japański standardny cas~32400000',
  'Papua-Nowoginejski cas~36000000',
  'Pódpołdnjowogeorgiski cas~-7200000',
  'Pódwjacornoawstralski standardny cas~28800000',
  'Srjejźoawstralski standardny cas~34200000',
  'Srjejźopódwjacorny awstralski standardny cas~31500000',
  'ཇ་པཱན་ཚད་ལྡན་ཆུ་ཚོད~32400000',
  'ཇི་ཨེམ་ཊི་~0',
  'དབུས་ནུབ་ཕྱོགས་ཨཱོས་ཊྲེལ་ལི་ཡ་ཚད་ལྡན་ཆུ་ཚོད~31500000',
  'དབུས་ཕྱོགས་ཨཱོས་ཊྲེལ་ལི་ཡ་ཚད་ལྡན་ཆུ་ཚོད~34200000',
  'ནུབ་ཕྱོགས་ཨཱོས་ཊྲེལ་ལི་ཡ་ཚད་ལྡན་ཆུ་ཚོད~28800000',
  'Australian Central Western nutome gaƒoƒo me~31500000',
  'Australian Central nutome gaƒoƒo me~34200000',
  'Australian Western nutome gaƒoƒo me~28800000',
  'Chuuk gaƒoƒo me~36000000',
  'Dumont-d’Urville gaƒoƒo me~36000000',
  'Japan nutome gaƒoƒo me~32400000',
  'Papua New Guinea gaƒoƒo me~36000000',
  'South Georgia gaƒoƒo me~-7200000',
  'Xexeme gaƒoƒoɖoanyi me~0',
  'Ώρα Ντιμόν ντ’ Ουρβίλ~36000000',
  'Ώρα Νότιας Γεωργίας~-7200000',
  'Ώρα Παπούας Νέας Γουινέας~36000000',
  'Ώρα Τσουκ~36000000',
  'Συντονισμένη Παγκόσμια Ώρα~0',
  'Χειμερινή ώρα Δυτικής Αυστραλίας~28800000',
  'Χειμερινή ώρα Ιαπωνίας~32400000',
  'Χειμερινή ώρα Κεντρικής Αυστραλίας~34200000',
  'Χειμερινή ώρα Κεντροδυτικής Αυστραλίας~31500000',
  'Austraalia Kesk-Lääne standardaeg~31500000',
  'Chuuki aeg~36000000',
  'Dumont-d’Urville’i aeg~36000000',
  'Jaapani standardaeg~32400000',
  'Kesk-Austraalia standardaeg~34200000',
  'Koordineeritud maailmaaeg~0',
  'Lääne-Austraalia standardaeg~28800000',
  'Lõuna-Georgia aeg~-7200000',
  'Paapua Uus-Guinea aeg~36000000',
  'Australiako erdi-mendebaldeko ordu estandarra~31500000',
  'Australiako erdialdeko ordu estandarra~34200000',
  'Australiako mendebaldeko ordu estandarra~28800000',
  'Chuukeko ordua~36000000',
  'Dumont-d’Urvilleko ordua~36000000',
  'Hegoaldeko Georgietako ordua~-7200000',
  'Japoniako ordu estandarra~32400000',
  'Papua Ginea Berriko ordua~36000000',
  'ordu unibertsal koordinatua~0',
  'زمان هماهنگ جهانی~0',
  'وقت جورجیای جنوبی~-7200000',
  'وقت دومون دورویل~36000000',
  'وقت عادی غرب استرالیا~28800000',
  'وقت عادی مرکز استرالیا~34200000',
  'وقت عادی مرکز-غرب استرالیا~31500000',
  'وقت عادی ژاپن~32400000',
  'وقت پاپوا گینهٔ نو~36000000',
  'وقت چوئوک~36000000',
  'گرینویچ~0',
  'Chuukin aika~36000000',
  'Dumont d’Urvillen aika~36000000',
  'Etelä-Georgian aika~-7200000',
  'Japanin normaaliaika~32400000',
  'Keski-Australian normaaliaika~34200000',
  'Länsi-Australian normaaliaika~28800000',
  'Läntisen Keski-Australian normaaliaika~31500000',
  'Papua-Uuden-Guinean aika~36000000',
  'UTC~0~UTC+05.00~UTC+13.00~UTC-03.00~UTC-yleisaika',
  'Oras sa Timog Georgia~-7200000',
  'Standard Time ng Gitnang Kanluran ng Australya~31500000',
  'Standard na Oras sa Gitnang Australya~34200000',
  'Standard na Oras sa Japan~32400000',
  'Standard na Oras sa Kanlurang Australya~28800000',
  'Chuuk tíð~36000000',
  'Dumont-d’Urville tíð~36000000',
  'Japan vanlig tíð~32400000',
  'Papua Nýguinea tíð~36000000',
  'Samskipað heimstíð~0',
  'Suðurgeorgiaoyggjar tíð~-7200000',
  'mið Avstralia vanlig tíð~34200000',
  'miðvestur Avstralia vanlig tíð~31500000',
  'Chuukse tiid~36000000',
  'Dumont-d’Urville tiid~36000000',
  'Japanske standerttiid~32400000',
  'Midden-Australyske standerttiid~34200000',
  'Midden-Australyske westelijke standerttiid~31500000',
  'Papoea-Nij-Guineeske tiid~36000000',
  'Sûd-Georgyske tiid~-7200000',
  'Am Caighdeánach Iarthar na hAstráile~28800000',
  'Am Caighdeánach Lár na hAstráile~34200000',
  'Am Caighdeánach Mheániarthar na hAstráile~31500000',
  'Am Caighdeánach na Seapáine~32400000',
  'Am Chuuk~36000000',
  'Am Nua-Ghuine Phapua~36000000',
  'Am Stáisiún Dumont-d’Urville~36000000',
  'Am Uilíoch Lárnach~0',
  'Am na Seoirsia Theas~-7200000',
  'Bun-àm Astràilia an Iar~28800000',
  'Bun-àm Meadhan Astràilia~34200000~Bun-àm Meadhan Astràilia an Iar',
  'Bun-àm na Seapaine~32400000',
  'Àm Chuuk~36000000',
  'Àm Dumont-d’Urville~36000000',
  'Àm Gini Nuaidh Paputhaiche~36000000',
  'Àm Seòrsea a Deas~-7200000',
  'Àm Uile-choitcheann Co-òrdanaichte~0',
  'Horario de Chuuk~36000000',
  'Horario de Dumont-d’Urville~36000000',
  'Horario de Papúa-Nova Guinea~36000000',
  'Horario de Xeorxia do Sur~-7200000',
  'Horario estándar de Australia Central~34200000',
  'Horario estándar de Australia Occidental~28800000~Horario estándar de Australia Occidental Central',
  'Horario estándar do Xapón~32400000',
  'Horario universal coordinado~0',
  'ઑસ્ટ્રેલિયન કેન્દ્રીય પશ્ચિમી માનક સમય~31500000',
  'ઑસ્ટ્રેલિયન કેન્દ્રીય માનક સમય~34200000',
  'ઑસ્ટ્રેલિયન પશ્ચિમી માનક સમય~28800000',
  'ચુઉક સમય~36000000',
  'જાપાન માનક સમય~32400000',
  'ડ્યુમોન્ટ-ડી‘ઉર્વિલ સમય~36000000',
  'દક્ષિણ જ્યોર્જિયા સમય~-7200000',
  'પાપુઆ ન્યુ ગિની સમય~36000000',
  'સંકલિત યુનિવર્સલ સમય~0',
  'Hadewa Lokaci na Duniya~0',
  'Lokacin Chuuk~36000000',
  'Lokacin Dumont-d’Urville~36000000',
  'Lokacin Kudancin Georgia~-7200000',
  'Lokacin Papua New Guinea~36000000',
  'Tsayayyen Lokacin Tsakiyar Austiraliya~34200000',
  'Tsayayyen Lokacin Yammacin Austiralia~28800000',
  'Tsayayyen Lokacin Yammacin Tsakiyar Austiraliya~31500000',
  'זמן אוניברסלי מתואם~0',
  'שעון דומון ד׳אורוויל~36000000',
  'שעון דרום ג׳ורג׳יה~-7200000',
  'שעון יפן (חורף)~32400000',
  'שעון מערב אוסטרליה (חורף)~28800000',
  'שעון מרכז אוסטרליה (חורף)~34200000',
  'שעון מרכז-מערב אוסטרליה (חורף)~31500000',
  'שעון פפואה גיניאה החדשה~36000000',
  'שעון צ׳וק~36000000',
  'ऑस्ट्रेलियाई पश्चिमी मानक समय~28800000',
  'ऑस्\u200dट्रेलियाई केंद्रीय पश्चिमी मानक समय~31500000',
  'ऑस्\u200dट्रेलियाई केंद्रीय मानक समय~34200000',
  'चुक समय~36000000',
  'जापान मानक समय~32400000',
  'ड्यूमोंट डी अर्विले समय~36000000',
  'दक्षिणी जॉर्जिया समय~-7200000',
  'पापुआ न्यू गिनी समय~36000000',
  'समन्वित वैश्विक समय~0',
  'australsko središnje zapadno standardno vrijeme~31500000',
  'japansko standardno vrijeme~32400000',
  'koordinirano svjetsko vrijeme~0',
  'srednjoaustralsko standardno vrijeme~34200000',
  'vrijeme Chuuka~36000000',
  'vrijeme Dumont-d’Urvillea~36000000',
  'vrijeme Južne Georgije~-7200000',
  'vrijeme Papue Nove Gvineje~36000000',
  'zapadnoaustralsko standardno vrijeme~28800000',
  'Dumont d´ Urvilleski čas~36000000',
  'chuukski čas~36000000',
  'japanski standardny čas~32400000',
  'južnogeorgiski čas~-7200000',
  'papua-nowoginejski čas~36000000',
  'srjedźoawstralski standardny čas~34200000',
  'srjedźozapadny awstralski standardny čas~31500000',
  'zapadoawstralski standardny čas~28800000',
  'dumont-d’Urville-i idő~36000000',
  'déli-georgiai idő~-7200000',
  'japán téli idő~32400000',
  'koordinált világidő~0',
  'közép-ausztráliai téli idő~34200000',
  'közép-nyugat-ausztráliai téli idő~31500000',
  'nyugat-ausztráliai téli idő~28800000',
  'pápua új-guineai idő~36000000',
  'truki idő~36000000',
  'Արևմտյան Ավստրալիայի ստանդարտ ժամանակ~28800000',
  'Դյումոն դ’Յուրվիլի ժամանակ~36000000',
  'Կենտրոնական Ավստրալիայի արևմտյան ստանդարտ ժամանակ~31500000',
  'Կենտրոնական Ավստրալիայի ստանդարտ ժամանակ~34200000',
  'Համաշխարհային կոորդինացված ժամանակ~0',
  'Հարավային Ջորջիայի ժամանակ~-7200000',
  'Ճապոնիայի ստանդարտ ժամանակ~32400000',
  'Պապուա Նոր Գվինեայի ժամանակ~36000000',
  'Տրուկի ժամանակ~36000000',
  'Universal Tempore Coordinate~0',
  'Nhazi Oge Ụwa Niile~0',
  'Oge Chuuk~36000000',
  'Oge Dumont-d’Urville~36000000',
  'Oge Izugbe Etiti Australia~34200000',
  'Oge Izugbe Japan~32400000',
  'Oge Izugbe Mpaghara Ọdịda Anyanwụ Australia~28800000',
  'Oge Izugbe Mpaghara Ọdịda Anyanwụ Etiti Australia~31500000',
  'Oge Papua New Guinea~36000000',
  'Oge South Georgia~-7200000',
  'Chuuk-tími~36000000',
  'Samræmdur alþjóðlegur tími~0',
  'Staðaltími í Japan~32400000',
  'Staðaltími í Mið-Ástralíu~34200000',
  'Staðaltími í Vestur-Ástralíu~28800000',
  'Staðaltími í miðvesturhluta Ástralíu~31500000',
  'Suður-Georgíutími~-7200000',
  'Tími á Dumont-d’Urville~36000000',
  'Tími á Papúa Nýju-Gíneu~36000000',
  'デュモンデュルヴィル時間~36000000',
  '中西部標準時(オーストラリア)~31500000',
  '南ジョージア島標準時~-7200000',
  'Wektu Chuuk~36000000',
  'Wektu Dumont-d’Urville~36000000',
  'Wektu Georgia Kidul~-7200000',
  'Wektu Papua Nugini~36000000',
  'Wektu Standar Australia Tengah~34200000~Wektu Standar Australia Tengah sisih Kulon',
  'Wektu Standar Australia sisih Kulon~28800000',
  'Wektu Standar Jepang~32400000',
  'Wektu Universal Kakoordhinasi~0',
  'ავსტრალიის ცენტრალური სტანდარტული დრო~34200000',
  'დასავლეთ ავსტრალიის სტანდარტული დრო~28800000',
  'დუმონ-დურვილის დრო~36000000',
  'იაპონიის სტანდარტული დრო~32400000',
  'მსოფლიო კოორდინირებული დრო~0',
  'პაპუა-ახალი გვინეის დრო~36000000',
  'სამხრეთ გეორგიის დრო~-7200000',
  'ჩუუკის დრო~36000000',
  'ცენტრალური და დასავლეთ ავსტრალიის სტანდარტული დრო~31500000',
  'Ora Padron di Austrália Osidental~28800000',
  'Ora Padron di Austrália Sentral~34200000',
  'Ora Padron di Austrália Sentru-Osidental~31500000',
  'Ora Universal Kordenadu~0',
  'Австралия стандартты батыс уақыты~28800000',
  'Австралия стандартты орталық уақыты~34200000',
  'Австралия стандартты орталық-батыс уақыты~31500000',
  'Дюмон-д’Юрвиль уақыты~36000000',
  'Дүниежүзілік үйлестірілген уақыт~0',
  'Жапония стандартты уақыты~32400000',
  'Оңтүстік Георгия уақыты~-7200000',
  'Папуа – Жаңа Гвинея уақыты~36000000',
  'Трук уақыты~36000000',
  'ម៉ោងសកលដែលមានការសម្រួល~0',
  'ម៉ោង\u200bនៅប៉ាពូអាស៊ី នូវែលហ្គីណេ~36000000',
  'ម៉ោង\u200bនៅ\u200bកោះ\u200bហ្សកហ្ស៊ី~-7200000',
  'ម៉ោង\u200bនៅ\u200bចូអុក~36000000',
  'ម៉ោង\u200bនៅ\u200bឌុយម៉ុងដឺអ៊ុយវីល~36000000',
  'ម៉ោង\u200bសកល~0~ម៉ោង\u200bសកល +05:00~ម៉ោង\u200bសកល +13:00~ម៉ោង\u200bសកល -03:00',
  'ម៉ោង\u200bស្តង់ដារ\u200bនៅ\u200bជប៉ុន~32400000',
  'ម៉ោង\u200bស្តង់ដារ\u200bនៅ\u200bភាគ\u200bខាង\u200bលិច\u200bនៃ\u200bអូស្ត្រាលី\u200bកណ្ដាល~31500000',
  'ម៉ោង\u200bស្តង់ដារ\u200bនៅ\u200bអូស្ត្រាលី\u200bកណ្ដាល~34200000',
  'ម៉ោង\u200b\u200bស្តង់ដារ\u200bនៅ\u200bអូស្ត្រាលី\u200bខាង\u200bលិច~28800000',
  'ಆಸ್ಟ್ರೇಲಿಯಾದ ಕೇಂದ್ರ ಪಶ್ಚಿಮ ಪ್ರಮಾಣಿತ ಸಮಯ~31500000',
  'ಆಸ್ಟ್ರೇಲಿಯಾದ ಕೇಂದ್ರ ಪ್ರಮಾಣಿತ ಸಮಯ~34200000',
  'ಆಸ್ಟ್ರೇಲಿಯಾದ ಪಶ್ಚಿಮ ಪ್ರಮಾಣಿತ ಸಮಯ~28800000',
  'ಚುಕ್ ಸಮಯ~36000000',
  'ಜಪಾನ್ ಪ್ರಮಾಣಿತ ಸಮಯ~32400000',
  'ಡುಮಂಟ್-ಡಿ ಉರ್ವಿಲೆ ಸಮಯ~36000000',
  'ದಕ್ಷಿಣ ಜಾರ್ಜಿಯಾ ಸಮಯ~-7200000',
  'ಪಪುವಾ ನ್ಯೂ ಗಿನಿಯಾ ಸಮಯ~36000000',
  'ಸಂಘಟಿತ ಸಾರ್ವತ್ರಿಕ ಸಮಯ~0',
  'ऑस्ट्रेलीयन अस्तंत प्रमाणित वेळ~28800000',
  'ऑस्ट्रेलीयन मध्य अस्तंत प्रमाणित वेळ~31500000',
  'ऑस्ट्रेलीयन मध्य प्रमाणित वेळ~34200000',
  'चुक वेळ~36000000',
  'जपान प्रमाणित वेळ~32400000',
  'दक्षिण जॉर्जिया वेळ~-7200000',
  'द्युमाँ दूरवीय वेळ~36000000',
  'पापुआ न्यु गिनी वेळ~36000000',
  'समन्वित वैश्विक वेळ~0',
  'آسٹریلِیَن مرکزی سٹینڑاڑ ٹایِم~34200000',
  'آسٹریلِیَن مرکزی مغربی سٹینڑاڑ ٹایِم~31500000',
  'آسٹریلِیَن مغرِبی سٹینڑاڑ ٹایِم~28800000',
  'جاپٲنۍ سٹینڑاڑ ٹایِم~32400000',
  'شُمٲلی جورجِیا ٹایِم~-7200000',
  'ٹٔرک ٹایِم~36000000',
  'پاپُعا نیوٗ گؠنی ٹایِم~36000000',
  'ڑمانٹ ڈی اُرویٖل ٹایِم~36000000',
  'Австралия батыш кышкы убакыты~28800000',
  'Австралия борбордук батыш кышкы убакыты~31500000',
  'Австралия борбордук кышкы убакыты~34200000',
  'Бирдиктүү дүйнөлүк убакыт~0',
  'Дюмон-д-Урвил убактысы~36000000',
  'Жапон кышкы убакыты~32400000',
  'Папуа-Жаңы Гвинея убакыты~36000000',
  'Түштүк Жоржия убактысы~-7200000',
  'Чуук убактысы~36000000',
  'Chuuk-Zäit~36000000',
  'Dumont-d’Urville-Zäit~36000000',
  'Japanesch Normalzäit~32400000',
  'Papua-Neiguinea-Zäit~36000000',
  'Südgeorgesch Zäit~-7200000',
  'Zentral-/Westaustralesch Normalzäit~31500000',
  'Zentralaustralesch Normalzäit~34200000',
  'ເວລາຈໍເຈຍໃຕ້~-7200000',
  'ເວລາຊຸກ~36000000',
  'ເວລາດູມອງດູວິລ~36000000',
  'ເວລາປາປົວກິນີ~36000000',
  'ເວລາສາກົນເຊີງພິກັດ~0',
  'ເວ\u200bລາມາດ\u200bຕະ\u200bຖານອອ\u200bສ\u200bເຕຣ\u200bເລຍ\u200bກ\u200bາງ~34200000',
  'ເວ\u200bລາ\u200bມາດ\u200bຕະ\u200bຖານອອສ\u200bເຕຣ\u200bລຽນ\u200bກາງ\u200bຕາ\u200bເວັນ\u200bຕົກ~31500000',
  'ເວ\u200bລາ\u200bມາດ\u200bຕະ\u200bຖານ\u200bຍີ່\u200bປຸ່ນ~32400000',
  'ເວ\u200bລາ\u200bມາ\u200bດ\u200bຕະ\u200bຖານອອສ\u200bເຕຣ\u200bລຽນ\u200bຕາ\u200bເວັນ\u200bຕົກ~28800000',
  'Centrinės Australijos žiemos laikas~34200000',
  'Centrinės vakarų Australijos žiemos laikas~31500000',
  'Diumono d’Urvilio laikas~36000000',
  'Japonijos žiemos laikas~32400000',
  'Papua Naujosios Gvinėjos laikas~36000000',
  'Pietų Džordžijos laikas~-7200000',
  'Vakarų Australijos žiemos laikas~28800000',
  'pasaulio suderintasis laikas~0',
  'Čuko laikas~36000000',
  'Austrālijas centrālais rietumu ziemas laiks~31500000',
  'Austrālijas centrālais ziemas laiks~34200000',
  'Austrālijas rietumu ziemas laiks~28800000',
  'Dienviddžordžijas laiks~-7200000',
  'Dimondirvilas laiks~36000000',
  'Japānas ziemas laiks~32400000',
  'Papua-Jaungvinejas laiks~36000000',
  'Universālais koordinētais laiks~0',
  'Čūkas laiks~36000000',
  'Wā Aonui Kōtuitui~0',
  'Време во Јужна Грузија~-7200000',
  'Време во Димон Дирвил~36000000',
  'Време во Папуа Нова Гвинеја~36000000',
  'Време во Чуук~36000000',
  'Координирано универзално време~0',
  'Стандардно време во Јапонија~32400000',
  'Стандардно време во Западна Австралија~28800000',
  'Стандардно време во Централна Австралија~34200000',
  'Стандардно време во Централна и Западна Австралија~31500000',
  'ഓസ്ട്രേലിയൻ സെൻട്രൽ പടിഞ്ഞാറൻ സ്റ്റാൻഡേർഡ് സമയം~31500000',
  'ഓസ്ട്രേലിയൻ സെൻട്രൽ സ്റ്റാൻഡേർഡ് സമയം~34200000',
  'ഓസ്\u200cട്രേലിയൻ പടിഞ്ഞാറൻ സ്റ്റാൻഡേർഡ് സമയം~28800000',
  'കോർഡിനേറ്റഡ് യൂണിവേഴ്\u200cസൽ ടൈം~0',
  'ചൂക്ക് സമയം~36000000',
  'ജപ്പാൻ സ്റ്റാൻഡേർഡ് സമയം~32400000',
  'ജിഎംടി~0~ജിഎംടി +05:00~ജിഎംടി +13:00~ജിഎംടി -03:00',
  'ഡുമോണ്ട് ഡി ഉർവില്ലെ സമയം~36000000',
  'ദക്ഷിണ ജോർജ്ജിയൻ സമയം~-7200000',
  'പാപ്പുവ ന്യൂ ഗിനിയ സമയം~36000000',
  'Австралийн баруун эргийн стандарт цаг~28800000',
  'Австралийн төв баруун эргийн стандарт цаг~31500000',
  'Дюмон д’Юрвилийн цаг~36000000',
  'Олон улсын зохицуулалттай цаг~0',
  'Папуа Шинэ Гвинейн цаг~36000000',
  'Төв Австралийн стандарт цаг~34200000',
  'Чүүкийн цаг~36000000',
  'Японы стандарт цаг~32400000',
  'Өмнөд Жоржиагийн цаг~-7200000',
  'কোওর্দিনেটেদ য়ুনিভর্সেল টাইম~0',
  'জি এম টি~0~জি এম টি +০৫:০০~জি এম টি +১৩:০০~জি এম টি -০৩:০০',
  '[GMT]~0~[GMT]+०५:००~[GMT]+१३:००~[GMT]-०३:००',
  'ऑस्ट्रेलियन पश्चिम प्रमाण वेळ~28800000',
  'ऑस्ट्रेलियन मध्य प्रमाण वेळ~34200000',
  'ऑस्ट्रेलियन मध्य-पश्चिम प्रमाण वेळ~31500000',
  'चूक वेळ~36000000',
  'जपान प्रमाण वेळ~32400000',
  'ड्युमॉन्ट-ड्युर्विल वेळ~36000000',
  'पापुआ न्यू गिनी वेळ~36000000',
  'ချုခ် အချိန်~36000000',
  'ဂျပန် စံတော်ချိန်~32400000',
  'ညှိထားသည့် ကမ္ဘာ့ စံတော်ချိန်~0',
  'တောင်ဂျော်ဂျီယာ အချိန်~-7200000',
  'ဒူးမော့တ် ဒါရ်ဗီးလ် အချိန်~36000000',
  'ပါပူအာနယူးဂီနီ အချိန်~36000000',
  'သြစတြေးလျား အနောက်အလယ်ပိုင်း စံတော်ချိန်~31500000',
  'အနောက်ဩစတြေးလျ စံတော်ချိန်~28800000',
  'ဩစတြေးလျ အလယ်ပိုင်း စံတော်ချိန်~34200000',
  'केन्द्रीय अस्ट्रेलिया मानक समय~34200000',
  'केन्द्रीय पश्चिमी अस्ट्रेलिया मानक समय~31500000',
  'चुउक समय~36000000',
  'डुमोन्ट-डी‘ उर्भिले समय~36000000',
  'दक्षिण जर्जिया समय~-7200000',
  'पपूवा न्यू गिनी समय~36000000',
  'पश्चिमी अस्ट्रेलिया मानक समय~28800000',
  'समन्वित विश्व समय~0',
  'sentralaustralsk standardtid~34200000',
  'tidssone for Chuukøyane~36000000',
  'tidssone for Dumont-d’Urville~36000000',
  'ଅଷ୍ଟ୍ରେଲିୟ ପଶ୍ଚିମ ମାନାଙ୍କ ସମୟ~28800000',
  'ଅଷ୍ଟ୍ରେଲିୟ ମଧ୍ୟ ପଶ୍ଚିମ ମାନାଙ୍କ ସମୟ~31500000',
  'ଅଷ୍ଟ୍ରେଲିୟ ମଧ୍ୟ ମାନାଙ୍କ ସମୟ~34200000',
  'ଚୂକ୍\u200c ସମୟ~36000000',
  'ଜାପାନ ମାନାଙ୍କ ସମୟ~32400000',
  'ଡୁମୋଣ୍ଟ-ଡି‘ଉରଭିଲ୍ଲେ ସମୟ~36000000',
  'ଦକ୍ଷିଣ ଜର୍ଜିଆ ସମୟ~-7200000',
  'ପପୁଆ ନ୍ୟୁ ଗୁନିଆ ସମୟ~36000000',
  'ସମନ୍ୱିତ ସାର୍ବଜନୀନ ସମୟ~0',
  'ਆਸਟ੍ਰੇਲੀਆਈ ਕੇਂਦਰੀ ਪੱਛਮੀ ਮਿਆਰੀ ਵੇਲਾ~31500000',
  'ਆਸਟ੍ਰੇਲੀਆਈ ਕੇਂਦਰੀ ਮਿਆਰੀ ਵੇਲਾ~34200000',
  'ਆਸਟ੍ਰੇਲੀਆਈ ਪੱਛਮੀ ਮਿਆਰੀ ਵੇਲਾ~28800000',
  'ਕੋਔਰਡੀਨੇਟੇਡ ਵਿਆਪਕ ਵੇਲਾ~0',
  'ਚੂਕ ਵੇਲਾ~36000000',
  'ਜਪਾਨ ਮਿਆਰੀ ਵੇਲਾ~32400000',
  'ਡਿਉਮੋਂਟ ਡਿਉਰਵਿਲੇ ਵੇਲਾ~36000000',
  'ਦੱਖਣੀ ਜਾਰਜੀਆ ਵੇਲਾ~-7200000',
  'ਪਾਪੂਆ ਨਿਊ ਗਿਨੀ ਵੇਲਾ~36000000',
  'Arénjmẹnt ọf Di Hól Wọld Taim~0',
  'Chuk Taim~36000000',
  'Diúmọ́n-d’Uvil Taim~36000000',
  'Japan Fíksd Taim~32400000',
  'Pápuá Niú Gíni Taim~36000000',
  'Saút Jọ́jia Taim~-7200000',
  'Ọstrélia Mídúl Fíksd Taim~34200000',
  'Ọstrélia Mídúl Wẹ́stán Fíksd Taim~31500000',
  'Ọstrélia Wẹ́stán Fíksd Taim~28800000',
  'Japonia (czas standardowy)~32400000',
  'czas Chuuk~36000000',
  'czas Dumont-d’Urville~36000000',
  'czas Georgia Południowa~-7200000',
  'czas Papua-Nowa Gwinea~36000000',
  'czas zachodnioaustralijski standardowy~28800000',
  'czas środkowo-zachodnioaustralijski standardowy~31500000',
  'czas środkowoaustralijski standardowy~34200000',
  'uniwersalny czas koordynowany~0',
  'آسترالوي لوېديځ معياري وخت~28800000',
  'آسترالوي مرکزي لوېديځ معياري وخت~31500000',
  'آسترالوي مرکزي معياري وخت~34200000',
  'جاپان معياري وخت~32400000',
  'د سویل جورجیا وخت~-7200000',
  'همغږى نړیوال وخت~0',
  'پاپوا نیو ګنی وخت~36000000',
  'چوک وخت~36000000',
  'ډومونټ ډي ارول~36000000',
  'Hora Estandar de Australia Central~34200000~Hora Estandar de Australia Central Occidental',
  'Hora Estandar de Australia Occidental~28800000',
  'Hora Estandar de Japón~32400000',
  'Hora de Georgia del Sur~-7200000',
  'Hora de Papua Nueva Guinea~36000000',
  'Tiqsimuyuntin Tupachisqa Hora~0',
  'Temp universal coordinà~0',
  'Ora Georgiei de Sud~-7200000',
  'Ora din Chuuk~36000000',
  'Ora din Dumont-d’Urville~36000000',
  'Ora din Papua Noua Guinee~36000000',
  'Ora standard a Australiei Central Occidentale~31500000',
  'Ora standard a Australiei Centrale~34200000',
  'Ora standard a Australiei Occidentale~28800000',
  'Ora standard a Japoniei~32400000',
  'Timpul universal coordonat~0',
  'Всемирное координированное время~0',
  'Западная Австралия, стандартное время~28800000',
  'Папуа – Новая Гвинея~36000000',
  'Трук~36000000',
  'Центральная Австралия, западное стандартное время~31500000',
  'Центральная Австралия, стандартное время~34200000',
  'Южная Георгия~-7200000',
  'Япония, стандартное время~32400000',
  'समन्वितः वैश्विक समय:~0',
  'Арҕаа Австралия сүрүн кэмэ~28800000',
  'Дьоппуон сүрүн кэмэ~32400000',
  'Киин Австралия сүрүн кэмэ~34200000',
  'ᱠᱚᱨᱰᱤᱱᱮᱴᱮᱰ ᱭᱩᱱᱤᱣᱟᱨᱥᱟᱞ ᱚᱠᱛᱚ~0',
  'ᱡᱤᱮᱢᱴᱤ~0~ᱡᱤᱮᱢᱴᱤ+᱐᱕:᱐᱐~ᱡᱤᱮᱢᱴᱤ+᱑᱓:᱐᱐~ᱡᱤᱮᱢᱴᱤ-᱐᱓:᱐᱐',
  'آسٽريليا جو مرڪزي معياري وقت~34200000',
  'آسٽريليا جو مرڪزي مغربي معياري وقت~31500000',
  'آسٽريليا جو مغربي معياري وقت~28800000',
  'جاپان جو معياري وقت~32400000',
  'م ع و~0',
  'پاپوا نيو گني جو وقت~36000000',
  'چيوڪ جو وقت~36000000',
  'ڊومانٽ درويئل جو وقت~36000000',
  'ڏکڻ جارجيا جو وقت~-7200000',
  'گڏيل دنياوي وقت~0',
  'Chuuka áigi~36000000',
  'Dumont-d’Urville áigi~36000000',
  'Gaska-Austrália dálveáigi~34200000',
  'Gaska-Austrália oarjjabeali dálveáigi~31500000',
  'Japána dálveáigi~32400000',
  'Lulli-Georgia áigi~-7200000',
  'Oarje-Austrália dálveáigi~28800000',
  'Papua Ođđa-Guinea áigi~36000000',
  'koordinerejuvvon oktasaš áigi~0',
  'ඕස්ට්\u200dරේලියානු සම්මත වේලාව~34200000',
  'ග්\u200dරිමවේ~0~ග්\u200dරිමවේ+05.00~ග්\u200dරිමවේ+13.00~ග්\u200dරිමවේ-03.00',
  'චුක් වේලාව~36000000',
  'ජපාන සම්මත වේලාව~32400000',
  'දකුණු ජෝජියා වේලාව~-7200000',
  'දුමොන්ත්-ඩ්උර්විල් වේලාව~36000000',
  'පැපුවා නිව් ගිනීයා වේලාව~36000000',
  'බටහිර ඕස්ට්\u200dරේලියානු සම්මත වේලාව~28800000',
  'මධ්\u200dයම බටහිර ඔස්ට්\u200dරේලියානු සම්මත වේලාව~31500000',
  'සමකක්ෂ සාර්ව වේලාව~0',
  'chuukský čas~36000000',
  'japonský štandardný čas~32400000',
  'koordinovaný svetový čas~0',
  'stredoaustrálsky štandardný čas~34200000',
  'stredozápadný austrálsky štandardný čas~31500000',
  'západoaustrálsky štandardný čas~28800000',
  'čas Južnej Georgie~-7200000',
  'čas Papuy-Novej Guiney~36000000',
  'čas stanice Dumonta d’Urvillea~36000000',
  'Avstralski centralni standardni čas~34200000',
  'Avstralski centralni zahodni standardni čas~31500000',
  'Avstralski zahodni standardni čas~28800000',
  'Japonski standardni čas~32400000',
  'Južnogeorgijski čas~-7200000',
  'Papuanski čas~36000000',
  'univerzalni koordinirani čas~0',
  'Čas: Dumont-d’Urville~36000000',
  'Čas: Otok Chuuk~36000000',
  'Waqtiga Babuw Niyuu Giniya~36000000',
  'Waqtiga Caadiga Ah ee Bartamaha Astaraaliya~34200000',
  'Waqtiga Caadiga Ah ee Bartamaha Galbeedka Astaraaliya~31500000',
  'Waqtiga Caadiga Ah ee Galbeedka Astaraaliya~28800000',
  'Waqtiga Caadiga Ah ee Jabaan~32400000',
  'Waqtiga Dumont - d’urfille~36000000',
  'Waqtiga Isku-xiran ee Caalamka~0',
  'Waqtiga Juuk~36000000',
  'Waqtiga Sowt Joorjiya~-7200000',
  'Waqtiga UTC~0',
  'Ora e Dumont-d’Urvilës~36000000',
  'Ora e Guinesë së Re-Papua~36000000',
  'Ora e Xhorxhas të Jugut~-7200000',
  'Ora e Çukut~36000000',
  'Ora standarde e Australisë Perëndimore~28800000',
  'Ora standarde e Australisë Qendrore~34200000',
  'Ora standarde e Australisë Qendroro-Perëndimore~31500000',
  'Ora standarde e Japonisë~32400000',
  'Ora universale e koordinuar~0',
  'Јапанско стандардно време~32400000',
  'Јужна Џорџија време~-7200000',
  'Аустралијско западно стандардно време~28800000',
  'Аустралијско централно западно стандардно време~31500000',
  'Аустралијско централно стандардно време~34200000',
  'Димон д’Урвил време~36000000',
  'Координисано универзално време~0',
  'Папуа Нова Гвинеја време~36000000',
  'Чуук време~36000000',
  'Mfumo wa kuratibu saa ulimwenguni~0',
  'Saa za Chuuk~36000000',
  'Saa za Dumont-d’Urville~36000000',
  'Saa za Georgia Kusini~-7200000',
  'Saa za Papua New Guinea~36000000',
  'Saa za Wastani za Australia Magharibi~28800000',
  'Saa za Wastani za Australia ya Kati~34200000',
  'Saa za Wastani za Japani~32400000',
  'Saa za Wastani za Magharibi ya Kati ya Australia~31500000',
  'Saa ya Ulimwenguni~0',
  'Saa za Jojia Kusini~-7200000',
  'Saa za Papua~36000000',
  'Saa za Wastani za Magharibi mwa Australia ya Kati~31500000',
  'ஆஸ்திரேலியன் மத்திய நிலையான நேரம்~34200000',
  'ஆஸ்திரேலியன் மத்திய மேற்கத்திய நிலையான நேரம்~31500000',
  'ஆஸ்திரேலியன் மேற்கத்திய நிலையான நேரம்~28800000',
  'ஒருங்கிணைந்த சர்வதேச நேரம்~0',
  'சுக் நேரம்~36000000',
  'ஜப்பான் நிலையான நேரம்~32400000',
  'டுமோண்ட்-டி உர்வில்லே நேரம்~36000000',
  'தெற்கு ஜார்ஜியா நேரம்~-7200000',
  'பபுவா நியூ கினியா நேரம்~36000000',
  'ఆస్ట్రేలియన్ పశ్చిమ ప్రామాణిక సమయం~28800000',
  'ఆస్ట్రేలియా మధ్యమ ప్రామాణిక సమయం~34200000',
  'చక్ సమయం~36000000',
  'జపాన్ ప్రామాణిక సమయం~32400000',
  'డ్యూమాంట్-డి’ఉర్విల్లే సమయం~36000000',
  'దక్షిణ జార్జియా సమయం~-7200000',
  'పాపువా న్యూ గినియా సమయం~36000000',
  'మధ్యమ ఆస్ట్రేలియన్ పశ్చిమ ప్రామాణిక సమయం~31500000',
  'సమన్వయ సార్వజనీన సమయం~0',
  'Вақти ҷаҳонии ҳамоҳангсозӣ~0',
  'เวลาชุก~36000000',
  'เวลาดูมองต์ดูร์วิลล์~36000000',
  'เวลาปาปัวนิวกินี~36000000',
  'เวลามาตรฐานญี่ปุ่น~32400000',
  'เวลามาตรฐานทางตอนกลางของออสเตรเลีย~34200000',
  'เวลามาตรฐานทางตะวันตกของออสเตรเลีย~28800000',
  'เวลามาตรฐานทางตะวันตกตอนกลางของออสเตรเลีย~31500000',
  'เวลาสากลเชิงพิกัด~0',
  'เวลาเซาท์จอร์เจีย~-7200000',
  'Dýumon-d-Ýurwil wagty~36000000',
  'Günbatar Awstraliýa standart wagty~28800000',
  'Günorta Georgiýa wagty~-7200000',
  'Merkezi Awstraliýa günbatar standart wagty~31500000',
  'Merkezi Awstraliýa standart wagty~34200000',
  'Papua - Täze Gwineýa wagty~36000000',
  'Utgaşdyrylýan ähliumumy wagt~0',
  'Çuuk wagty~36000000',
  'Ýaponiýa standart wagty~32400000',
  'houa fakapapuaniukini~36000000',
  'houa fakasiapani taimi totonu~32400000',
  'houa fakasiosiatonga~-7200000',
  'houa fakatūke~36000000',
  'houa fakatūmoni-tūvile~36000000',
  'houa fakaʻaositelēlia-hihifo taimi totonu~28800000',
  'houa fakaʻaositelēlia-loto taimi totonu~34200000',
  'houa fakaʻaositelēlia-loto-hihifo taimi totonu~31500000',
  'taimi fakaemāmani~0',
  'Batı Avustralya Standart Saati~28800000',
  'Chuuk Saati~36000000',
  'Dumont-d’Urville Saati~36000000',
  'Eş Güdümlü Evrensel Zaman~0',
  'Güney Georgia Saati~-7200000',
  'Japonya Standart Saati~32400000',
  'Orta Avustralya Standart Saati~34200000',
  'Papua Yeni Gine Saati~36000000',
  'İç Batı Avustralya Standart Saati~31500000',
  'Бөтендөнья килештерелгән вакыты~0',
  'ئاۋسترالىيە ئوتتۇرا قىسىم ئۆلچەملىك ۋاقتى~34200000',
  'ئاۋسترالىيە غەربىي قىسىم ئۆلچەملىك ۋاقتى~28800000',
  'ئاۋستىرالىيە ئوتتۇرا غەربىي قىسىم ئۆلچەملىك ۋاقتى~31500000',
  'جەنۇبىي جورجىيە ۋاقتى~-7200000',
  'دۇمونت-دۇرۋىل ۋاقتى~36000000',
  'ياپونىيە ئۆلچەملىك ۋاقتى~32400000',
  'پاپۇئا يېڭى گىۋىنېيەسى ۋاقتى~36000000',
  'چۇك ۋاقتى~36000000',
  'за всесвітнім координованим часом~0',
  'за стандартним західноавстралійським часом~28800000',
  'за стандартним центральноавстралійським часом~34200000',
  'за стандартним центральнозахідним австралійським часом~31500000',
  'за часом на островах Папуа-Нова Ґвінея~36000000',
  'за часом на островах Чуук~36000000',
  'за часом на острові Південна Джорджія~-7200000',
  'за часом у Дюмон дʼЮрвіль~36000000',
  'за японським стандартним часом~32400000',
  'آسٹریلیا ویسٹرن اسٹینڈرڈ ٹائم~28800000',
  'آسٹریلین سنٹرل اسٹینڈرڈ ٹائم~34200000',
  'آسٹریلین سنٹرل ویسٹرن اسٹینڈرڈ ٹائم~31500000',
  'جاپان سٹینڈرڈ ٹائم~32400000',
  'جنوبی جارجیا ٹائم~-7200000',
  'پاپوآ نیو گنی ٹائم~36000000',
  'چوک ٹائم~36000000',
  'ڈومونٹ-ڈی’ارویلے ٹائم~36000000',
  'کوآرڈینیٹڈ یونیورسل ٹائم~0',
  'Chuuk vaqti~36000000',
  'Dyumon-d’Yurvil vaqti~36000000',
  'G‘arbiy Avstraliya standart vaqti~28800000',
  'Janubiy Georgiya vaqti~-7200000',
  'Koordinatali universal vaqt~0',
  'Markaziy Avstraliya g‘arbiy standart vaqti~31500000',
  'Markaziy Avstraliya standart vaqti~34200000',
  'Papua-Yangi Gvineya vaqti~36000000',
  'Yaponiya standart vaqti~32400000',
  'Giờ Chuuk~36000000',
  'Giờ Chuẩn Miền Tây Australia~28800000',
  'Giờ Chuẩn Nhật Bản~32400000',
  'Giờ Dumont-d’Urville~36000000',
  'Giờ Nam Georgia~-7200000',
  'Giờ Papua New Guinea~36000000',
  'Giờ Phối hợp Quốc tế~0',
  'CUT (waxtu iniwelsel yuñ boole)~0',
  'Àpapọ̀ Àkókò Àgbáyé~0',
  'Àpapɔ̀ Àkókò Àgbáyé~0',
  '協調世界時間~0',
  'Isikhathi esivamile sase-Japan~32400000',
  'Isikhathi sase-Australian Central West esivamile~31500000',
  'Isikhathi sase-Australian Central esivamile~34200000',
  'Isikhathi sase-Australian Western esivamile~28800000',
  'Isikhathi sase-Chuuk~36000000',
  'Isikhathi sase-Dumont-d’Urville~36000000',
  'Isikhathi sase-Papua New Guinea~36000000',
  'Isikhathi sase-South Georgia~-7200000',
  'isikhathi somhlaba esididiyelwe~0',
];

/** Indexes into FIXED_ZONE_NAMES of each locale's fixed zone names. */
const FIXED_ZONES: ReadonlyArray<readonly number[]> = [
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
  ],
  [
    0, 14, 17, 19, 25, 21, 24, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
  ],
  [
    0, 14, 17, 36, 19, 21, 24, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47,
  ],
  [
    0, 14, 17, 36, 19, 21, 24, 37, 38, 39, 48, 42, 49, 43, 44, 45, 46,
  ],
  [
    0, 14, 50, 17, 51, 52, 19, 53, 54, 55, 56, 21, 57, 24, 58, 59,
  ],
  [
    0, 60, 61, 6, 62, 14, 15, 16, 17, 63, 36, 52, 19, 20, 21, 22, 64, 24,
  ],
  [
    0, 61, 6, 62, 14, 15, 16, 17, 63, 52, 19, 20, 21, 22, 64, 24,
  ],
  [
    0, 14, 17, 65, 19, 21, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75,
  ],
  [
    0, 14, 17, 65, 19, 21, 67, 68, 69, 70, 71, 72, 73, 76,
  ],
  [
    0, 14, 77, 17, 78, 79, 19, 80, 81, 21, 82, 83, 84, 24, 85, 86, 87,
  ],
  [
    0, 14, 17, 19, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 21, 98, 24,
  ],
  [
    0, 14, 17, 19, 21, 24, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109,
  ],
  [
    0, 14, 17, 19, 21, 24, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120,
  ],
  [
    0, 14, 17, 36, 52, 19, 56, 21, 24, 121, 122, 123, 124, 125, 126, 127,
  ],
  [
    0, 14, 17, 128, 129, 130, 131, 132, 133, 134, 135, 136, 137, 138, 19, 21, 24,
  ],
  [
    139, 0, 14, 17, 52, 140, 141, 142, 143, 144, 145, 146, 147, 19, 56, 21, 24,
  ],
  [
    0, 14, 17, 148, 149, 19, 21, 24, 150, 151, 152, 153, 154, 155, 156, 157, 158,
  ],
  [
    0, 14, 17, 148, 149, 19, 21, 24, 150, 151, 152, 153, 154, 155, 156, 157, 159,
  ],
  [
    0, 14, 160, 17, 161, 162, 19, 163, 21, 164, 24, 165, 121, 166, 167, 168, 169,
  ],
  [
    0, 14, 170, 17, 171, 172, 52, 19, 173, 56, 21, 174, 175, 176, 177, 24,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 178, 179, 180, 181, 182, 183, 184, 185, 186, 187,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 188, 189, 190, 191, 192, 193, 194, 195, 196, 198,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 199, 200, 201, 202, 203, 204, 205, 206, 207,
  ],
  [
    0, 14, 17, 52, 208, 142, 143, 209, 210, 211, 212, 213, 19, 56, 21, 24,
  ],
  [
    0, 14, 214, 17, 215, 52, 19, 216, 56, 217, 218, 21, 219, 220, 24, 221, 222,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 223, 224, 225, 226, 227, 228, 229, 230, 231,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 232, 233, 234, 235, 236, 237, 238, 239, 240, 241,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 242, 243, 244, 245, 246, 247, 248, 249, 250,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 251, 252, 253, 254, 255, 256, 257, 258,
  ],
  [
    0, 14, 16, 17, 52, 19, 21, 24, 259, 260, 261, 262, 263, 264, 265, 266,
  ],
  [
    0, 267, 14, 268, 17, 52, 19, 269, 270, 271, 56, 21, 24, 272, 273, 274, 275,
  ],
  [
    0, 14, 17, 52, 142, 276, 277, 278, 279, 280, 281, 282, 19, 56, 21, 283, 24,
  ],
  [
    0, 6, 14, 17, 52, 19, 56, 21, 24, 284, 285, 286, 287, 288, 289, 290, 291,
  ],
  [
    0, 14, 16, 17, 52, 19, 56, 21, 24, 292, 293, 294, 295, 296, 297, 298, 299,
  ],
  [
    0, 14, 17, 300, 52, 19, 56, 301, 302, 303, 304, 21, 305, 306, 307, 308, 24,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 309, 310, 311, 312, 313, 314, 315, 316, 317,
  ],
  [
    0, 14, 318, 17, 52, 19, 319, 320, 56, 21, 321, 322, 24, 323, 324, 325, 326,
  ],
  [
    0, 327, 328, 329, 330, 331, 332, 333, 334, 335, 14, 17, 52, 19, 56, 21, 24,
  ],
  [
    0, 14, 336, 337, 17, 338, 52, 19, 339, 340, 56, 21, 341, 342, 24,
  ],
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 343,
  ],
  [
    0, 14, 344, 16, 17, 345, 52, 19, 346, 56, 21, 347, 348, 349, 350, 351, 24,
  ],
  [
    0, 14, 15, 16, 17, 18, 52, 19, 21, 22, 23, 24, 352, 353, 354, 355, 356,
  ],
  [
    0, 357, 358, 359, 14, 360, 17, 361, 52, 19, 362, 56, 21, 363, 364, 24, 365,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 366, 367, 368, 369, 370, 371, 372, 373, 374,
  ],
  [
    0, 375, 14, 376, 17, 377, 52, 19, 378, 379, 380, 381, 382, 56, 21, 383, 24,
  ],
  [
    0, 384, 385, 386, 14, 387, 17, 388, 52, 389, 19, 390, 56, 21, 391, 24, 392,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 393, 394, 395, 396, 397, 398, 399, 400, 401, 402,
  ],
  [
    0, 14, 403, 17, 404, 405, 52, 19, 406, 407, 408, 409, 56, 21, 410, 411,
  ],
  [
    0, 14, 16, 17, 52, 19, 56, 301, 302, 303, 412, 21, 413, 414, 415, 416, 24,
  ],
  [
    0, 14, 417, 17, 418, 52, 19, 419, 56, 21, 420, 421, 422, 24, 423, 424,
  ],
  [
    0, 14, 425, 16, 17, 426, 52, 19, 427, 428, 429, 21, 430, 431, 24,
  ],
  [
    0, 432, 433, 434, 435, 436, 437, 438, 439, 440, 14, 17, 52, 19, 56, 21, 24,
  ],
  [
    0, 441, 442, 443, 14, 17, 52, 19, 56, 21, 24, 444, 445, 446, 447, 448,
  ],
  [
    0, 14, 17, 52, 449, 450, 451, 452, 453, 454, 455, 456, 19, 56, 21, 24,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 457, 458, 459, 460, 461, 462, 463, 464, 465,
  ],
  [
    0, 14, 17, 466, 52, 19, 20, 467, 468, 469, 470, 56, 21, 471, 472, 473, 24,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 474, 475, 476, 477, 478, 479, 480, 481, 482,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 483, 484, 485, 486, 487, 488, 489, 490, 491,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 492, 493, 494, 495, 496, 497, 498, 499, 500,
  ],
  [
    0, 14, 16, 17, 501, 52, 19, 56, 21, 24, 502, 503, 504, 505, 506, 507, 508,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 509, 510, 511, 512, 513, 514, 515, 516, 517,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 518, 519, 520, 521, 522, 523, 524, 525, 526,
  ],
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 52, 19, 20, 56, 21, 22, 23, 24, 527,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24,
  ],
  [
    0, 14, 17, 52, 19, 56, 528, 529, 530, 531, 532, 533, 534, 535, 536, 21, 24,
  ],
  [
    0, 14, 537, 17, 52, 19, 56, 21, 538, 539, 540, 541, 542, 543, 544, 545, 24,
  ],
  [
    0, 14, 17, 19, 21, 24, 103, 546, 106, 547, 107, 548, 109,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 549, 550, 551, 552, 553, 554, 555, 556,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 557, 558, 559, 560, 561, 562, 563, 564, 565,
  ],
  [
    0, 14, 15, 17, 18, 52, 19, 20, 56, 566, 567, 568, 569, 21, 22, 23, 24,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 570, 571, 572, 573, 574, 575, 576, 577, 578,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 579, 580, 581, 582, 583, 584, 585, 586, 587, 588,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 589, 590, 591, 592, 593, 594, 595, 596, 597,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 598, 599, 600, 601, 602, 603, 604, 605, 606,
  ],
  [
    0, 14, 16, 17, 52, 19, 21, 24, 607, 608, 609, 610, 611, 612, 613, 614,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 615, 616, 617, 618, 619, 620, 621, 622, 623,
  ],
  [
    0, 14, 624, 16, 17, 625, 52, 19, 626, 56, 21, 627, 628, 24, 629, 630,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 631, 632, 633, 634, 635, 636, 637, 638, 639,
  ],
  [
    0, 14, 640, 641, 17, 642, 52, 19, 643, 56, 21, 644, 645, 24, 646, 647, 648,
  ],
  [
    0, 649, 650, 651, 14, 17, 652, 653, 52, 19, 654, 56, 21, 655, 24, 656, 657,
  ],
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 491,
  ],
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 658,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 659, 660, 661, 662, 663, 664, 665, 666, 667,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 668, 669, 670, 671, 672, 673, 674, 675, 676, 677,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 678, 679, 680, 681, 682, 683, 684, 685, 686,
  ],
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 687, 688,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 689, 690, 691, 692, 693, 694, 695, 603, 696, 606,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 697, 698, 699, 700, 701, 702, 703, 704, 705,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 706, 707, 708, 487, 709, 710, 711, 712, 713,
  ],
  [
    0, 14, 17, 36, 52, 19, 56, 21, 24, 121, 122, 123, 714, 715, 716, 127,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 717, 718, 719, 720, 721, 722, 723, 724, 725,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 726, 727, 728, 729, 730, 731, 732, 733, 734,
  ],
  [
    0, 735, 14, 736, 17, 737, 52, 19, 738, 56, 21, 739, 740, 24, 741, 742, 743,
  ],
  [
    0, 14, 17, 52, 19, 744, 56, 21, 24, 745, 746, 747, 748, 749, 750, 751, 752,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 753, 754, 755, 756, 757, 758, 759, 760, 761,
  ],
  [
    0, 14, 17, 52, 130, 131, 132, 133, 134, 135, 136, 137, 138, 19, 56, 21, 24,
  ],
  [
    0, 14, 17, 52, 762, 763, 764, 142, 143, 765, 766, 19, 56, 21, 767, 24,
  ],
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 768, 24,
  ],
  [
    0, 14, 17, 52, 19, 56, 769, 770, 771, 772, 773, 774, 775, 776, 21, 777, 24,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 778, 292, 779, 780, 781, 782, 783, 784, 785,
  ],
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 786,
  ],
  [
    0, 6, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 787, 788, 789,
  ],
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 790, 791,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 792, 793, 794, 795, 796, 797, 798, 799, 800, 801,
  ],
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 67,
  ],
  [
    0, 14, 802, 17, 803, 804, 805, 52, 19, 806, 807, 56, 808, 21, 809, 24, 810,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 811, 812, 813, 814, 815, 816, 817, 818, 819, 820,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 821, 822, 823, 824, 825, 826, 827, 828, 829,
  ],
  [
    0, 830, 831, 832, 14, 17, 52, 19, 833, 834, 56, 21, 835, 24, 836, 837, 838,
  ],
  [
    0, 14, 17, 36, 52, 19, 56, 21, 24, 839, 840, 841, 842, 843, 844, 845, 846, 847, 848,
  ],
  [
    0, 14, 17, 52, 19, 56, 849, 850, 851, 852, 853, 854, 855, 856, 857, 21, 24,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 858, 859, 860, 861, 862, 863, 864, 865, 866,
  ],
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24,
  ],
  [
    0, 14, 17, 52, 19, 867, 56, 21, 868, 869, 870, 871, 872, 873, 874, 875, 24,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 876, 868, 869, 877, 878, 872, 873, 874, 879, 24,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 880, 881, 882, 883, 884, 885, 886, 887, 888,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 889, 890, 891, 892, 893, 894, 895, 896, 897,
  ],
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 898,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 899, 900, 901, 902, 903, 904, 905, 906, 907,
  ],
  [
    0, 14, 17, 908, 909, 910, 52, 19, 911, 912, 56, 21, 913, 24, 914, 915, 916,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 917, 918, 919, 920, 921, 922, 923, 924, 925,
  ],
  [
    0, 926, 14, 927, 17, 928, 929, 930, 52, 19, 931, 56, 932, 21, 933, 24, 934,
  ],
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 935,
  ],
  [
    0, 14, 16, 17, 52, 19, 56, 21, 24, 936, 937, 938, 939, 940, 941, 942, 943,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 944, 945, 946, 947, 948, 949, 950, 951, 952,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 953, 954, 955, 956, 957, 958, 959, 960, 961,
  ],
  [
    0, 14, 962, 17, 963, 964, 52, 19, 965, 966, 967, 968, 56, 21, 969, 24, 970,
  ],
  [
    0, 14, 17, 971, 972, 973, 974, 975, 976, 977, 52, 19, 56, 21, 24,
  ],
  [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 978, 15, 17, 18, 19, 20, 21, 22, 23, 24,
  ],
  [
    0, 61, 6, 14, 15, 17, 63, 52, 19, 20, 56, 21, 22, 64, 24, 979,
  ],
  [
    0, 61, 6, 14, 15, 17, 63, 52, 19, 20, 56, 21, 22, 64, 24, 980,
  ],
  [
    0, 14, 17, 52, 19, 56, 21, 24, 981, 38, 48, 42, 49, 43, 44, 45, 46,
  ],
  [
    0, 14, 17, 52, 982, 983, 984, 985, 986, 987, 988, 989, 19, 56, 21, 24, 990,
  ],
];

/** Indexes into the tables above in their order, flags (1 Buddhist, 2 en_US zone names), and the setLocale names. */
const LOCALES: ReadonlyArray<readonly [data: readonly number[], names: readonly string[]]> = [
  [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [
      '', 'nds', 'nds_DE', 'nds_NL',
    ],
  ],
  [
    [1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 0],
    [
      'Chinese (China)', 'zh', 'zh_CN', 'zh_CN_#Hans',
    ],
  ],
  [
    [2, 2, 2, 2, 1, 2, 1, 1, 1, 1, 2, 0],
    [
      'Chinese (Hong Kong)', 'zh_HK', 'zh_HK_#Hans', 'zh_HK_#Hant', 'zh_MO', 'zh_MO_#Hans', 'zh_MO_#Hant',
    ],
  ],
  [
    [3, 3, 2, 2, 1, 2, 2, 1, 1, 1, 3, 0],
    [
      'Chinese (Taiwan)', 'zh_TW', 'zh_TW_#Hant',
    ],
  ],
  [
    [4, 4, 0, 3, 2, 3, 3, 2, 0, 2, 4, 0],
    [
      'Dutch (Belgian)', 'nl_BE',
    ],
  ],
  [
    [5, 5, 0, 3, 2, 3, 3, 2, 0, 2, 4, 0],
    [
      'Dutch (Standard)', 'nl', 'nl_AW', 'nl_BQ', 'nl_CW', 'nl_NL', 'nl_NL_#Latn', 'nl_SR', 'nl_SX',
    ],
  ],
  [
    [6, 6, 3, 4, 3, 0, 4, 3, 2, 3, 5, 0],
    [
      'English (Australian)', 'en_AU',
    ],
  ],
  [
    [7, 7, 3, 5, 3, 4, 4, 2, 2, 4, 6, 0],
    [
      'English (Canadian)', 'en_CA',
    ],
  ],
  [
    [8, 8, 3, 6, 3, 0, 4, 3, 0, 3, 5, 0],
    [
      'English (New Zealand)', 'en_NZ',
    ],
  ],
  [
    [9, 9, 0, 7, 3, 0, 4, 3, 0, 3, 5, 0],
    [
      'English (UK)', 'en_GB',
    ],
  ],
  [
    [10, 10, 3, 6, 3, 0, 4, 0, 0, 1, 6, 2],
    [
      'English (US)', 'agq_CM_#Latn', 'asa_TZ_#Latn', 'ast_ES_#Latn', 'az__#Cyrl', 'az__#Latn', 'bas_CM_#Latn',
      'bem_ZM_#Latn', 'bez_TZ_#Latn', 'brx_IN_#Deva', 'bs__#Cyrl', 'bs__#Latn', 'ccp_BD_#Cakm', 'ceb_PH_#Latn',
      'cgg_UG_#Latn', 'chr_US_#Cher', 'ckb_IQ_#Arab', 'dav_KE_#Latn', 'dje_NE_#Latn', 'doi_IN_#Deva', 'dsb_DE_#Latn',
      'dua_CM_#Latn', 'dyo_SN_#Latn', 'ebu_KE_#Latn', 'en', 'en_AS', 'en_PR', 'en_UM', 'en_US', 'en_US_#Latn', 'en_VI',
      'eo_001_#Latn', 'ewo_CM_#Latn', 'ff__#Adlm', 'ff__#Latn', 'fil_PH_#Latn', 'fur_IT_#Latn', 'gsw_CH_#Latn',
      'guz_KE_#Latn', 'haw_US_#Latn', 'hsb_DE_#Latn', 'ia_001_#Latn', 'jgo_CM_#Latn', 'jmc_TZ_#Latn', 'kab_DZ_#Latn',
      'kam_KE_#Latn', 'kde_TZ_#Latn', 'kea_CV_#Latn', 'khq_ML_#Latn', 'kkj_CM_#Latn', 'kln_KE_#Latn', 'kok_IN_#Deva',
      'ks__#Arab', 'ksb_TZ_#Latn', 'ksf_CM_#Latn', 'ksh_DE_#Latn', 'lag_TZ_#Latn', 'lkt_US_#Latn', 'lrc_IR_#Arab',
      'luo_KE_#Latn', 'luy_KE_#Latn', 'mai_IN_#Deva', 'mas_KE_#Latn', 'mer_KE_#Latn', 'mfe_MU_#Latn', 'mgh_MZ_#Latn',
      'mgo_CM_#Latn', 'mni_IN_#Beng', 'mni__#Beng', 'mua_CM_#Latn', 'mzn_IR_#Arab', 'naq_NA_#Latn', 'nds_DE_#Latn',
      'nmg_CM_#Latn', 'nnh_CM_#Latn', 'nus_SS_#Latn', 'nyn_UG_#Latn', 'pa__#Arab', 'pa__#Guru', 'pcm_NG_#Latn',
      'rof_TZ_#Latn', 'rwk_TZ_#Latn', 'sah_RU_#Cyrl', 'saq_KE_#Latn', 'sat_IN_#Olck', 'sat__#Olck', 'sbp_TZ_#Latn',
      'sd__#Arab', 'sd__#Deva', 'seh_MZ_#Latn', 'ses_ML_#Latn', 'shi_MA_#Latn', 'shi_MA_#Tfng', 'shi__#Latn',
      'shi__#Tfng', 'smn_FI_#Latn', 'sr__#Cyrl', 'sr__#Latn', 'su__#Latn', 'teo_UG_#Latn', 'twq_NE_#Latn',
      'tzm_MA_#Latn', 'uz__#Arab', 'uz__#Cyrl', 'uz__#Latn', 'vai_LR_#Latn', 'vai_LR_#Vaii', 'vai__#Latn',
      'vai__#Vaii', 'vun_TZ_#Latn', 'wae_CH_#Latn', 'xog_UG_#Latn', 'yav_CM_#Latn', 'yi_001_#Hebr', 'yue_CN_#Hans',
      'yue_HK_#Hant', 'yue__#Hans', 'yue__#Hant', 'zgh_MA_#Tfng', 'zh__#Hans', 'zh__#Hant',
    ],
  ],
  [
    [11, 11, 4, 8, 4, 5, 5, 0, 0, 5, 7, 0],
    [
      'French (Belgian)', 'fr_BE',
    ],
  ],
  [
    [12, 12, 5, 9, 4, 5, 5, 2, 0, 6, 8, 0],
    [
      'French (Canadian)', 'fr_CA',
    ],
  ],
  [
    [13, 13, 0, 8, 4, 5, 5, 0, 0, 5, 7, 0],
    [
      'French (Standard)', 'fr', 'fr_BF', 'fr_BI', 'fr_BJ', 'fr_BL', 'fr_CD', 'fr_CF', 'fr_CG', 'fr_CI', 'fr_FR',
      'fr_FR_#Latn', 'fr_GA', 'fr_GF', 'fr_GN', 'fr_GP', 'fr_GQ', 'fr_HT', 'fr_KM', 'fr_LU', 'fr_MC', 'fr_MF', 'fr_MG',
      'fr_MQ', 'fr_MU', 'fr_NC', 'fr_NE', 'fr_PF', 'fr_PM', 'fr_RE', 'fr_RW', 'fr_SC', 'fr_SN', 'fr_TG', 'fr_WF',
      'fr_YT',
    ],
  ],
  [
    [14, 14, 6, 8, 4, 5, 5, 0, 0, 5, 7, 0],
    [
      'French (Swiss)', 'fr_CH',
    ],
  ],
  [
    [15, 15, 0, 10, 5, 6, 6, 0, 0, 7, 9, 0],
    [
      'German (Austrian)', 'de_AT', 'de_IT',
    ],
  ],
  [
    [15, 15, 0, 11, 5, 6, 6, 0, 0, 7, 9, 0],
    [
      'German (Standard)', 'German (Swiss)', 'de', 'de_BE', 'de_CH', 'de_DE', 'de_DE_#Latn', 'de_LI', 'de_LU',
    ],
  ],
  [
    [16, 16, 0, 12, 6, 7, 7, 0, 0, 8, 10, 0],
    [
      'Italian (Standard)', 'it', 'it_IT', 'it_IT_#Latn', 'it_SM', 'it_VA',
    ],
  ],
  [
    [17, 14, 0, 12, 6, 7, 7, 0, 0, 8, 10, 0],
    [
      'Italian (Swiss)', 'it_CH',
    ],
  ],
  [
    [18, 17, 7, 2, 7, 8, 8, 4, 0, 9, 11, 0],
    [
      'Japanese', 'ja', 'ja_JP', 'ja_JP_#Jpan',
    ],
  ],
  [
    [19, 18, 8, 13, 8, 9, 9, 5, 0, 10, 12, 0],
    [
      'Korean', 'ko', 'ko_KP', 'ko_KR', 'ko_KR_#Kore',
    ],
  ],
  [
    [20, 19, 0, 14, 9, 10, 10, 2, 3, 6, 13, 0],
    [
      'Norwegian (Bokmal)', 'Norwegian (Nynorsk)', 'nb', 'nb_NO', 'nb_NO_#Latn', 'nb_SJ', 'no', 'no_NO', 'no_NO_#Latn',
    ],
  ],
  [
    [21, 20, 0, 15, 10, 11, 11, 0, 0, 11, 14, 0],
    [
      'Portuguese (Brazilian)', 'pt_BR', 'pt_BR_#Latn',
    ],
  ],
  [
    [22, 21, 0, 15, 10, 12, 11, 6, 0, 1, 15, 0],
    [
      'Portuguese (Standard)', 'pt_AO', 'pt_CH', 'pt_CV', 'pt_GQ', 'pt_GW', 'pt_LU', 'pt_MZ', 'pt_PT', 'pt_ST',
      'pt_TL',
    ],
  ],
  [
    [23, 22, 0, 16, 11, 13, 12, 7, 0, 12, 16, 0],
    [
      'Spanish (Mexican)', 'es_MX',
    ],
  ],
  [
    [24, 23, 9, 17, 11, 13, 12, 7, 0, 13, 17, 0],
    [
      'Spanish (Modern)', 'Spanish (Standard)', 'es', 'es_EA', 'es_ES', 'es_ES_#Latn', 'es_GQ', 'es_IC',
    ],
  ],
  [
    [25, 12, 0, 18, 12, 14, 13, 8, 4, 6, 18, 0],
    [
      'Swedish', 'sv', 'sv_AX', 'sv_FI', 'sv_SE', 'sv_SE_#Latn',
    ],
  ],
  [
    [26, 24, 0, 19, 13, 15, 14, 9, 0, 1, 19, 0],
    [
      'af', 'af_ZA', 'af_ZA_#Latn',
    ],
  ],
  [
    [27, 24, 3, 19, 13, 15, 14, 9, 0, 1, 19, 0],
    [
      'af_NA',
    ],
  ],
  [
    [28, 25, 0, 20, 14, 16, 15, 10, 0, 14, 0, 0],
    [
      'agq', 'agq_CM',
    ],
  ],
  [
    [29, 26, 3, 21, 15, 17, 16, 11, 0, 15, 0, 0],
    [
      'ak', 'ak_GH', 'ak_GH_#Latn',
    ],
  ],
  [
    [30, 27, 3, 22, 16, 18, 17, 12, 0, 1, 20, 0],
    [
      'am', 'am_ET', 'am_ET_#Ethi',
    ],
  ],
  [
    [31, 28, 3, 23, 17, 19, 18, 13, 5, 1, 21, 0],
    [
      'ar', 'ar_001', 'ar_AE', 'ar_BH', 'ar_DJ', 'ar_EG', 'ar_EG_#Arab', 'ar_ER', 'ar_KW', 'ar_OM', 'ar_QA', 'ar_SA',
      'ar_SD', 'ar_SO', 'ar_SS', 'ar_TD', 'ar_YE',
    ],
  ],
  [
    [31, 28, 3, 24, 17, 19, 18, 13, 6, 1, 22, 0],
    [
      'ar_DZ', 'ar_TN',
    ],
  ],
  [
    [31, 28, 3, 23, 17, 19, 18, 13, 6, 1, 22, 0],
    [
      'ar_EH', 'ar_LY',
    ],
  ],
  [
    [32, 28, 10, 23, 17, 19, 18, 13, 5, 1, 21, 0],
    [
      'ar_IL',
    ],
  ],
  [
    [31, 28, 3, 25, 17, 19, 18, 13, 5, 1, 21, 0],
    [
      'ar_IQ',
    ],
  ],
  [
    [31, 28, 3, 26, 17, 19, 18, 13, 5, 1, 21, 0],
    [
      'ar_JO', 'ar_LB', 'ar_PS', 'ar_SY',
    ],
  ],
  [
    [33, 28, 0, 23, 17, 19, 18, 13, 5, 1, 21, 0],
    [
      'ar_KM',
    ],
  ],
  [
    [33, 28, 0, 27, 17, 19, 18, 13, 6, 1, 22, 0],
    [
      'ar_MA',
    ],
  ],
  [
    [31, 28, 3, 28, 17, 19, 18, 13, 5, 1, 21, 0],
    [
      'ar_MR',
    ],
  ],
  [
    [34, 29, 11, 29, 18, 20, 19, 14, 0, 1, 23, 0],
    [
      'as', 'as_IN', 'as_IN_#Beng',
    ],
  ],
  [
    [35, 9, 0, 30, 19, 21, 20, 15, 0, 16, 0, 0],
    [
      'asa', 'asa_TZ',
    ],
  ],
  [
    [36, 30, 0, 31, 20, 22, 21, 16, 7, 17, 24, 0],
    [
      'ast', 'ast_ES',
    ],
  ],
  [
    [37, 31, 0, 32, 21, 23, 22, 0, 0, 18, 25, 0],
    [
      'az', 'az_AZ', 'az_AZ_#Cyrl', 'az_AZ_#Latn',
    ],
  ],
  [
    [28, 25, 0, 33, 22, 24, 23, 17, 0, 1, 0, 0],
    [
      'bas', 'bas_CM',
    ],
  ],
  [
    [38, 32, 12, 34, 23, 25, 24, 0, 0, 19, 26, 0],
    [
      'be', 'be_BY', 'be_BY_#Cyrl',
    ],
  ],
  [
    [39, 9, 3, 35, 24, 26, 25, 18, 0, 20, 0, 0],
    [
      'bem', 'bem_ZM',
    ],
  ],
  [
    [35, 9, 0, 36, 25, 27, 26, 19, 0, 1, 0, 0],
    [
      'bez', 'bez_TZ',
    ],
  ],
  [
    [40, 33, 13, 37, 26, 28, 27, 20, 0, 21, 27, 0],
    [
      'bg', 'bg_BG', 'bg_BG_#Cyrl',
    ],
  ],
  [
    [28, 25, 0, 38, 27, 29, 28, 0, 0, 22, 0, 0],
    [
      'bm', 'bm_ML', 'bm_ML_#Latn',
    ],
  ],
  [
    [41, 34, 3, 39, 28, 30, 29, 0, 0, 23, 28, 0],
    [
      'bn', 'bn_BD', 'bn_BD_#Beng', 'bn_IN',
    ],
  ],
  [
    [42, 35, 3, 40, 29, 31, 30, 21, 0, 1, 0, 0],
    [
      'bo', 'bo_CN', 'bo_CN_#Tibt', 'bo_IN',
    ],
  ],
  [
    [43, 13, 0, 41, 30, 32, 31, 22, 0, 24, 29, 0],
    [
      'br', 'br_FR', 'br_FR_#Latn',
    ],
  ],
  [
    [44, 10, 3, 42, 31, 33, 32, 23, 0, 25, 30, 0],
    [
      'brx', 'brx_IN',
    ],
  ],
  [
    [45, 36, 0, 43, 32, 34, 33, 24, 0, 26, 31, 0],
    [
      'bs', 'bs_BA', 'bs_BA_#Cyrl', 'bs_BA_#Latn',
    ],
  ],
  [
    [46, 30, 9, 44, 33, 35, 34, 7, 0, 27, 32, 0],
    [
      'ca', 'ca_AD', 'ca_ES', 'ca_ES_#Latn', 'ca_ES_VALENCIA', 'ca_FR', 'ca_IT',
    ],
  ],
  [
    [41, 34, 3, 45, 34, 36, 35, 0, 0, 28, 33, 0],
    [
      'ccp', 'ccp_BD', 'ccp_IN',
    ],
  ],
  [
    [0, 0, 0, 46, 35, 37, 36, 0, 8, 29, 34, 0],
    [
      'ce', 'ce_RU', 'ce_RU_#Cyrl',
    ],
  ],
  [
    [47, 10, 3, 47, 36, 38, 37, 0, 0, 30, 35, 0],
    [
      'ceb', 'ceb_PH',
    ],
  ],
  [
    [35, 9, 0, 48, 37, 39, 38, 0, 0, 31, 0, 0],
    [
      'cgg', 'cgg_UG', 'nyn', 'nyn_UG',
    ],
  ],
  [
    [48, 10, 3, 49, 38, 40, 39, 25, 0, 32, 36, 0],
    [
      'chr', 'chr_US',
    ],
  ],
  [
    [49, 37, 3, 50, 39, 41, 40, 26, 9, 1, 0, 0],
    [
      'ckb', 'ckb_IQ',
    ],
  ],
  [
    [50, 37, 0, 50, 39, 41, 40, 26, 9, 1, 0, 0],
    [
      'ckb_IR',
    ],
  ],
  [
    [51, 38, 10, 51, 40, 42, 41, 27, 0, 33, 37, 0],
    [
      'cs', 'cs_CZ', 'cs_CZ_#Latn',
    ],
  ],
  [
    [52, 39, 0, 52, 41, 43, 42, 28, 0, 34, 38, 0],
    [
      'cy', 'cy_GB', 'cy_GB_#Latn',
    ],
  ],
  [
    [53, 40, 14, 53, 9, 10, 43, 0, 0, 35, 39, 0],
    [
      'da', 'da_DK', 'da_DK_#Latn', 'da_GL',
    ],
  ],
  [
    [35, 9, 0, 54, 42, 44, 44, 29, 0, 36, 0, 0],
    [
      'dav', 'dav_KE',
    ],
  ],
  [
    [28, 25, 0, 55, 43, 45, 45, 30, 0, 37, 0, 0],
    [
      'dje', 'dje_NE',
    ],
  ],
  [
    [54, 41, 3, 56, 44, 46, 46, 31, 0, 1, 40, 0],
    [
      'doi', 'doi_IN',
    ],
  ],
  [
    [55, 42, 10, 57, 45, 47, 47, 32, 0, 38, 41, 0],
    [
      'dsb', 'dsb_DE',
    ],
  ],
  [
    [56, 43, 0, 58, 46, 48, 48, 33, 0, 1, 0, 0],
    [
      'dua', 'dua_CM',
    ],
  ],
  [
    [56, 43, 0, 59, 47, 49, 49, 0, 0, 39, 0, 0],
    [
      'dyo', 'dyo_SN',
    ],
  ],
  [
    [57, 44, 15, 60, 48, 50, 0, 34, 10, 40, 42, 0],
    [
      'dz', 'dz_BT', 'dz_BT_#Tibt',
    ],
  ],
  [
    [35, 9, 0, 61, 49, 51, 50, 35, 0, 41, 0, 0],
    [
      'ebu', 'ebu_KE',
    ],
  ],
  [
    [58, 45, 16, 62, 50, 52, 51, 36, 11, 1, 43, 0],
    [
      'ee', 'ee_GH', 'ee_GH_#Latn',
    ],
  ],
  [
    [59, 45, 0, 62, 50, 52, 51, 36, 11, 1, 43, 0],
    [
      'ee_TG',
    ],
  ],
  [
    [60, 6, 3, 63, 51, 53, 52, 37, 2, 1, 44, 0],
    [
      'el', 'el_CY', 'el_GR', 'el_GR_#Grek',
    ],
  ],
  [
    [61, 9, 3, 6, 3, 0, 4, 3, 0, 3, 5, 0],
    [
      'en_001', 'en_AG', 'en_BB', 'en_BM', 'en_BS', 'en_CY', 'en_DM', 'en_ER', 'en_FJ', 'en_FM', 'en_GD', 'en_GH',
      'en_GM', 'en_GY', 'en_JM', 'en_KI', 'en_KN', 'en_KY', 'en_LC', 'en_LR', 'en_LS', 'en_MO', 'en_MW', 'en_MY',
      'en_NA', 'en_PG', 'en_PH', 'en_PW', 'en_SB', 'en_SD', 'en_SL', 'en_SS', 'en_SZ', 'en_TC', 'en_TO', 'en_TT',
      'en_VC', 'en_VG', 'en_VU', 'en_WS', 'en_ZM',
    ],
  ],
  [
    [9, 9, 0, 6, 3, 0, 4, 3, 0, 3, 5, 0],
    [
      'en_150', 'en_AI', 'en_AT', 'en_CC', 'en_CH', 'en_CK', 'en_CM', 'en_CX', 'en_DE', 'en_DG', 'en_FK', 'en_GG',
      'en_GI', 'en_IM', 'en_IO', 'en_JE', 'en_KE', 'en_MG', 'en_MS', 'en_MU', 'en_NF', 'en_NG', 'en_NL', 'en_NR',
      'en_NU', 'en_PN', 'en_RW', 'en_SC', 'en_SH', 'en_SX', 'en_TK', 'en_TV', 'en_TZ', 'en_UG',
    ],
  ],
  [
    [61, 9, 3, 6, 3, 0, 4, 0, 0, 42, 5, 0],
    [
      'en_AE',
    ],
  ],
  [
    [62, 46, 0, 6, 3, 0, 4, 3, 0, 3, 5, 0],
    [
      'en_BE',
    ],
  ],
  [
    [63, 10, 0, 6, 3, 0, 4, 0, 0, 1, 6, 2],
    [
      'en_BI',
    ],
  ],
  [
    [64, 47, 0, 6, 3, 0, 4, 3, 0, 3, 5, 0],
    [
      'en_BW',
    ],
  ],
  [
    [65, 48, 0, 6, 3, 0, 4, 3, 0, 3, 5, 0],
    [
      'en_BZ',
    ],
  ],
  [
    [66, 9, 14, 6, 3, 0, 4, 3, 0, 3, 5, 0],
    [
      'en_DK',
    ],
  ],
  [
    [67, 9, 17, 6, 3, 0, 4, 3, 0, 3, 5, 0],
    [
      'en_FI',
    ],
  ],
  [
    [10, 10, 3, 6, 3, 0, 4, 0, 0, 42, 6, 0],
    [
      'en_GU',
    ],
  ],
  [
    [68, 49, 3, 6, 3, 0, 4, 3, 0, 3, 5, 0],
    [
      'en_HK',
    ],
  ],
  [
    [69, 13, 0, 6, 3, 0, 4, 2, 0, 43, 5, 0],
    [
      'en_IE',
    ],
  ],
  [
    [70, 9, 10, 6, 3, 0, 4, 3, 0, 3, 5, 0],
    [
      'en_IL',
    ],
  ],
  [
    [71, 50, 3, 6, 3, 0, 4, 3, 0, 3, 5, 0],
    [
      'en_IN',
    ],
  ],
  [
    [10, 10, 3, 6, 3, 0, 4, 0, 0, 42, 5, 0],
    [
      'en_MH', 'en_MP',
    ],
  ],
  [
    [72, 51, 0, 6, 3, 0, 4, 3, 0, 3, 5, 0],
    [
      'en_MT',
    ],
  ],
  [
    [73, 52, 3, 6, 3, 0, 4, 3, 0, 3, 5, 0],
    [
      'en_PK',
    ],
  ],
  [
    [74, 53, 0, 6, 3, 0, 4, 3, 12, 3, 5, 0],
    [
      'en_SE',
    ],
  ],
  [
    [6, 6, 3, 6, 3, 0, 4, 3, 0, 3, 5, 0],
    [
      'en_SG',
    ],
  ],
  [
    [9, 9, 0, 6, 3, 0, 4, 3, 2, 3, 5, 0],
    [
      'en_SI',
    ],
  ],
  [
    [10, 10, 3, 6, 3, 0, 4, 0, 13, 1, 6, 2],
    [
      'en_US_POSIX',
    ],
  ],
  [
    [75, 54, 0, 6, 3, 0, 4, 3, 0, 3, 5, 0],
    [
      'en_ZA',
    ],
  ],
  [
    [76, 55, 0, 6, 3, 0, 4, 3, 0, 3, 5, 0],
    [
      'en_ZW',
    ],
  ],
  [
    [77, 56, 18, 64, 52, 54, 53, 38, 0, 44, 0, 0],
    [
      'eo', 'eo_001',
    ],
  ],
  [
    [78, 23, 0, 16, 11, 13, 12, 7, 0, 12, 16, 0],
    [
      'es_419', 'es_AR', 'es_BR', 'es_BZ', 'es_CR', 'es_CU', 'es_EC', 'es_NI', 'es_SV',
    ],
  ],
  [
    [79, 57, 0, 16, 11, 13, 12, 7, 0, 12, 16, 0],
    [
      'es_BO',
    ],
  ],
  [
    [80, 58, 0, 16, 11, 13, 12, 7, 0, 12, 16, 0],
    [
      'es_CL',
    ],
  ],
  [
    [81, 59, 3, 16, 11, 13, 12, 7, 0, 12, 16, 0],
    [
      'es_CO',
    ],
  ],
  [
    [82, 23, 3, 16, 11, 13, 12, 7, 0, 12, 16, 0],
    [
      'es_DO',
    ],
  ],
  [
    [83, 59, 0, 16, 11, 13, 12, 7, 0, 12, 16, 0],
    [
      'es_GT',
    ],
  ],
  [
    [84, 60, 0, 16, 11, 13, 12, 7, 0, 12, 16, 0],
    [
      'es_HN',
    ],
  ],
  [
    [85, 61, 3, 16, 11, 13, 12, 7, 0, 12, 16, 0],
    [
      'es_PA', 'es_PR',
    ],
  ],
  [
    [86, 62, 0, 65, 11, 13, 12, 7, 0, 12, 16, 0],
    [
      'es_PE',
    ],
  ],
  [
    [82, 23, 3, 17, 11, 13, 12, 7, 0, 13, 17, 0],
    [
      'es_PH',
    ],
  ],
  [
    [78, 23, 0, 66, 11, 13, 12, 7, 0, 12, 16, 0],
    [
      'es_PY',
    ],
  ],
  [
    [87, 63, 3, 16, 11, 13, 12, 7, 0, 12, 16, 0],
    [
      'es_US',
    ],
  ],
  [
    [78, 23, 0, 65, 11, 13, 12, 7, 0, 12, 16, 0],
    [
      'es_UY',
    ],
  ],
  [
    [82, 23, 3, 66, 11, 13, 12, 7, 0, 12, 16, 0],
    [
      'es_VE',
    ],
  ],
  [
    [88, 64, 0, 67, 53, 55, 54, 0, 4, 45, 45, 0],
    [
      'et', 'et_EE', 'et_EE_#Latn',
    ],
  ],
  [
    [89, 65, 19, 68, 54, 56, 55, 0, 3, 46, 46, 0],
    [
      'eu', 'eu_ES', 'eu_ES_#Latn',
    ],
  ],
  [
    [56, 43, 0, 69, 55, 57, 56, 39, 0, 1, 0, 0],
    [
      'ewo', 'ewo_CM',
    ],
  ],
  [
    [90, 66, 20, 70, 56, 58, 57, 40, 14, 1, 47, 0],
    [
      'fa', 'fa_IR', 'fa_IR_#Arab',
    ],
  ],
  [
    [90, 66, 20, 71, 56, 58, 57, 40, 14, 1, 47, 0],
    [
      'fa_AF',
    ],
  ],
  [
    [28, 25, 0, 72, 57, 59, 58, 41, 0, 47, 0, 0],
    [
      'ff', 'ff_BF_#Adlm', 'ff_BF_#Latn', 'ff_CM_#Adlm', 'ff_CM_#Latn', 'ff_GH_#Adlm', 'ff_GH_#Latn', 'ff_GM_#Adlm',
      'ff_GM_#Latn', 'ff_GN', 'ff_GN_#Adlm', 'ff_GN_#Latn', 'ff_GW_#Adlm', 'ff_GW_#Latn', 'ff_LR_#Adlm', 'ff_LR_#Latn',
      'ff_MR_#Adlm', 'ff_MR_#Latn', 'ff_NE_#Adlm', 'ff_NE_#Latn', 'ff_NG_#Adlm', 'ff_NG_#Latn', 'ff_SL_#Adlm',
      'ff_SL_#Latn', 'ff_SN', 'ff_SN_#Adlm', 'ff_SN_#Latn',
    ],
  ],
  [
    [91, 67, 17, 73, 58, 60, 59, 42, 15, 48, 48, 0],
    [
      'fi', 'fi_FI', 'fi_FI_#Latn',
    ],
  ],
  [
    [92, 10, 3, 47, 59, 61, 4, 0, 0, 49, 49, 0],
    [
      'fil', 'fil_PH',
    ],
  ],
  [
    [93, 15, 0, 74, 60, 62, 60, 0, 3, 5, 50, 0],
    [
      'fo', 'fo_DK', 'fo_FO', 'fo_FO_#Latn',
    ],
  ],
  [
    [13, 13, 0, 8, 4, 5, 5, 43, 0, 6, 7, 0],
    [
      'fr_CM',
    ],
  ],
  [
    [94, 13, 3, 8, 4, 5, 5, 0, 0, 5, 7, 0],
    [
      'fr_DJ', 'fr_DZ', 'fr_MR', 'fr_SY', 'fr_TD', 'fr_TN', 'fr_VU',
    ],
  ],
  [
    [13, 13, 0, 75, 4, 5, 5, 2, 0, 6, 7, 0],
    [
      'fr_MA',
    ],
  ],
  [
    [95, 13, 0, 8, 4, 5, 5, 0, 0, 5, 7, 0],
    [
      'fr_ML',
    ],
  ],
  [
    [96, 68, 0, 76, 61, 63, 61, 44, 0, 50, 0, 0],
    [
      'fur', 'fur_IT',
    ],
  ],
  [
    [97, 69, 0, 77, 62, 64, 62, 0, 0, 51, 51, 0],
    [
      'fy', 'fy_NL', 'fy_NL_#Latn',
    ],
  ],
  [
    [98, 13, 0, 78, 63, 65, 63, 45, 16, 4, 52, 0],
    [
      'ga', 'ga_GB', 'ga_IE', 'ga_IE_#Latn',
    ],
  ],
  [
    [99, 70, 0, 79, 64, 66, 64, 46, 0, 52, 53, 0],
    [
      'gd', 'gd_GB', 'gd_GB_#Latn',
    ],
  ],
  [
    [100, 71, 0, 80, 65, 67, 65, 2, 0, 53, 54, 0],
    [
      'gl', 'gl_ES', 'gl_ES_#Latn',
    ],
  ],
  [
    [101, 15, 0, 81, 66, 68, 6, 47, 3, 16, 0, 0],
    [
      'gsw', 'gsw_CH', 'gsw_FR', 'gsw_LI',
    ],
  ],
  [
    [102, 34, 21, 82, 67, 69, 66, 0, 0, 54, 55, 0],
    [
      'gu', 'gu_IN', 'gu_IN_#Gujr',
    ],
  ],
  [
    [35, 9, 0, 83, 68, 70, 67, 48, 0, 55, 0, 0],
    [
      'guz', 'guz_KE',
    ],
  ],
  [
    [0, 0, 0, 84, 69, 71, 68, 2, 0, 4, 0, 0],
    [
      'gv', 'gv_IM', 'gv_IM_#Latn',
    ],
  ],
  [
    [103, 72, 0, 85, 70, 72, 69, 49, 0, 56, 56, 0],
    [
      'ha', 'ha_NE', 'ha_NG', 'ha_NG_#Latn',
    ],
  ],
  [
    [104, 72, 3, 85, 70, 72, 69, 49, 0, 56, 56, 0],
    [
      'ha_GH',
    ],
  ],
  [
    [105, 6, 3, 86, 71, 73, 0, 0, 0, 57, 0, 0],
    [
      'haw', 'haw_US',
    ],
  ],
  [
    [106, 73, 10, 87, 72, 74, 70, 50, 17, 1, 57, 0],
    [
      'he', 'he_IL', 'he_IL_#Hebr',
    ],
  ],
  [
    [107, 6, 3, 88, 73, 75, 71, 3, 0, 58, 58, 0],
    [
      'hi', 'hi_IN', 'hi_IN_#Deva',
    ],
  ],
  [
    [108, 74, 22, 89, 32, 34, 72, 0, 3, 59, 59, 0],
    [
      'hr', 'hr_HR', 'hr_HR_#Latn',
    ],
  ],
  [
    [109, 75, 22, 89, 32, 34, 72, 0, 3, 59, 59, 0],
    [
      'hr_BA',
    ],
  ],
  [
    [110, 42, 23, 90, 74, 76, 73, 51, 0, 38, 60, 0],
    [
      'hsb', 'hsb_DE',
    ],
  ],
  [
    [111, 76, 10, 91, 75, 77, 74, 52, 0, 60, 61, 0],
    [
      'hu', 'hu_HU', 'hu_HU_#Latn',
    ],
  ],
  [
    [112, 77, 0, 92, 76, 78, 75, 0, 18, 61, 62, 0],
    [
      'hy', 'hy_AM', 'hy_AM_#Armn',
    ],
  ],
  [
    [113, 78, 0, 93, 77, 79, 76, 0, 0, 62, 63, 0],
    [
      'ia', 'ia_001',
    ],
  ],
  [
    [114, 79, 14, 94, 78, 80, 77, 0, 0, 63, 64, 0],
    [
      'id', 'id_ID', 'id_ID_#Latn',
    ],
  ],
  [
    [115, 6, 0, 95, 79, 81, 78, 53, 0, 16, 65, 0],
    [
      'ig', 'ig_NG', 'ig_NG_#Latn',
    ],
  ],
  [
    [116, 0, 3, 96, 80, 82, 79, 54, 0, 1, 0, 0],
    [
      'ii', 'ii_CN', 'ii_CN_#Yiii',
    ],
  ],
  [
    [117, 80, 0, 97, 81, 83, 80, 55, 0, 6, 66, 0],
    [
      'is', 'is_IS', 'is_IS_#Latn',
    ],
  ],
  [
    [118, 81, 24, 98, 7, 8, 8, 4, 19, 9, 67, 0],
    [
      'ja_JP_JP_#u-ca-japanese',
    ],
  ],
  [
    [119, 82, 0, 99, 82, 84, 81, 56, 0, 40, 0, 0],
    [
      'jgo', 'jgo_CM',
    ],
  ],
  [
    [35, 9, 0, 100, 83, 85, 82, 57, 0, 16, 0, 0],
    [
      'jmc', 'jmc_TZ', 'rwk', 'rwk_TZ', 'vun', 'vun_TZ',
    ],
  ],
  [
    [120, 83, 0, 101, 84, 86, 83, 58, 0, 64, 68, 0],
    [
      'jv', 'jv_ID', 'jv_ID_#Latn',
    ],
  ],
  [
    [121, 84, 0, 102, 85, 87, 84, 0, 20, 65, 69, 0],
    [
      'ka', 'ka_GE', 'ka_GE_#Geor',
    ],
  ],
  [
    [122, 25, 3, 103, 86, 88, 85, 59, 0, 66, 0, 0],
    [
      'kab', 'kab_DZ',
    ],
  ],
  [
    [35, 9, 0, 104, 87, 89, 86, 60, 0, 67, 0, 0],
    [
      'kam', 'kam_KE',
    ],
  ],
  [
    [35, 9, 0, 105, 88, 90, 87, 61, 0, 16, 0, 0],
    [
      'kde', 'kde_TZ',
    ],
  ],
  [
    [123, 85, 0, 106, 89, 91, 88, 3, 0, 68, 70, 0],
    [
      'kea', 'kea_CV',
    ],
  ],
  [
    [28, 25, 0, 55, 90, 92, 89, 62, 0, 37, 0, 0],
    [
      'khq', 'khq_ML',
    ],
  ],
  [
    [35, 9, 0, 107, 91, 93, 50, 63, 0, 69, 0, 0],
    [
      'ki', 'ki_KE', 'ki_KE_#Latn',
    ],
  ],
  [
    [124, 86, 0, 108, 92, 94, 90, 0, 21, 11, 71, 0],
    [
      'kk', 'kk_KZ', 'kk_KZ_#Cyrl',
    ],
  ],
  [
    [125, 87, 0, 109, 93, 95, 0, 0, 0, 57, 0, 0],
    [
      'kkj', 'kkj_CM',
    ],
  ],
  [
    [126, 0, 14, 110, 94, 96, 0, 0, 0, 70, 0, 0],
    [
      'kl', 'kl_GL', 'kl_GL_#Latn',
    ],
  ],
  [
    [35, 9, 0, 111, 95, 97, 91, 64, 0, 71, 0, 0],
    [
      'kln', 'kln_KE',
    ],
  ],
  [
    [127, 88, 3, 112, 96, 98, 92, 0, 0, 11, 72, 0],
    [
      'km', 'km_KH', 'km_KH_#Khmr',
    ],
  ],
  [
    [128, 89, 21, 113, 97, 99, 93, 65, 0, 1, 73, 0],
    [
      'kn', 'kn_IN', 'kn_IN_#Knda',
    ],
  ],
  [
    [129, 90, 3, 114, 98, 100, 94, 0, 0, 72, 74, 0],
    [
      'kok', 'kok_IN',
    ],
  ],
  [
    [44, 10, 3, 115, 99, 101, 95, 0, 22, 11, 75, 0],
    [
      'ks', 'ks_IN', 'ks_IN_#Arab',
    ],
  ],
  [
    [35, 9, 0, 116, 100, 102, 96, 66, 0, 16, 0, 0],
    [
      'ksb', 'ksb_TZ',
    ],
  ],
  [
    [56, 43, 0, 117, 101, 103, 97, 67, 0, 73, 0, 0],
    [
      'ksf', 'ksf_CM',
    ],
  ],
  [
    [130, 91, 0, 118, 102, 104, 98, 68, 4, 74, 0, 0],
    [
      'ksh', 'ksh_DE',
    ],
  ],
  [
    [0, 0, 0, 119, 103, 105, 99, 69, 0, 75, 0, 0],
    [
      'ku', 'ku_TR', 'ku_TR_#Latn',
    ],
  ],
  [
    [0, 0, 0, 120, 104, 106, 68, 2, 0, 76, 0, 0],
    [
      'kw', 'kw_GB', 'kw_GB_#Latn',
    ],
  ],
  [
    [131, 92, 0, 121, 105, 107, 100, 70, 23, 1, 76, 0],
    [
      'ky', 'ky_KG', 'ky_KG_#Cyrl',
    ],
  ],
  [
    [35, 9, 0, 122, 106, 108, 101, 71, 0, 77, 0, 0],
    [
      'lag', 'lag_TZ',
    ],
  ],
  [
    [88, 64, 0, 123, 107, 109, 6, 72, 0, 1, 77, 0],
    [
      'lb', 'lb_LU', 'lb_LU_#Latn',
    ],
  ],
  [
    [35, 9, 0, 124, 108, 110, 102, 0, 0, 42, 0, 0],
    [
      'lg', 'lg_UG', 'lg_UG_#Latn',
    ],
  ],
  [
    [44, 10, 3, 125, 109, 111, 0, 0, 0, 57, 0, 0],
    [
      'lkt', 'lkt_US',
    ],
  ],
  [
    [56, 43, 0, 126, 110, 112, 103, 73, 0, 78, 0, 0],
    [
      'ln', 'ln_AO', 'ln_CD', 'ln_CD_#Latn', 'ln_CF', 'ln_CG',
    ],
  ],
  [
    [132, 93, 25, 127, 111, 113, 104, 74, 24, 1, 78, 0],
    [
      'lo', 'lo_LA', 'lo_LA_#Laoo',
    ],
  ],
  [
    [0, 0, 0, 128, 0, 0, 0, 0, 22, 57, 0, 0],
    [
      'lrc', 'lrc_IR',
    ],
  ],
  [
    [116, 0, 3, 128, 0, 0, 0, 0, 22, 57, 0, 0],
    [
      'lrc_IQ',
    ],
  ],
  [
    [133, 94, 0, 129, 112, 114, 105, 75, 4, 79, 79, 0],
    [
      'lt', 'lt_LT', 'lt_LT_#Latn',
    ],
  ],
  [
    [56, 43, 0, 130, 113, 115, 106, 76, 0, 80, 0, 0],
    [
      'lu', 'lu_CD', 'lu_CD_#Latn',
    ],
  ],
  [
    [35, 9, 0, 131, 114, 116, 107, 77, 0, 4, 0, 0],
    [
      'luo', 'luo_KE',
    ],
  ],
  [
    [35, 9, 0, 132, 115, 117, 108, 2, 0, 81, 0, 0],
    [
      'luy', 'luy_KE',
    ],
  ],
  [
    [134, 95, 0, 133, 116, 118, 109, 78, 25, 82, 80, 0],
    [
      'lv', 'lv_LV', 'lv_LV_#Latn',
    ],
  ],
  [
    [135, 6, 3, 88, 73, 75, 110, 3, 0, 58, 81, 0],
    [
      'mai', 'mai_IN',
    ],
  ],
  [
    [35, 9, 0, 134, 117, 85, 111, 79, 0, 83, 0, 0],
    [
      'mas', 'mas_KE', 'mas_TZ',
    ],
  ],
  [
    [35, 9, 0, 135, 118, 119, 112, 80, 0, 84, 0, 0],
    [
      'mer', 'mer_KE',
    ],
  ],
  [
    [28, 25, 0, 136, 119, 120, 113, 0, 0, 85, 0, 0],
    [
      'mfe', 'mfe_MU',
    ],
  ],
  [
    [136, 96, 0, 137, 120, 121, 114, 0, 0, 86, 0, 0],
    [
      'mg', 'mg_MG', 'mg_MG_#Latn',
    ],
  ],
  [
    [35, 9, 0, 138, 121, 122, 115, 81, 0, 87, 0, 0],
    [
      'mgh', 'mgh_MZ',
    ],
  ],
  [
    [119, 82, 0, 139, 122, 123, 0, 0, 0, 57, 0, 0],
    [
      'mgo', 'mgo_CM',
    ],
  ],
  [
    [137, 83, 3, 140, 123, 124, 0, 0, 0, 88, 82, 0],
    [
      'mi', 'mi_NZ', 'mi_NZ_#Latn',
    ],
  ],
  [
    [138, 97, 0, 141, 124, 125, 116, 82, 0, 1, 83, 0],
    [
      'mk', 'mk_MK', 'mk_MK_#Cyrl',
    ],
  ],
  [
    [139, 98, 3, 142, 125, 126, 117, 0, 0, 89, 84, 0],
    [
      'ml', 'ml_IN', 'ml_IN_#Mlym',
    ],
  ],
  [
    [140, 99, 19, 143, 126, 127, 118, 83, 0, 90, 85, 0],
    [
      'mn', 'mn_MN', 'mn_MN_#Cyrl',
    ],
  ],
  [
    [141, 100, 3, 144, 127, 128, 119, 84, 0, 1, 86, 0],
    [
      'mni', 'mni_IN',
    ],
  ],
  [
    [142, 34, 3, 145, 128, 129, 120, 0, 0, 72, 87, 0],
    [
      'mr', 'mr_IN', 'mr_IN_#Deva',
    ],
  ],
  [
    [143, 101, 3, 146, 129, 130, 121, 85, 0, 91, 64, 0],
    [
      'ms', 'ms_MY', 'ms_MY_#Latn', 'ms_SG',
    ],
  ],
  [
    [144, 102, 3, 146, 129, 130, 121, 85, 0, 91, 64, 0],
    [
      'ms_BN',
    ],
  ],
  [
    [145, 79, 14, 146, 129, 130, 121, 85, 0, 91, 64, 0],
    [
      'ms_ID',
    ],
  ],
  [
    [146, 103, 0, 147, 130, 131, 122, 0, 0, 92, 0, 0],
    [
      'mt', 'mt_MT', 'mt_MT_#Latn',
    ],
  ],
  [
    [56, 43, 0, 148, 131, 132, 123, 86, 0, 93, 0, 0],
    [
      'mua', 'mua_CM',
    ],
  ],
  [
    [147, 104, 26, 149, 132, 133, 124, 87, 26, 94, 88, 0],
    [
      'my', 'my_MM', 'my_MM_#Mymr',
    ],
  ],
  [
    [0, 0, 0, 150, 0, 0, 125, 0, 22, 11, 0, 0],
    [
      'mzn', 'mzn_IR',
    ],
  ],
  [
    [39, 9, 3, 151, 133, 134, 126, 88, 0, 95, 0, 0],
    [
      'naq', 'naq_NA',
    ],
  ],
  [
    [35, 9, 0, 152, 134, 135, 127, 0, 0, 96, 0, 0],
    [
      'nd', 'nd_ZW', 'nd_ZW_#Latn',
    ],
  ],
  [
    [148, 105, 0, 153, 135, 136, 128, 89, 0, 97, 89, 0],
    [
      'ne', 'ne_NP', 'ne_NP_#Deva',
    ],
  ],
  [
    [149, 105, 3, 153, 135, 136, 128, 89, 0, 97, 89, 0],
    [
      'ne_IN',
    ],
  ],
  [
    [56, 43, 0, 154, 136, 137, 129, 90, 0, 98, 0, 0],
    [
      'nmg', 'nmg_CM',
    ],
  ],
  [
    [20, 19, 27, 155, 137, 138, 43, 91, 3, 6, 90, 0],
    [
      'nn', 'nn_NO', 'nn_NO_#Latn', 'no_NO_NY',
    ],
  ],
  [
    [150, 106, 0, 156, 138, 139, 130, 92, 0, 1, 0, 0],
    [
      'nnh', 'nnh_CM',
    ],
  ],
  [
    [151, 4, 28, 157, 139, 140, 131, 93, 0, 99, 0, 0],
    [
      'nus', 'nus_SS',
    ],
  ],
  [
    [152, 107, 3, 158, 140, 141, 132, 94, 0, 100, 0, 0],
    [
      'om', 'om_ET', 'om_ET_#Latn',
    ],
  ],
  [
    [153, 107, 0, 158, 140, 141, 133, 94, 0, 101, 0, 0],
    [
      'om_KE',
    ],
  ],
  [
    [154, 10, 3, 159, 141, 142, 134, 0, 0, 102, 91, 0],
    [
      'or', 'or_IN', 'or_IN_#Orya',
    ],
  ],
  [
    [155, 108, 0, 160, 142, 143, 135, 95, 27, 1, 0, 0],
    [
      'os', 'os_GE', 'os_GE_#Cyrl', 'os_RU',
    ],
  ],
  [
    [156, 6, 3, 161, 143, 144, 136, 96, 0, 1, 92, 0],
    [
      'pa', 'pa_IN', 'pa_IN_#Guru', 'pa_PK', 'pa_PK_#Arab',
    ],
  ],
  [
    [157, 9, 29, 162, 144, 145, 137, 97, 0, 1, 93, 0],
    [
      'pcm', 'pcm_NG',
    ],
  ],
  [
    [158, 109, 0, 163, 145, 146, 138, 0, 0, 103, 94, 0],
    [
      'pl', 'pl_PL', 'pl_PL_#Latn',
    ],
  ],
  [
    [159, 110, 20, 164, 146, 147, 139, 98, 22, 1, 95, 0],
    [
      'ps', 'ps_AF', 'ps_AF_#Arab',
    ],
  ],
  [
    [160, 110, 3, 164, 146, 147, 139, 98, 22, 1, 95, 0],
    [
      'ps_PK',
    ],
  ],
  [
    [21, 20, 0, 15, 10, 11, 11, 0, 0, 11, 96, 0],
    [
      'pt',
    ],
  ],
  [
    [161, 21, 3, 15, 10, 12, 11, 6, 0, 1, 15, 0],
    [
      'pt_MO',
    ],
  ],
  [
    [162, 111, 0, 165, 147, 148, 140, 2, 0, 104, 97, 0],
    [
      'qu', 'qu_BO', 'qu_EC', 'qu_PE', 'qu_PE_#Latn',
    ],
  ],
  [
    [163, 112, 0, 166, 148, 149, 141, 0, 3, 105, 98, 0],
    [
      'rm', 'rm_CH', 'rm_CH_#Latn',
    ],
  ],
  [
    [56, 43, 0, 167, 149, 150, 142, 99, 0, 106, 0, 0],
    [
      'rn', 'rn_BI', 'rn_BI_#Latn',
    ],
  ],
  [
    [164, 109, 0, 168, 150, 151, 143, 2, 0, 107, 99, 0],
    [
      'ro', 'ro_RO', 'ro_RO_#Latn',
    ],
  ],
  [
    [164, 109, 0, 168, 150, 152, 143, 2, 0, 108, 99, 0],
    [
      'ro_MD',
    ],
  ],
  [
    [35, 9, 0, 169, 151, 153, 144, 100, 0, 1, 0, 0],
    [
      'rof', 'rof_TZ',
    ],
  ],
  [
    [165, 113, 0, 170, 152, 154, 145, 0, 28, 109, 100, 0],
    [
      'ru', 'ru_BY', 'ru_KG', 'ru_KZ', 'ru_MD', 'ru_RU', 'ru_RU_#Cyrl', 'ru_UA',
    ],
  ],
  [
    [0, 0, 0, 171, 153, 155, 0, 0, 0, 110, 0, 0],
    [
      'rw', 'rw_RW', 'rw_RW_#Latn',
    ],
  ],
  [
    [166, 6, 3, 172, 154, 75, 0, 89, 0, 40, 101, 0],
    [
      'sa', 'sa_IN', 'sa_IN_#Deva',
    ],
  ],
  [
    [167, 114, 0, 173, 155, 156, 146, 101, 29, 1, 102, 0],
    [
      'sah', 'sah_RU',
    ],
  ],
  [
    [35, 9, 0, 174, 156, 157, 147, 102, 0, 111, 0, 0],
    [
      'saq', 'saq_KE',
    ],
  ],
  [
    [105, 6, 3, 175, 157, 158, 148, 103, 0, 1, 103, 0],
    [
      'sat', 'sat_IN',
    ],
  ],
  [
    [35, 9, 0, 176, 158, 159, 149, 104, 0, 112, 0, 0],
    [
      'sbp', 'sbp_TZ',
    ],
  ],
  [
    [116, 0, 3, 177, 159, 160, 150, 105, 30, 113, 104, 0],
    [
      'sd', 'sd_IN', 'sd_IN_#Deva', 'sd_PK', 'sd_PK_#Arab',
    ],
  ],
  [
    [0, 0, 0, 178, 160, 161, 151, 106, 31, 114, 105, 0],
    [
      'se', 'se_NO', 'se_NO_#Latn', 'se_SE',
    ],
  ],
  [
    [168, 115, 0, 179, 161, 162, 152, 107, 31, 115, 106, 0],
    [
      'se_FI',
    ],
  ],
  [
    [169, 116, 0, 180, 162, 163, 153, 0, 0, 116, 0, 0],
    [
      'seh', 'seh_MZ',
    ],
  ],
  [
    [28, 25, 0, 55, 163, 45, 45, 62, 0, 37, 0, 0],
    [
      'ses', 'ses_ML',
    ],
  ],
  [
    [28, 25, 0, 181, 164, 164, 154, 108, 0, 117, 0, 0],
    [
      'sg', 'sg_CF', 'sg_CF_#Latn',
    ],
  ],
  [
    [28, 25, 0, 182, 165, 165, 155, 109, 0, 1, 0, 0],
    [
      'shi', 'shi_MA',
    ],
  ],
  [
    [126, 0, 14, 183, 166, 166, 156, 110, 0, 1, 107, 0],
    [
      'si', 'si_LK', 'si_LK_#Sinh',
    ],
  ],
  [
    [170, 117, 10, 184, 167, 167, 157, 0, 2, 118, 108, 0],
    [
      'sk', 'sk_SK', 'sk_SK_#Latn',
    ],
  ],
  [
    [171, 118, 0, 185, 168, 168, 158, 111, 32, 119, 109, 0],
    [
      'sl', 'sl_SI', 'sl_SI_#Latn',
    ],
  ],
  [
    [172, 119, 17, 186, 169, 169, 159, 112, 33, 120, 0, 0],
    [
      'smn', 'smn_FI',
    ],
  ],
  [
    [0, 0, 0, 187, 170, 170, 160, 0, 0, 121, 0, 0],
    [
      'sn', 'sn_ZW', 'sn_ZW_#Latn',
    ],
  ],
  [
    [173, 120, 3, 188, 171, 171, 161, 113, 34, 122, 110, 0],
    [
      'so', 'so_DJ', 'so_ET', 'so_SO', 'so_SO_#Latn',
    ],
  ],
  [
    [174, 120, 0, 188, 171, 171, 161, 113, 34, 122, 110, 0],
    [
      'so_KE',
    ],
  ],
  [
    [175, 121, 30, 189, 172, 172, 162, 114, 0, 123, 111, 0],
    [
      'sq', 'sq_AL', 'sq_AL_#Latn',
    ],
  ],
  [
    [176, 121, 0, 189, 172, 172, 162, 114, 0, 123, 111, 0],
    [
      'sq_MK', 'sq_XK',
    ],
  ],
  [
    [177, 122, 0, 190, 173, 173, 163, 115, 0, 124, 112, 0],
    [
      'sr', 'sr_ME', 'sr_ME_#Cyrl', 'sr_ME_#Latn', 'sr_RS', 'sr_RS_#Cyrl', 'sr_RS_#Latn', 'sr_XK_#Cyrl', 'sr_XK_#Latn',
    ],
  ],
  [
    [178, 123, 31, 191, 174, 174, 164, 0, 0, 125, 112, 0],
    [
      'sr_BA', 'sr_BA_#Cyrl', 'sr_BA_#Latn',
    ],
  ],
  [
    [179, 124, 32, 190, 173, 173, 164, 0, 0, 126, 112, 0],
    [
      'sr_CS',
    ],
  ],
  [
    [180, 6, 17, 192, 175, 175, 165, 0, 0, 127, 113, 0],
    [
      'su', 'su_ID', 'su_ID_#Latn',
    ],
  ],
  [
    [35, 9, 0, 193, 19, 176, 44, 0, 0, 128, 114, 0],
    [
      'sw', 'sw_CD', 'sw_TZ', 'sw_TZ_#Latn', 'sw_UG',
    ],
  ],
  [
    [35, 9, 0, 193, 19, 176, 44, 0, 0, 128, 115, 0],
    [
      'sw_KE',
    ],
  ],
  [
    [181, 34, 33, 194, 176, 177, 166, 116, 0, 129, 116, 0],
    [
      'ta', 'ta_IN', 'ta_IN_#Taml', 'ta_MY', 'ta_SG',
    ],
  ],
  [
    [182, 34, 0, 194, 176, 177, 166, 116, 0, 129, 116, 0],
    [
      'ta_LK',
    ],
  ],
  [
    [183, 125, 3, 195, 177, 178, 167, 0, 0, 11, 117, 0],
    [
      'te', 'te_IN', 'te_IN_#Telu',
    ],
  ],
  [
    [35, 9, 0, 196, 178, 179, 147, 117, 0, 130, 0, 0],
    [
      'teo', 'teo_KE', 'teo_UG',
    ],
  ],
  [
    [184, 47, 0, 197, 179, 180, 168, 0, 0, 11, 118, 0],
    [
      'tg', 'tg_TJ', 'tg_TJ_#Cyrl',
    ],
  ],
  [
    [185, 126, 34, 198, 180, 181, 169, 118, 0, 1, 119, 0],
    [
      'th',
    ],
  ],
  [
    [186, 127, 34, 198, 180, 181, 170, 118, 0, 1, 119, 1],
    [
      'th_TH', 'th_TH_#Thai',
    ],
  ],
  [
    [187, 128, 35, 198, 180, 181, 170, 118, 19, 1, 0, 1],
    [
      'th_TH_TH_#u-nu-thai',
    ],
  ],
  [
    [188, 129, 3, 199, 181, 182, 171, 119, 0, 1, 0, 0],
    [
      'ti', 'ti_ET', 'ti_ET_#Ethi',
    ],
  ],
  [
    [188, 129, 3, 199, 181, 182, 172, 119, 0, 1, 0, 0],
    [
      'ti_ER',
    ],
  ],
  [
    [189, 130, 0, 200, 182, 183, 173, 120, 35, 131, 120, 0],
    [
      'tk', 'tk_TM', 'tk_TM_#Latn',
    ],
  ],
  [
    [190, 88, 3, 201, 183, 184, 174, 121, 36, 132, 121, 0],
    [
      'to', 'to_TO', 'to_TO_#Latn',
    ],
  ],
  [
    [191, 131, 0, 202, 184, 185, 175, 122, 0, 133, 122, 0],
    [
      'tr', 'tr_TR', 'tr_TR_#Latn',
    ],
  ],
  [
    [192, 131, 3, 202, 184, 185, 175, 122, 0, 133, 122, 0],
    [
      'tr_CY',
    ],
  ],
  [
    [193, 132, 10, 203, 185, 186, 176, 0, 0, 57, 123, 0],
    [
      'tt', 'tt_RU', 'tt_RU_#Cyrl',
    ],
  ],
  [
    [56, 43, 0, 55, 163, 45, 45, 30, 0, 37, 0, 0],
    [
      'twq', 'twq_NE',
    ],
  ],
  [
    [35, 9, 0, 204, 186, 187, 177, 123, 0, 134, 0, 0],
    [
      'tzm', 'tzm_MA',
    ],
  ],
  [
    [194, 133, 3, 205, 187, 188, 178, 124, 0, 135, 124, 0],
    [
      'ug', 'ug_CN', 'ug_CN_#Arab',
    ],
  ],
  [
    [195, 134, 0, 206, 188, 28, 179, 125, 37, 1, 125, 0],
    [
      'uk', 'uk_UA', 'uk_UA_#Cyrl',
    ],
  ],
  [
    [196, 135, 3, 207, 189, 189, 180, 0, 17, 136, 126, 0],
    [
      'ur', 'ur_PK', 'ur_PK_#Arab',
    ],
  ],
  [
    [196, 135, 3, 207, 189, 189, 180, 0, 22, 136, 126, 0],
    [
      'ur_IN',
    ],
  ],
  [
    [197, 136, 36, 208, 190, 190, 181, 126, 38, 137, 127, 0],
    [
      'uz', 'uz_AF', 'uz_AF_#Arab', 'uz_UZ', 'uz_UZ_#Cyrl', 'uz_UZ_#Latn',
    ],
  ],
  [
    [39, 9, 3, 209, 191, 191, 0, 0, 0, 57, 0, 0],
    [
      'vai', 'vai_LR',
    ],
  ],
  [
    [198, 137, 0, 210, 192, 192, 182, 127, 0, 138, 128, 0],
    [
      'vi', 'vi_VN', 'vi_VN_#Latn',
    ],
  ],
  [
    [199, 138, 0, 211, 193, 193, 183, 0, 0, 139, 0, 0],
    [
      'wae', 'wae_CH',
    ],
  ],
  [
    [200, 139, 0, 212, 194, 194, 184, 128, 0, 140, 129, 0],
    [
      'wo', 'wo_SN', 'wo_SN_#Latn',
    ],
  ],
  [
    [0, 0, 0, 213, 195, 195, 185, 0, 0, 141, 0, 0],
    [
      'xh', 'xh_ZA', 'xh_ZA_#Latn',
    ],
  ],
  [
    [35, 9, 0, 124, 196, 196, 186, 129, 0, 142, 0, 0],
    [
      'xog', 'xog_UG',
    ],
  ],
  [
    [56, 43, 0, 214, 197, 197, 187, 130, 0, 143, 0, 0],
    [
      'yav', 'yav_CM',
    ],
  ],
  [
    [201, 140, 0, 215, 198, 198, 0, 131, 0, 40, 0, 0],
    [
      'yi', 'yi_001',
    ],
  ],
  [
    [202, 141, 37, 216, 199, 199, 188, 132, 0, 4, 130, 0],
    [
      'yo', 'yo_NG', 'yo_NG_#Latn',
    ],
  ],
  [
    [202, 141, 37, 217, 200, 200, 188, 133, 0, 4, 131, 0],
    [
      'yo_BJ',
    ],
  ],
  [
    [3, 3, 2, 2, 1, 201, 2, 1, 1, 1, 132, 0],
    [
      'yue', 'yue_CN', 'yue_HK',
    ],
  ],
  [
    [28, 25, 0, 182, 201, 165, 155, 109, 0, 1, 0, 0],
    [
      'zgh', 'zgh_MA',
    ],
  ],
  [
    [203, 142, 38, 218, 1, 1, 1, 1, 0, 1, 1, 0],
    [
      'zh_SG', 'zh_SG_#Hans',
    ],
  ],
  [
    [204, 10, 0, 219, 202, 202, 185, 0, 0, 141, 133, 0],
    [
      'zu', 'zu_ZA', 'zu_ZA_#Latn',
    ],
  ],
];

const BY_NAME: ReadonlyMap<string, number> = new Map(
  LOCALES.flatMap(([, names], index) => names.map((name) => [name.toLowerCase(), index] as const)),
);
const decoded = new Map<number, AcfDateLocale>();

function entry<T>(table: readonly T[], index: number | undefined): T {
  const value = index === undefined ? undefined : table[index];
  if (value === undefined) throw new RangeError(`Missing date locale data at ${index}`);
  return value;
}

/** Names by value from '|'-separated groups of '~'-separated names, longest first. */
function names(groups: string, first: number): DateName[] {
  return groups
    .split('|')
    .flatMap((group, i) => (group === '' ? [] : group.split('~').map((name): DateName => [name, first + i])))
    .sort((a, b) => b[0].length - a[0].length);
}

function decode(record: readonly number[]): AcfDateLocale {
  const [dt, d, t, mon, wdl, wds, era, ampm, num, prefixes, zones, flags = 0] = record;
  const [minus = '', nan = '', infinity = '', exponent = ''] = entry(NUMBERS, num).split('|');
  const locale = {
    patterns: [...entry(DATE_TIME_PATTERNS, dt), ...entry(DATE_PATTERNS, d), ...entry(TIME_PATTERNS, t)],
    eras: names(entry(ERAS, era), 0),
    months: names(entry(MONTHS, mon), 0),
    weekdays: names(entry(WEEKDAYS, wdl), 1),
    shortWeekdays: names(entry(SHORT_WEEKDAYS, wds), 1),
    amPm: names(entry(AM_PM, ampm), 0),
    minus,
    nan,
    infinity,
    exponent,
    yearOffset: (flags & 1) === 1 ? 543 : 0,
    enZoneNames: (flags & 2) === 2,
  };
  const unsafe = new Set(entry(ZONE_NAME_PREFIXES, prefixes).split('|'));
  const all = [locale.eras, locale.months, locale.weekdays, locale.shortWeekdays, locale.amPm].flat().map(([n]) => n);
  const fixedZones = entry(FIXED_ZONES, zones).map((index): FixedZone => {
    const [name = '', offset = '', ...longer] = entry(FIXED_ZONE_NAMES, index).split('~');
    return [name, Number(offset), longer];
  });
  const zoneSafeNames = [...new Set(all)].filter((name) => !unsafe.has(name));
  return { ...locale, zoneSafeNames, fixedZones };
}

/** The parse data of the locale setLocale(`name`) selects (in any case); undefined for a name it refuses. */
export function acfDateLocale(name: string): AcfDateLocale | undefined {
  const index = BY_NAME.get(name.toLowerCase());
  if (index === undefined) return undefined;
  let locale = decoded.get(index);
  if (locale === undefined) {
    locale = decode(entry(LOCALES, index)[0]);
    decoded.set(index, locale);
  }
  return locale;
}
