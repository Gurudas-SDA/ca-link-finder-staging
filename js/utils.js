/* ===========================================================================
   PPP Link Finder — Utility functions
   Extracted from original index.html
   =========================================================================== */
window.PPP = window.PPP || {};

// Large corpus files live on Cloudflare while the UI stays on GitHub Pages.
// The same promoted code works in both environments: only the GitHub Pages
// path decides which data Worker is used. Direct Workers/local visits keep
// relative URLs and therefore read from their own origin.
PPP.dataOrigin = '';
if (window.location.hostname === 'gurudas-sda.github.io') {
    PPP.dataOrigin = window.location.pathname.indexOf('/ca-link-finder-staging/') === 0
        ? 'https://ca-link-finder-staging.guru-das-sda.workers.dev'
        : 'https://ca-link-finder.guru-das-sda.workers.dev';
}

PPP.dataUrl = function (path) {
    var value = String(path || '');
    if (!PPP.dataOrigin || /^(?:[a-z]+:)?\/\//i.test(value)) return value;
    return PPP.dataOrigin + '/' + value.replace(/^\/+/, '');
};

PPP.utils = (function () {
    'use strict';

    /**
     * Remove diacritical marks: NFD + strip combining marks.
     * "Bābājī" → "Babaji"
     */
    function removeDiacritics(str) {
        if (!str) return '';
        return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }

    /**
     * Transliterate Latin to basic Cyrillic (for Russian search).
     * "babaji" → "бабаджи"
     */
    function transliterate(word) {
        var map = {
            'a': '\u0430', 'b': '\u0431', 'v': '\u0432', 'g': '\u0433',
            'd': '\u0434', 'e': '\u0435', 'yo': '\u0451', 'zh': '\u0436',
            'z': '\u0437', 'i': '\u0438', 'y': '\u0439', 'k': '\u043a',
            'l': '\u043b', 'm': '\u043c', 'n': '\u043d', 'o': '\u043e',
            'p': '\u043f', 'r': '\u0440', 's': '\u0441', 't': '\u0442',
            'u': '\u0443', 'f': '\u0444', 'h': '\u0445', 'ts': '\u0446',
            'ch': '\u0447', 'sh': '\u0448', 'sch': '\u0449', 'yu': '\u044e',
            'ya': '\u044f', 'j': '\u0434\u0436',
            // 'w' has no separate letter in Cyrillic transliteration \u2014 English-style
            // spellings of these titles use it for the 'v' sound (e.g. "Goswami" ->
            // "\u0413\u043e\u0441\u0432\u0430\u043c\u0438"). Added 2026-08-01: real-data audit of the 1456 Cyrillic-titled
            // lectures found "\u0433\u043e\u0441\u0432\u0430\u043c\u0438" (42 occurrences) unmatched by "goswami" without
            // this \u2014 every other letter in the existing map already round-trips
            // correctly against that corpus.
            'w': '\u0432'
        };
        var result = '';
        var w = word.toLowerCase();
        var i = 0;
        while (i < w.length) {
            // Try 3-char, 2-char, then 1-char sequences
            if (i + 3 <= w.length && map[w.substring(i, i + 3)]) {
                result += map[w.substring(i, i + 3)];
                i += 3;
            } else if (i + 2 <= w.length && map[w.substring(i, i + 2)]) {
                result += map[w.substring(i, i + 2)];
                i += 2;
            } else if (map[w[i]]) {
                result += map[w[i]];
                i += 1;
            } else {
                result += w[i];
                i += 1;
            }
        }
        return result;
    }

    /**
     * Compare dates in "YYYY.MM.DD" format (descending).
     * Handles "unknown" and "xx" placeholders — exact port from MainCopyCA.gs.
     */
    function compareDates(a, b) {
        var dateA = a['Date'] || '';
        var dateB = b['Date'] || '';
        var fileNameA = a['Original file name'] || '';
        var fileNameB = b['Original file name'] || '';

        // Treat unknown, N/A, empty as "no date" — sort to end
        var noDateA = !dateA || dateA === 'unknown' || dateA === 'N/A';
        var noDateB = !dateB || dateB === 'unknown' || dateB === 'N/A';
        if (noDateA && noDateB) {
            return fileNameB.localeCompare(fileNameA, undefined, { numeric: true, sensitivity: 'base' });
        }
        if (noDateA) return 1;
        if (noDateB) return -1;

        var partsA = dateA.split('.');
        var partsB = dateB.split('.');

        // Year descending
        if (partsA[0] !== partsB[0]) return partsB[0] - partsA[0];

        // Month: 'xx' goes to end
        if (partsA[1] !== 'xx' && partsB[1] !== 'xx') {
            if (partsA[1] !== partsB[1]) return partsB[1] - partsA[1];
        } else if (partsA[1] === 'xx' && partsB[1] !== 'xx') {
            return 1;
        } else if (partsA[1] !== 'xx' && partsB[1] === 'xx') {
            return -1;
        }

        // Day: 'xx' goes to end
        if (partsA[2] !== 'xx' && partsB[2] !== 'xx') {
            var dayComp = partsB[2] - partsA[2];
            if (dayComp !== 0) return dayComp;
        } else if (partsA[2] === 'xx' && partsB[2] !== 'xx') {
            return 1;
        } else if (partsA[2] !== 'xx' && partsB[2] === 'xx') {
            return -1;
        }

        // Filename tiebreaker (descending)
        return fileNameB.localeCompare(fileNameA, undefined, { numeric: true, sensitivity: 'base' });
    }

    /**
     * Normalize text for diacritics-insensitive search.
     */
    function normalizeForSearch(str) {
        if (!str) return '';
        return removeDiacritics(str.toLowerCase().trim());
    }

    /**
     * Escape special regex characters.
     */
    function escapeRegex(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Format length value (e.g., "0.05" → "1 h 12 min").
     * Exact port from MainCopyCA.gs.
     */
    function formatLength(val) {
        if (!val) return '';
        if (/\d+\s*h\s*\d+\s*min/.test(val)) return val;
        function padZero(num) { return num < 10 ? '0' + num : num; }
        var num = parseFloat(val);
        if (!isNaN(num) && num >= 0 && num < 1) {
            var totalMinutes = Math.round(num * 24 * 60);
            var hours = Math.floor(totalMinutes / 60);
            var minutes = totalMinutes % 60;
            return hours + ' h ' + padZero(minutes) + ' min';
        }
        var parts = val.toString().split(':');
        if (parts.length >= 2) {
            var hours = parseInt(parts[0]);
            var minutes = parseInt(parts[1]);
            if (!isNaN(hours) && !isNaN(minutes)) return hours + ' h ' + padZero(minutes) + ' min';
        }
        return val.toString();
    }

    /**
     * Normalize has: column name to exact header name.
     */
    function normalizeHasColumn(raw) {
        var t = (raw || '').toString().trim();
        var low = t.toLowerCase();
        if (low === 'script_lv') return 'Script_LV';
        if (low === 'script_en') return 'Script_EN';
        if (low === 'script_ru') return 'Script_RU';
        // Virtual column: auto ("Raw") transcripts live in the Script_EN cell.
        if (low === 'script_raw') return 'Script_RAW';
        if (low === 'dwnld.' || low === 'dwnld') return 'Dwnld.';
        if (low === 'links' || low === 'link') return 'Links';
        return t;
    }

    /**
     * Check if a cell has a link (XLSX _url field or non-empty content).
     */
    function cellHasLink(val, colName, row) {
        if (row && colName && row[colName + '_url']) return true;
        if (!val) return false;
        var s = val.toString().trim();
        return s !== '' && s !== 'N/A' && s !== '0';
    }

    /**
     * Check if a cell has an ORIGINAL link (excludes Duplicate-marked transcript cells).
     */
    var DUPLICATE_LABELS = new Set(['Duplicate', 'Dublikāts', 'Дубликат', 'Дубикат']);
    var NOT_RELEVANT_LABELS = new Set(['Not relevant', 'Neattiecas', 'Не относится']);
    function cellHasOriginalLink(val, colName, row) {
        if (!cellHasLink(val, colName, row)) return false;
        if (colName === 'Script_EN' || colName === 'Script_LV' || colName === 'Script_RU') {
            var s = (val || '').toString().trim();
            if (DUPLICATE_LABELS.has(s)) return false;
            if (NOT_RELEVANT_LABELS.has(s)) return false;
        }
        return true;
    }

    /**
     * Extract URL from cell value.
     */
    function extractUrl(val) {
        if (!val) return null;
        var s = val.toString().trim();
        if (s.startsWith('http')) return s;
        var m = s.match(/=HYPERLINK\("([^"]+)"/i);
        return m ? m[1] : null;
    }

    /**
     * Escape HTML special characters to prevent XSS.
     */
    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * Encode a value for safe use inside onclick="func('VALUE')".
     * Uses encodeURIComponent — safe in both HTML attribute and JS string contexts.
     * Decode on the JS side with decodeURIComponent().
     */
    function encodeForAttr(str) {
        return encodeURIComponent(str || '').replace(/'/g, '%27');
    }

    /**
     * Validate that a URL is a safe external link (http/https absolute URL only).
     * Rejects javascript:, data:, and other unsafe schemes.
     */
    function isSafeUrl(url) {
        if (!url) return false;
        var s = String(url).trim();
        // Atļauj tikai http/https absolūtos URL (Drive transkriptu saites).
        return /^https?:\/\//i.test(s);
    }

    // Public API
    return {
        removeDiacritics: removeDiacritics,
        transliterate: transliterate,
        compareDates: compareDates,
        normalizeForSearch: normalizeForSearch,
        escapeRegex: escapeRegex,
        formatLength: formatLength,
        normalizeHasColumn: normalizeHasColumn,
        cellHasLink: cellHasLink,
        cellHasOriginalLink: cellHasOriginalLink,
        extractUrl: extractUrl,
        escapeHtml: escapeHtml,
        encodeForAttr: encodeForAttr,
        isSafeUrl: isSafeUrl
    };
})();
