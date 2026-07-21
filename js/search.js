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
    var SEARCH_COLS = ['Date', 'Type', 'Original file name', 'Country', 'Lang.'];

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

        // subject: filter (OR, case-sensitive — matches exact or as one of `;`-separated tags)
        if (parsed.filters.subject.length > 0) {
            var subjConds = parsed.filters.subject.map(function (t) {
                var v = t.slice(8).trim();
                var kE = '$subjE' + (paramIdx++);
                var kS = '$subjS' + (paramIdx++);
                var kM = '$subjM' + (paramIdx++);
                var kT = '$subjT' + (paramIdx++);
                params[kE] = v;             // exact
                params[kS] = v + ';%';      // starts: "tag; ..."
                params[kM] = '%; ' + v + ';%'; // middle: "...; tag; ..."
                params[kT] = '%; ' + v;     // tail:  "...; tag"
                return "(l.subject = " + kE + " OR l.subject LIKE " + kS + " OR l.subject LIKE " + kM + " OR l.subject LIKE " + kT + ")";
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

        // has: filter (AND, check non-empty columns; includes duplicate-labeled transcripts)
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
                    var normCols = [
                        "l.original_file_name_norm", "l.type_norm",
                        "l.country_norm",
                        "LOWER(l.date)", "LOWER(l.lang)"
                    ];
                    // Phrase match — entire term as one literal substring
                    var key = '$ft' + (paramIdx++);
                    params[key] = '%' + normalized + '%';
                    var colChecks = normCols.map(function (col) { return col + " LIKE " + key; });
                    return "(" + colChecks.join(" OR ") + ")";
                });
                conditions.push('(' + groupConds.join(' OR ') + ')');
            });
        }

        var where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';
        var sql = 'SELECT * FROM lectures l' + where + ' ORDER BY CASE WHEN l.date = \'unknown\' THEN 1 ELSE 0 END, l.date DESC, l.original_file_name DESC';

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

            // subject: case-SENSITIVE — match exact or as one of `;`-separated tags
            if (parsed.filters.subject.length > 0) {
                var rowSubject = (row['Subject'] || '').trim();
                var rowSubjectTags = rowSubject.split(/\s*;\s*/);
                if (!parsed.filters.subject.some(function (t) {
                    var v = t.slice(8).trim();
                    return rowSubject === v || rowSubjectTags.indexOf(v) !== -1;
                })) return false;
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

    /**
     * Build SQL query for transcript sentence search (Advanced / "In Transcripts" mode).
     * Searches the self-contained sentences DB (ppp_sentences_en.db).
     *
     * Same matching rules as the lecture-name search:
     *   - `;`  = AND groups, `//` = OR alternatives (parsed.orGroups).
     *   - Each alternative is diacritic-folded (removeDiacritics + lower), split into
     *     words; every word must co-occur in the SAME sentence (word AND).
     *   - Prefix filters (subject:/lang:/@source/has:) are IGNORED in this mode — the
     *     sentences DB carries no such metadata (documented v1 limitation).
     *
     * PREFIX (word-start) matching: each word matches s.sentence_search LIKE
     * '% word%'. sentence_search is diacritic-folded, lowercased, with every
     * run of non-alphanumeric chars collapsed to a single space and padded
     * with one leading/trailing space (built by scripts/build_sentences_db.py
     * to_search()). The leading space in the LIKE pattern anchors the match
     * to a word START, and the missing trailing space allows any suffix. So
     * `rice` matches `rice`/`rices` (word-start) but NOT `price`/`priceless`
     * (no space before "rice" there); `feather` matches `feather`/`feathers`.
     * Words are sanitized to [a-z0-9] the same way the column is built; a term
     * with internal punctuation (e.g. a hyphen) splits into multiple ANDed words.
     *
     * Returns { sql, countSql, params } — or null when there is no free-text term.
     * The main query takes a $limit param (default 500); callers may override it
     * (e.g. the Excel export re-runs with a very high limit for the full result set).
     */
    function buildTranscriptSQL(parsed) {
        if (!parsed.orGroups || parsed.orGroups.length === 0) {
            return null;
        }

        var params = {};
        var paramIdx = 0;
        var conditions = [];

        parsed.orGroups.forEach(function (group) {
            var groupConds = group.map(function (term) {
                var normalized = utils.removeDiacritics(term.toLowerCase());
                // Sanitize to alphanumeric words exactly like the sentence_search
                // column: split on any non [a-z0-9] run, drop empties. Internal
                // punctuation (e.g. a hyphen) yields multiple ANDed words.
                var words = normalized.split(/[^a-z0-9]+/).filter(Boolean);
                if (words.length === 0) return null;
                // Each word must appear at a WORD-START in the same sentence (AND).
                var wordConds = words.map(function (word) {
                    var key = '$tw' + (paramIdx++);
                    params[key] = '% ' + word + '%';
                    return "s.sentence_search LIKE " + key;
                });
                return "(" + wordConds.join(" AND ") + ")";
            }).filter(Boolean);
            if (groupConds.length > 0) {
                conditions.push('(' + groupConds.join(' OR ') + ')');
            }
        });

        if (conditions.length === 0) {
            return null;
        }

        var where = conditions.join(' AND ');
        var sql = "SELECT s.ts, s.ts_end, s.nr, s.seq, s.sentence, l.name AS name, l.url AS url, l.tier AS tier, l.date AS date " +
                  "FROM sentences s LEFT JOIN lectures l ON s.nr = l.nr " +
                  "WHERE " + where +
                  " ORDER BY CASE WHEN l.date='unknown' OR l.date IS NULL THEN 1 ELSE 0 END, l.date DESC, s.nr, s.seq ASC LIMIT $limit";
        var countSql = "SELECT COUNT(*) AS n, COUNT(DISTINCT s.nr) AS lectures FROM sentences s WHERE " + where;
        params.$limit = 500;

        return { sql: sql, countSql: countSql, params: params };
    }

    return {
        parseSearchQuery: parseSearchQuery,
        buildMetaSQL: buildMetaSQL,
        buildCitationSQL: buildCitationSQL,
        buildTranscriptSQL: buildTranscriptSQL,
        searchInMemory: searchInMemory,
        SEARCH_COLS: SEARCH_COLS,
        HIDDEN_COLS: HIDDEN_COLS
    };
})();
