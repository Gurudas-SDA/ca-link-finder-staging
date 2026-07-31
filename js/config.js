/* ===========================================================================
   PPP Link Finder — Runtime configuration
   Public, non-secret client config. The Drive API key below is a FREE key for
   the Drive API (Drive API is not metered) and is used ONLY to fetch public,
   already-shared raw EN transcript .txt files on demand during a ZIP download.
   =========================================================================== */
window.PPP = window.PPP || {};
PPP.config = PPP.config || {};
PPP.config.driveApiKey = 'AIzaSyAx_9TEXqx9TuyxuXjGsSf9IOtNTm9VzDE';

/* ---------------------------------------------------------------------------
   COUNTRY FILTER DATA
   The `country` column stores a code plus an optional city ("RUS, Moscow").
   The raw data has drifted: two codes for one country (LAT/LVA, NLZ/NZL,
   LIT/LTU), a spelled-out name (MEXICO), a stray semicolon (IND;), a missing
   comma ("FRA Dijon"), and non-country junk (none / Interviews / unknown /
   empty). This block is the single source of truth for turning a raw cell
   into ONE canonical filter code — applied in the APP layer only, so the
   Google Sheets source is never touched (reversible by design).

     - COUNTRY_FOLD:  variant code -> canonical ISO-ish code.
     - COUNTRY_HIDE:  raw first-tokens that are not a real place (dropped from
                      the filter list; "Online" is intentionally NOT here —
                      Rājan keeps it as a selectable option).
     - COUNTRY_NAMES: canonical code -> display name per UI language. Shown in
                      the filter as "CODE (Name in the current language)".

   normalizeCountry(raw) returns the canonical code, or null when the row must
   not appear as a country filter option.
--------------------------------------------------------------------------- */
PPP.config.COUNTRY_FOLD = {
    LAT: 'LVA', NLZ: 'NZL', LIT: 'LTU', MEXICO: 'MEX'
};

// Lower-cased raw first-tokens that are not a real, filterable place.
PPP.config.COUNTRY_HIDE = new Set([
    '', 'unknown', 'none', 'interviews', 'dijon'
]);

PPP.config.COUNTRY_NAMES = {
    IND: { en: 'India', ru: 'Индия', lv: 'Indija', it: 'India', fr: 'Inde', es: 'India' },
    RUS: { en: 'Russia', ru: 'Россия', lv: 'Krievija', it: 'Russia', fr: 'Russie', es: 'Rusia' },
    USA: { en: 'USA', ru: 'США', lv: 'ASV', it: 'USA', fr: 'États-Unis', es: 'EE. UU.' },
    ITA: { en: 'Italy', ru: 'Италия', lv: 'Itālija', it: 'Italia', fr: 'Italie', es: 'Italia' },
    ESP: { en: 'Spain', ru: 'Испания', lv: 'Spānija', it: 'Spagna', fr: 'Espagne', es: 'España' },
    FRA: { en: 'France', ru: 'Франция', lv: 'Francija', it: 'Francia', fr: 'France', es: 'Francia' },
    CHE: { en: 'Switzerland', ru: 'Швейцария', lv: 'Šveice', it: 'Svizzera', fr: 'Suisse', es: 'Suiza' },
    LVA: { en: 'Latvia', ru: 'Латвия', lv: 'Latvija', it: 'Lettonia', fr: 'Lettonie', es: 'Letonia' },
    DEU: { en: 'Germany', ru: 'Германия', lv: 'Vācija', it: 'Germania', fr: 'Allemagne', es: 'Alemania' },
    NZL: { en: 'New Zealand', ru: 'Новая Зеландия', lv: 'Jaunzēlande', it: 'Nuova Zelanda', fr: 'Nouvelle-Zélande', es: 'Nueva Zelanda' },
    HRV: { en: 'Croatia', ru: 'Хорватия', lv: 'Horvātija', it: 'Croazia', fr: 'Croatie', es: 'Croacia' },
    MEX: { en: 'Mexico', ru: 'Мексика', lv: 'Meksika', it: 'Messico', fr: 'Mexique', es: 'México' },
    BOL: { en: 'Bolivia', ru: 'Боливия', lv: 'Bolīvija', it: 'Bolivia', fr: 'Bolivie', es: 'Bolivia' },
    LTU: { en: 'Lithuania', ru: 'Литва', lv: 'Lietuva', it: 'Lituania', fr: 'Lituanie', es: 'Lituania' },
    CZE: { en: 'Czechia', ru: 'Чехия', lv: 'Čehija', it: 'Rep. Ceca', fr: 'Tchéquie', es: 'Chequia' },
    BLR: { en: 'Belarus', ru: 'Беларусь', lv: 'Baltkrievija', it: 'Bielorussia', fr: 'Biélorussie', es: 'Bielorrusia' },
    ARE: { en: 'UAE', ru: 'ОАЭ', lv: 'AAE', it: 'Emirati Arabi Uniti', fr: 'Émirats arabes unis', es: 'EAU' },
    AUS: { en: 'Australia', ru: 'Австралия', lv: 'Austrālija', it: 'Australia', fr: 'Australie', es: 'Australia' },
    Online: { en: 'Online', ru: 'Онлайн', lv: 'Tiešsaistē', it: 'Online', fr: 'En ligne', es: 'En línea' }
};

/**
 * Canonical country code for a raw `country` cell, or null when the row must
 * not appear as a filter option. Splits off the code (first token before a
 * space/comma/semicolon), folds known variants, drops junk. "Online" passes
 * through unchanged.
 */
