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
   The `lectures.type` column has 25+ raw variants (verified against the live
   meta DB), most of them one-off outliers. This block groups the handful of
   meaningful ones into 5 canonical keys — applied in the APP layer only, so
   the Google Sheets source is never touched. Anything not listed here (n/a,
   empty, "Promo", and the long tail of rare one-off values) is never offered
   as a filter checkbox.

   TYPE_GROUPS:  canonical key -> raw `type_norm` values that fold into it
                 (type_norm is already lower-cased in the DB, same convention
                 as country_norm).
   TYPE_ORDER:   fixed display order for the Filters panel checkboxes.
--------------------------------------------------------------------------- */
PPP.config.TYPE_GROUPS = {
    lecture: ['lecture', 'lecture (event)', 'lecture (public)'],
    parikrama: ['parikrama', 'parikrama_radhakunda'],
    seminar: ['lecture (seminar)'],
    qa: ['istagosthi_q&a'],
    kirtan: ['practice (kirtan)', 'practice_?_ (kirtan)', 'practice (bhajan)', 'practice (arati)', 'explanation (bhajan)']
};

PPP.config.TYPE_ORDER = ['lecture', 'parikrama', 'seminar', 'qa', 'kirtan'];

// i18n key for each canonical type's checkbox label.
PPP.config.TYPE_I18N_KEY = {
    lecture: 'typeLecture',
    parikrama: 'typeParikrama',
    seminar: 'typeSeminar',
    qa: 'typeQA',
    kirtan: 'typeKirtan'
};

/**
 * Every raw `type_norm` value that must match a canonical type key.
 * Returns lower-cased values (type_norm is lower-cased), same shape as
 * countryMatchCodes.
 */
PPP.config.typeMatchValues = function (canonical) {
    var raws = PPP.config.TYPE_GROUPS[canonical];
    return raws ? raws.slice() : [];
};
