/* ===========================================================================
   PPP Link Finder — Search engine
   Builds SQL queries for metadata and transcript search.
   Also provides in-memory search for backward compatibility with XLSX/CSV data.
   =========================================================================== */
window.PPP = window.PPP || {};

PPP.search = (function () {
    'use strict';

    var utils = PPP.utils;

    // Columns for free-text search (same as original SEARCH_COLS)
    var SEARCH_COLS = ['Date', 'Type', 'Original file name', 'Country', 'Lang.', 'Links', 'Dwnld.', 'Length', 'Script_EN', 'Script_LV', 'Script_RU'];

    // Hidden columns that provide match hints
    var HIDDEN_COLS = ['Subject', 'Subtype', 'Books', 'Author', 'Bhajans', 'Personality'];

    // Columns excluded from free-text search
    var SEARCH_EXCLUDE = new Set(['Source', 'Added', 'Scripts added', 'Nr.']);

    /**
     * Parse a search query string into structured components.
     * Supports: AND (;), OR (//), has:, subject:, lang:, source: (@), latest_files:, latest_transcripts:
     */
    function parseSearchQuery(input) {
        if (!input) return { terms: [], filters: {}, isLatestFiles: false, isLatestTranscripts: false, orGroups: [] };

        var searchTerms = input.split(';').map(function (s) { return s.trim(); }).filter(Boolean);

        var sourceTerms = [];
        var hasTerms = [];
        var subjectTerms = [];
        var langTerms = [];
        var latestTranscriptsTerms = [];
        var latestFilesTerms = [];
        var otherTerms = [];

        searchTerms.forEach(function (t) {
            var tl = t.toLowerCase();
            if (t.startsWith('@')) {
                sourceTerms.push(t);
            } else if (tl.startsWith('has:')) {
                hasTerms.push(t);
            } else if (tl.startsWith('subject:')) {
                subjectTerms.push(t);
            } else if (tl.startsWith('lang:')) {
                langTerms.push(t);
            } else if (tl.startsWith('latest_transcripts:')) {
                latestTranscriptsTerms.push(t);
            } else if (tl.startsWith('latest_files:')) {
                latestFilesTerms.push(t);
            } else {
                otherTerms.push(tl);
            }
        });

        // Parse OR groups from other terms
        var orGroups = otherTerms.map(function (term) {
            return term.split('//').map(function (s) { return s.trim(); }).filter(Boolean);
        });

        return {
            terms: searchTerms,
            filters: {
                source: sourceTerms,
                has: hasTerms,
                subject: subjectTerms,
                lang: langTerms,
                latestTranscripts: latestTranscriptsTerms,
                latestFiles: latestFilesTerms
            },
            isLatestFiles: latestFilesTerms.length > 0,
            isLatestTranscripts: latestTranscriptsTerms.length > 0,
            otherTerms: otherTerms,
            orGroups: orGroups
        };
    }

    /**
     * Build SQL query for metadata search using LIKE on normalized columns.
     * Returns {sql: string, params: object}.
     */
    function buildMetaSQL(parsed) {
        var conditions = [];
        var params = {};
        var paramIdx = 0;

        // source: filter (OR)
        if (parsed.filters.source.length > 0) {
            var srcConds = parsed.filters.source.map(function (t) {
                var key = '$src' + (paramIdx++);
                params[key] = '%' + t.slice(1).toLowerCase() + '%';
                return "LOWER(l.source) LIKE " + key;
            });
            conditions.push('(' + srcConds.join(' OR ') + ')');
        }

        // subject: filter (OR, case-sensitive exact match)
        if (parsed.filters.subject.length > 0) {
            var subjConds = parsed.filters.subject.map(function (t) {
                var key = '$subj' + (paramIdx++);
                params[key] = t.slice(8).trim();
                return "l.subject = " + key;
            });
            conditions.push('(' + subjConds.join(' OR ') + ')');
        }

        // lang: filter (OR, exact or starts-with + ";")
        if (parsed.filters.lang.length > 0) {
            var langConds = parsed.filters.lang.map(function (t) {
                var key = '$lang' + (paramIdx++);
                var keyP = '$langp' + (paramIdx++);
                var val = t.slice(5).toLowerCase();
                params[key] = val;
                params[keyP] = val + ';%';
                return "(LOWER(l.lang) = " + key + " OR LOWER(l.lang) LIKE " + keyP + ")";
            });
            conditions.push('(' + langConds.join(' OR ') + ')');
        }

        // has: filter (AND, check non-empty columns)
        parsed.filters.has.forEach(function (t) {
            var colName = utils.normalizeHasColumn(t.slice(4));
            // Map column names to SQLite column names (lowercase, underscored)
            var sqlCol = columnToSqlName(colName);
            if (sqlCol) {
                conditions.push("(l." + sqlCol + " IS NOT NULL AND l." + sqlCol + " != '' AND l." + sqlCol + " != 'N/A' AND l." + sqlCol + " != '0')");
            }
        });

        // latest_files: match by Nr.
        if (parsed.filters.latestFiles.length > 0) {
            var nrs = [];
            parsed.filters.latestFiles.forEach(function (t) {
                t.slice(13).split(',').forEach(function (n) { if (n.trim()) nrs.push(n.trim()); });
            });
            if (nrs.length > 0) {
                var nrPlaceholders = nrs.map(function (n, i) {
                    var key = '$nr' + (paramIdx++);
                    params[key] = n;
                    return key;
                });
                conditions.push('l.nr IN (' + nrPlaceholders.join(',') + ')');
            }
        }

        // latest_transcripts: match by Nr.
        if (parsed.filters.latestTranscripts.length > 0) {
            var nrs2 = [];
            parsed.filters.latestTranscripts.forEach(function (t) {
                t.slice(19).split(',').forEach(function (n) { if (n.trim()) nrs2.push(n.trim()); });
            });
            if (nrs2.length > 0) {
                var nrPlaceholders2 = nrs2.map(function (n, i) {
                    var key = '$nrt' + (paramIdx++);
                    params[key] = n;
                    return key;
                });
                conditions.push('l.nr IN (' + nrPlaceholders2.join(',') + ')');
            }
        }

        // Free-text search using LIKE on pre-normalized _norm columns (diacritics-insensitive)
        // _norm columns: original_file_name_norm, subject_norm, type_norm, subtype_norm,
        //                books_norm, author_norm, bhajans_norm, personality_norm, country_norm
        // Also search non-normalized columns that don't have diacritics: date, lang
        if (parsed.orGroups.length > 0) {
            // Each orGroup is an AND term that can have OR alternatives
            parsed.orGroups.forEach(function (group) {
                var groupConds = group.map(function (term) {
                    var normalized = utils.removeDiacritics(term.toLowerCase());
                    // Split into words — each word must match independently
                    var words = normalized.split(/\s+/).filter(Boolean);

                    var normCols = [
                        "l.original_file_name_norm", "l.subject_norm", "l.type_norm",
                        "l.subtype_norm", "l.books_norm", "l.author_norm",
                        "l.bhajans_norm", "l.personality_norm", "l.country_norm",
                        "LOWER(l.date)", "LOWER(l.lang)"
                    ];

                    if (words.length <= 1) {
                        var key = '$ft' + (paramIdx++);
                        params[key] = '%' + normalized + '%';
                        var colChecks = normCols.map(function (col) { return col + " LIKE " + key; });
                        return "(" + colChecks.join(" OR ") + ")";
                    }
                    // Multiple words: each word must match in at least one column
                    var wordConds = words.map(function (word) {
                        var key = '$ft' + (paramIdx++);
                        params[key] = '%' + word + '%';
                        var colChecks = normCols.map(function (col) { return col + " LIKE " + key; });
                        return "(" + colChecks.join(" OR ") + ")";
                    });
                    return "(" + wordConds.join(" AND ") + ")";
                });
                conditions.push('(' + groupConds.join(' OR ') + ')');
            });
        }

        var where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
        var sql = 'SELECT * FROM lectures l' + where + ' ORDER BY CASE WHEN l.date = \'unknown\' THEN 1 ELSE 0 END, l.date DESC, l.original_file_name DESC';

        return { sql: sql, params: params };
    }

    /**
     * Build SQL query for transcript search using LIKE on pre-normalized text_content_norm column.
     * Returns {sql: string, params: object}.
     */
    function buildTranscriptSQL(parsed) {
        var params = {};
        var paramIdx = 0;

        // Check if there are any free-text terms to search
        if (!parsed.orGroups || parsed.orGroups.length === 0) {
            return { sql: "SELECT * FROM transcripts LIMIT 0", params: {} };
        }

        // Use LIKE on pre-normalized text_content_norm column (diacritics already removed, lowercased)
        // Split each term into individual words so "Radharani prema" becomes two separate LIKE conditions
        var conditions = [];
        parsed.orGroups.forEach(function (group) {
            var groupConds = group.map(function (term) {
                var normalized = utils.removeDiacritics(term.toLowerCase());
                // Split into words — each word must match independently
                var words = normalized.split(/\s+/).filter(Boolean);
                if (words.length <= 1) {
                    var key = '$tt' + (paramIdx++);
                    params[key] = '%' + normalized + '%';
                    return "t.text_content_norm LIKE " + key;
                }
                // Multiple words: each must be present (AND within the term)
                var wordConds = words.map(function (word) {
                    var key = '$tt' + (paramIdx++);
                    params[key] = '%' + word + '%';
                    return "t.text_content_norm LIKE " + key;
                });
                return "(" + wordConds.join(" AND ") + ")";
            });
            conditions.push('(' + groupConds.join(' OR ') + ')');
        });

        var where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
        // No JOIN — transcripts DB has no lectures table. Lecture metadata is enriched by app.js from meta DB.
        var sql = 'SELECT t.nr, t.text_content, t.char_count, t.word_count FROM transcripts t' + where + ' LIMIT 100';

        return { sql: sql, params: params };
    }

    /**
     * In-memory search (backward compatibility with XLSX/CSV loaded data).
     * Same logic as original performSearch().
     */
    function searchInMemory(DB, searchTerm) {
        var parsed = parseSearchQuery(searchTerm);
        var matchHints = new Map();

        var results = DB.filter(function (row) {
            // @source: OR
            if (parsed.filters.source.length > 0) {
                var rowSource = (row['Source'] || '').toLowerCase();
                if (!parsed.filters.source.some(function (t) { return rowSource.includes(t.slice(1).toLowerCase()); })) return false;
            }

            // subject: case-SENSITIVE exact match, OR
            if (parsed.filters.subject.length > 0) {
                var rowSubject = (row['Subject'] || '').trim();
                if (!parsed.filters.subject.some(function (t) { return rowSubject === t.slice(8).trim(); })) return false;
            }

            // lang: exact or starts-with + ";", OR
            if (parsed.filters.lang.length > 0) {
                var rowLang = (row['Lang.'] || '').toLowerCase();
                if (!parsed.filters.lang.some(function (t) {
                    var l = t.slice(5).toLowerCase();
                    return rowLang === l || rowLang.startsWith(l + ';');
                })) return false;
            }

            // latest_transcripts: match Nr.
            if (parsed.filters.latestTranscripts.length > 0) {
                var rowNr = (row['Nr.'] || '').toString().trim();
                if (!parsed.filters.latestTranscripts.some(function (t) {
                    var nrs = t.slice(19).split(',');
                    return nrs.indexOf(rowNr) !== -1;
                })) return false;
            }

            // latest_files: match Nr.
            if (parsed.filters.latestFiles.length > 0) {
                var rowNr2 = (row['Nr.'] || '').toString().trim();
                if (!parsed.filters.latestFiles.some(function (t) {
                    var nrs = t.slice(13).split(',');
                    return nrs.indexOf(rowNr2) !== -1;
                })) return false;
            }

            // has: ALL must match
            if (parsed.filters.has.length > 0) {
                if (!parsed.filters.has.every(function (t) {
                    var colName = utils.normalizeHasColumn(t.slice(4));
                    return utils.cellHasLink(row[colName], colName, row);
                })) return false;
            }

            // Free-text: ALL terms must match (AND), with // as OR within each
            if (parsed.otherTerms.length > 0) {
                if (!parsed.otherTerms.every(function (term) {
                    var orTerms = term.split('//').map(function (t) { return t.trim(); });
                    return orTerms.some(function (orTerm) {
                        var normalizedTerm = utils.removeDiacritics(orTerm.toLowerCase());
                        var transliteratedTerm = utils.transliterate(normalizedTerm);
                        return SEARCH_COLS.some(function (col) {
                            var cellValue = utils.removeDiacritics((row[col] || '').toString().toLowerCase());
                            return cellValue.includes(normalizedTerm) || cellValue.includes(transliteratedTerm);
                        });
                    });
                })) return false;
            }

            return true;
        });

        // Build match hints for hidden columns
        if (parsed.otherTerms.length > 0) {
            results.forEach(function (row) {
                var hints = [];
                parsed.otherTerms.forEach(function (term) {
                    term.split('//').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (ot) {
                        findMatchingHiddenCols(row, ot).forEach(function (c) {
                            hints.push(c.col + ': ' + c.val);
                        });
                    });
                });
                if (hints.length > 0) {
                    matchHints.set(row, hints.filter(function (v, i, a) { return a.indexOf(v) === i; }));
                }
            });
        }

        // Sort
        results.sort(utils.compareDates);

        return { results: results, matchHints: matchHints };
    }

    /**
     * Find matches in hidden columns for hint display.
     */
    function findMatchingHiddenCols(row, searchTerm) {
        var matched = [];
        var termLower = searchTerm.toLowerCase();
        var termNoDia = utils.removeDiacritics(termLower);
        for (var i = 0; i < HIDDEN_COLS.length; i++) {
            var col = HIDDEN_COLS[i];
            var val = (row[col] || '').toLowerCase();
            if (!val) continue;
            if (val.includes(termLower) || utils.removeDiacritics(val).includes(termNoDia)) {
                matched.push({ col: col, val: row[col] });
            }
        }
        return matched;
    }

    /**
     * Map display column name to SQLite column name.
     */
    function columnToSqlName(colName) {
        var map = {
            'Date': 'date', 'Type': 'type', 'Original file name': 'original_file_name',
            'Country': 'country', 'Lang.': 'lang', 'Links': 'links',
            'Dwnld.': 'dwnld', 'Length': 'length', 'Script_EN': 'script_en',
            'Script_LV': 'script_lv', 'Script_RU': 'script_ru',
            'Source': 'source', 'Subject': 'subject', 'Nr.': 'nr',
            'Added': 'added', 'Scripts added': 'scripts_added',
            'Direct URL': 'direct_url', 'Subtype': 'subtype',
            'Books': 'books', 'Author': 'author', 'Bhajans': 'bhajans',
            'Personality': 'personality'
        };
        return map[colName] || null;
    }

    /**
     * Build SQL query for verse citation search.
     * Searches verse_citations and verse_citation_stats tables in meta DB.
     * Returns {sql: string, params: object, mode: 'citations'|'stats'}.
     */
    function buildCitationSQL(parsed) {
        var params = {};
        var paramIdx = 0;

        if (!parsed.orGroups || parsed.orGroups.length === 0) {
            // No search term — show citation stats overview
            return {
                sql: "SELECT source_canonical, total_citations, unique_verses, lecture_count FROM verse_citation_stats ORDER BY source_canonical ASC",
                params: {},
                mode: 'stats'
            };
        }

        // Search by source name or chapter/verse reference
        var conditions = [];
        parsed.orGroups.forEach(function (group) {
            var groupConds = group.map(function (term) {
                var normalized = utils.removeDiacritics(term.toLowerCase());
                var words = normalized.split(/\s+/).filter(Boolean);

                // Each word must match in reference or source_canonical
                var wordConds = words.map(function (word) {
                    var key = '$cv' + (paramIdx++);
                    params[key] = '%' + word + '%';
                    return "(LOWER(vc.reference) LIKE " + key + " OR LOWER(vc.source_canonical) LIKE " + key + " OR LOWER(vc.chapter_verse) LIKE " + key + ")";
                });
                return "(" + wordConds.join(" AND ") + ")";
            });
            conditions.push('(' + groupConds.join(' OR ') + ')');
        });

        var where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
        var sql = "SELECT vc.lecture_nr, vc.source_canonical, vc.reference, vc.chapter_verse, vc.context, " +
                  "l.original_file_name, l.date, l.subject " +
                  "FROM verse_citations vc " +
                  "LEFT JOIN lectures l ON vc.lecture_nr = l.nr" +
                  where +
                  " ORDER BY vc.source_canonical, vc.chapter_verse LIMIT 200";

        return { sql: sql, params: params, mode: 'citations' };
    }

    return {
        parseSearchQuery: parseSearchQuery,
        buildMetaSQL: buildMetaSQL,
        buildTranscriptSQL: buildTranscriptSQL,
        buildCitationSQL: buildCitationSQL,
        searchInMemory: searchInMemory,
        SEARCH_COLS: SEARCH_COLS,
        HIDDEN_COLS: HIDDEN_COLS
    };
})();