PPP.config.normalizeCountry = function (raw) {
    var first = String(raw || '').trim().split(/[\s,;]+/)[0];
    if (!first) return null;
    if (first === 'Online') return 'Online';
    var up = first.toUpperCase();
    if (PPP.config.COUNTRY_HIDE.has(up.toLowerCase())) return null;
    up = PPP.config.COUNTRY_FOLD[up] || up;
    // Only known canonical codes are offered; anything unmapped is treated as
    // junk so a future bad cell cannot silently add a bogus filter option.
    return PPP.config.COUNTRY_NAMES[up] ? up : null;
};

/**
 * Every RAW country_norm code that must match a canonical filter code —
 * the canonical code itself plus any variant that folds into it. Needed
 * because country_norm stores the ORIGINAL drifted codes ("lat" separate
 * from "lva"), so a filter on LVA has to also catch the LAT rows.
 * Returns lower-cased codes (country_norm is lower-cased).
 */
PPP.config.countryMatchCodes = function (canonical) {
    var out = [String(canonical).toLowerCase()];
    var fold = PPP.config.COUNTRY_FOLD;
    Object.keys(fold).forEach(function (variant) {
        if (fold[variant] === canonical) out.push(variant.toLowerCase());
    });
    return out;
};

/** Localized display name for a canonical code (falls back to the code). */
PPP.config.countryName = function (code, lang) {
    var row = PPP.config.COUNTRY_NAMES[code];
    if (!row) return code;
    return row[lang] || row.en || code;
};

/* ---------------------------------------------------------------------------
   RECORD-TYPE FILTER DATA
   Rājan's decision (2026-07-31): the Type filter offers exactly these 8
   `lectures.type` column values, shown in alphabetical order — NOT grouped
   into families. Each checkbox matches ONLY its own exact DB value ("Lecture"
   never also matches "Lecture (event)"). The other 30+ rare/one-off values
   (n/a, empty, "Promo", Practice/Commentary variants, etc.) are still never
   offered as a filter checkbox.

   TYPE_ORDER: the exact display strings, alphabetical — also used as the
               checkbox value and as the visible label (no i18n: these are
               literal DB cell contents, not translatable UI copy).
--------------------------------------------------------------------------- */
PPP.config.TYPE_ORDER = [
    'Explanation (bhajan)',
    'Istagosthi_Q&A',
    'Lecture',
    'Lecture (event)',
    'Lecture (public)',
    'Lecture (seminar)',
    'Parikrama',
    'Short talk'
];

/* ---------------------------------------------------------------------------
   LANGUAGE FILTER DATA
   The `lang` column mixes real audio-language cells ("eng only", "eng; rus")
   with non-language notes ("singing", "chanting", "multi", "Promo") and a
   large empty tail. Rājan's rule (2026-07-31): offer ONLY the cells that end
   in "only" or contain a semicolon — those are exactly the ones that state
   which language(s) the recording is in.

   A value like "eng; rus" cannot travel through the search field as-is,
   because the field splits AND-terms on ';'. So the token carries '+' where
   the raw cell has "; " (lang:eng+rus) and search.js decodes it back.
--------------------------------------------------------------------------- */
PPP.config.isFilterableLang = function (raw) {
    var v = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!v) return null;
    if (/only$/i.test(v) || v.indexOf(';') !== -1) return v.toLowerCase();
    return null;
};

/** "eng; rus" -> "eng+rus" (safe inside a ';'-separated search field). */
PPP.config.encodeLangToken = function (value) {
    return String(value || '').split(/\s*;\s*/).join('+');
};

/** "eng+rus" -> "eng; rus" (inverse of encodeLangToken). */
PPP.config.decodeLangToken = function (token) {
    return String(token || '').split('+').map(function (s) { return s.trim(); }).join('; ');
};

/* ---------------------------------------------------------------------------
   LINKS FILTER DATA
   The `links` column is a platform label, not a URL ("YouTube", "Soundcloud",
   "Mixcloud", "Facebook", "N/A"). Rājan asked for three fixed options.
--------------------------------------------------------------------------- */
PPP.config.LINKS_ORDER = ['YouTube', 'Soundcloud', 'Mixcloud'];

/* ---------------------------------------------------------------------------
   LENGTH FILTER DATA
   The `length` column is human text ("45min", "1h 15min"), so the ranges are
   resolved to minutes in SQL (see search.js LENGTH_MINUTES_SQL).
--------------------------------------------------------------------------- */
PPP.config.LENGTH_RANGES = [
    { key: '0-30', min: 1, max: 30 },
    { key: '31-45', min: 31, max: 45 },
    { key: '46-60', min: 46, max: 60 },
    { key: '61-90', min: 61, max: 90 },
    { key: '91+', min: 91, max: null }
];

PPP.config.lengthRange = function (key) {
    var all = PPP.config.LENGTH_RANGES;
    for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i];
    return null;
};

/** "0-30" -> "0-30 min", "91+" -> "91+ min" (unit comes from i18n). */
PPP.config.lengthRangeLabel = function (key, unit) {
    return key + ' ' + (unit || 'min');
};

/**
 * The single `type_norm` value a Type checkbox must match. The checkbox
 * value IS the exact DB display string (see TYPE_ORDER), so this just
 * lower-cases it to compare against the already-lower-cased type_norm
 * column — no family expansion, exactly one value in, one value out.
 */
PPP.config.typeMatchValues = function (exactValue) {
    return exactValue ? [String(exactValue).toLowerCase()] : [];
};
