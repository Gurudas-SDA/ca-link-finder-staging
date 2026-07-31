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
        if (!input) return { terms: [], filters: { source: [], sourceSel: [], has: [], subject: [], lang: [], year: [], country: [], type: [], links: [], length: [], latestTranscripts: [], latestFiles: [] }, isLatestFiles: false, isLatestTranscripts: false, otherTerms: [], orGroups: [] };

        var searchTerms = input.split(';').map(function (s) { return s.trim(); }).filter(Boolean);

        var sourceTerms = [];
        var sourceSelTerms = [];
        var linksTerms = [];
        var lengthTerms = [];
        var hasTerms = [];
        var subjectTerms = [];
        var langTerms = [];
        var yearTerms = [];
        var countryTerms = [];
        var typeTerms = [];
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
            } else if (tl.startsWith('year:')) {
                // year:2024,2025 — comma-separated 4-digit years (Filters panel).
                t.slice(5).split(',').forEach(function (y) {
                    y = y.trim();
                    if (/^\d{4}$/.test(y)) yearTerms.push(y);
                });
            } else if (tl.startsWith('country:')) {
                // country:RUS,LVA — comma-separated canonical codes (Filters panel).
                t.slice(8).split(',').forEach(function (cc) {
                    cc = cc.trim();
                    if (cc) countryTerms.push(cc);
                });
            } else if (tl.startsWith('type:')) {
                // type:Lecture,Parikrama — comma-separated exact DB Type
                // values (Filters panel; Rājan, 2026-07-31).
                t.slice(5).split(',').forEach(function (tc) {
                    tc = tc.trim();
                    if (tc) typeTerms.push(tc);
                });
            } else if (tl.startsWith('source:')) {
                // source:Telegram,Guru_das — exact source names picked in the
                // Filters panel (kept apart from the free-text "@name" form so
                // a hand-typed @source is never clobbered by the panel).
                t.slice(7).split(',').forEach(function (sv) {
                    sv = sv.trim();
                    if (sv) sourceSelTerms.push(sv);
                });
            } else if (tl.startsWith('links:')) {
                // links:youtube,soundcloud — platform labels (Filters panel).
                t.slice(6).split(',').forEach(function (lv) {
                    lv = lv.trim();
                    if (lv) linksTerms.push(lv);
                });
            } else if (tl.startsWith('length:')) {
                // length:0-30,61-90 — minute ranges (Filters panel).
                t.slice(7).split(',').forEach(function (rv) {
                    rv = rv.trim();
                    if (rv) lengthTerms.push(rv);
                });
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
                sourceSel: sourceSelTerms,
                links: linksTerms,
                length: lengthTerms,
                has: hasTerms,
                subject: subjectTerms,
                lang: langTerms,
                year: yearTerms,
                country: countryTerms,
                type: typeTerms,
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
     * The values a single `lang:` token stands for. Comma separates several
     * picks; '+' inside one pick decodes back to the "; " the raw cell has
     * ("lang:eng+rus,rus only" -> ["eng; rus", "rus only"]). A plain legacy
     * token ("lang:eng") is unaffected.
     */
    function langTokenValues(token) {
        var cfg = (window.PPP && PPP.config) || {};
        var decode = cfg.decodeLangToken || function (s) { return s; };
        return String(token).slice(5).split(',')
            .map(function (v) { return decode(v.trim()).toLowerCase().trim(); })
            .filter(Boolean);
    }

    /**
     * `length` is human text ("45min", "1h 15min", "1h 19"), so the minute
     * value has to be derived in SQL. Guarded by LENGTH_HAS_TIME_SQL — cells
     * with no time at all (empty, or the handful that hold drifted junk) must
     * never fall into the 0-30 bucket via CAST('') = 0.
     */
    var LENGTH_MINUTES_SQL =
        "(CASE WHEN INSTR(LOWER(l.length),'h') > 0" +
        " THEN CAST(SUBSTR(LOWER(l.length),1,INSTR(LOWER(l.length),'h')-1) AS INTEGER) * 60" +
        "    + CAST(REPLACE(SUBSTR(LOWER(l.length),INSTR(LOWER(l.length),'h')+1),'min','') AS INTEGER)" +
        " ELSE CAST(REPLACE(LOWER(l.length),'min','') AS INTEGER) END)";
    var LENGTH_HAS_TIME_SQL = "(LOWER(l.length) LIKE '%min%' OR LOWER(l.length) LIKE '%h%')";

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

        // lang: filter (OR, exact or starts-with + ";"). TRIM() because a few
        // raw cells carry a trailing space ("eng only ").
        if (parsed.filters.lang.length > 0) {
            var langConds = [];
            parsed.filters.lang.forEach(function (t) {
                langTokenValues(t).forEach(function (val) {
                    var key = '$lang' + (paramIdx++);
                    var keyP = '$langp' + (paramIdx++);
                    params[key] = val;
                    params[keyP] = val + ';%';
                    langConds.push("(TRIM(LOWER(l.lang)) = " + key + " OR TRIM(LOWER(l.lang)) LIKE " + keyP + ")");
                });
            });
            if (langConds.length > 0) conditions.push('(' + langConds.join(' OR ') + ')');
        }

        // source: filter (Filters panel). Exact source name, OR within the
        // group. Kept separate from the free-text "@name" LIKE match above.
        if (parsed.filters.sourceSel && parsed.filters.sourceSel.length > 0) {
            var selConds = parsed.filters.sourceSel.map(function (sv) {
                var key = '$srcsel' + (paramIdx++);
                params[key] = sv.toLowerCase();
                return "TRIM(LOWER(l.source)) = " + key;
            });
            conditions.push('(' + selConds.join(' OR ') + ')');
        }

        // links: filter (Filters panel). The column holds a platform label,
        // so an exact (case-insensitive) match is enough — "SoundCloud" and
        // "Soundcloud" both fold to the same option.
        if (parsed.filters.links && parsed.filters.links.length > 0) {
            var linkConds = parsed.filters.links.map(function (lv) {
                var key = '$lnk' + (paramIdx++);
                params[key] = lv.toLowerCase();
                return "TRIM(LOWER(l.links)) = " + key;
            });
            conditions.push('(' + linkConds.join(' OR ') + ')');
        }

        // length: filter (Filters panel). OR within the group.
        if (parsed.filters.length && parsed.filters.length.length > 0) {
            var cfgLen = (window.PPP && PPP.config) || {};
            var lenConds = [];
            parsed.filters.length.forEach(function (rk) {
                var range = cfgLen.lengthRange ? cfgLen.lengthRange(rk) : null;
                if (!range) return;
                var loKey = '$lenlo' + (paramIdx++);
                params[loKey] = range.min;
                var cond = LENGTH_HAS_TIME_SQL + ' AND ' + LENGTH_MINUTES_SQL + ' >= ' + loKey;
                if (range.max !== null && range.max !== undefined) {
                    var hiKey = '$lenhi' + (paramIdx++);
                    params[hiKey] = range.max;
                    cond += ' AND ' + LENGTH_MINUTES_SQL + ' <= ' + hiKey;
                }
                lenConds.push('(' + cond + ')');
            });
            if (lenConds.length > 0) conditions.push('(' + lenConds.join(' OR ') + ')');
        }

        // year: filter (Filters panel). OR within the group (any selected year),
        // ANDed against the rest. Matches the 4-digit prefix of the date column.
        if (parsed.filters.year && parsed.filters.year.length > 0) {
            var yearConds = parsed.filters.year.map(function (y) {
                var key = '$yr' + (paramIdx++);
                params[key] = y + '%';
                return "l.date LIKE " + key;
            });
            conditions.push('(' + yearConds.join(' OR ') + ')');
        }

        // country: filter (Filters panel). OR within the group (any selected
        // country), ANDed against the rest. The stored cell is "CODE" or
        // "CODE, City", so a code-prefix match on country_norm covers both.
        // "Online" has no comma but the same prefix match still works.
        if (parsed.filters.country && parsed.filters.country.length > 0) {
            var cfg = (window.PPP && PPP.config) || {};
            var ctryConds = [];
            parsed.filters.country.forEach(function (cc) {
                // Expand the canonical code to every raw variant it folds from
                // (LVA also matches the drifted "lat" rows). Each raw code
                // matches the bare cell or a "code, city" cell.
                var raws = cfg.countryMatchCodes ? cfg.countryMatchCodes(cc) : [cc.toLowerCase()];
                raws.forEach(function (lc) {
                    var codeKey = '$ccode' + (paramIdx++);
                    var cityKey = '$ccity' + (paramIdx++);
                    params[codeKey] = lc;              // bare code, no city
                    params[cityKey] = lc + ',%';       // "code, city"
                    ctryConds.push("l.country_norm = " + codeKey + " OR l.country_norm LIKE " + cityKey);
                });
            });
            if (ctryConds.length > 0) conditions.push('(' + ctryConds.join(' OR ') + ')');
        }

        // type: filter (Filters panel). OR within the group (any selected
        // exact Type value), ANDed against the rest. Each token is the exact
        // DB `Type` string (Rājan, 2026-07-31) — matched against type_norm
        // with no family expansion, so "Lecture" never also matches
        // "Lecture (event)".
        if (parsed.filters.type && parsed.filters.type.length > 0) {
            var cfg2 = (window.PPP && PPP.config) || {};
            var typeConds = [];
            parsed.filters.type.forEach(function (tc) {
                var raws = cfg2.typeMatchValues ? cfg2.typeMatchValues(tc) : [];
                raws.forEach(function (rv) {
                    var key = '$type' + (paramIdx++);
                    params[key] = rv;
                    typeConds.push("l.type_norm = " + key);
                });
            });
            if (typeConds.length > 0) conditions.push('(' + typeConds.join(' OR ') + ')');
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
                var rowLang = (row['Lang.'] || '').toLowerCase().trim();
                if (!parsed.filters.lang.some(function (t) {
                    return langTokenValues(t).some(function (l) {
                        return rowLang === l || rowLang.startsWith(l + ';');
                    });
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
     * Runs against the sentence SHARDS via db.searchSentencesChunked(). (Until
     * 2026-07-27 this comment named the whole-file ppp_sentences_en.db; that DB
     * was shipped to every install and opened by nobody, and is gone now. Each
     * shard carries the same self-contained `sentences` + `lectures` tables, so
     * the SQL below is unchanged.)
     *
     * Same matching rules as the lecture-name search:
     *   - `;`  = AND groups, `//` = OR alternatives (parsed.orGroups).
     *   - Each alternative is diacritic-folded (removeDiacritics + lower) and matched
     *     as ONE CONTIGUOUS PHRASE, exactly like the lecture-name search: `guru
     *     tattva` finds "guru tattva" / "guru-tattva", NOT every sentence that
     *     happens to contain both words apart. (Corrected 2026-07-24: this mode
     *     had split terms into ANDed words, contradicting both the stated rule
     *     above and the comment right here.)
     *   - Prefix filters (subject:/lang:/@source/has:) are IGNORED in this mode — the
     *     sentences DB carries no such metadata (documented v1 limitation).
     *
     * PREFIX (word-start) matching: the phrase matches s.sentence_search LIKE
     * '% word[ word...]%'. sentence_search is diacritic-folded, lowercased, with every
     * run of non-alphanumeric chars collapsed to a single space and padded
     * with one leading/trailing space (built by scripts/build_sentences_db.py
     * to_search()). The leading space in the LIKE pattern anchors the match
     * to a word START, and the missing trailing space allows any suffix. So
     * `rice` matches `rice`/`rices` (word-start) but NOT `price`/`priceless`
     * (no space before "rice" there); `feather` matches `feather`/`feathers`.
     * The same anchor+open-suffix applies to the phrase as a whole, so
     * `guru tattva` also matches `guru tattvam`. Words are sanitized to
     * [a-z0-9] the same way the column is built, so any internal punctuation
     * in the term simply becomes a space inside the phrase.
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
                // ONE contiguous phrase — the words must appear next to each
                // other, in this order, exactly as in the lecture-name search.
                // sentence_search collapses every non-alphanumeric run to a
                // single space, so joining with ' ' also matches punctuated
                // forms: "guru tattva" hits "guru-tattva" and "Guru Tattva".
                var key = '$tw' + (paramIdx++);
                params[key] = '% ' + words.join(' ') + '%';
                return "(s.sentence_search LIKE " + key + ")";
            }).filter(Boolean);
            if (groupConds.length > 0) {
                conditions.push('(' + groupConds.join(' OR ') + ')');
            }
        });

        if (conditions.length === 0) {
            return null;
        }

        var where = conditions.join(' AND ');

        // year: filter (Filters panel) — ANDed onto the text match. The sentence
        // DB's `lectures` table carries `date` (but NOT country, so country: is
        // not supported here). Only applied ON TOP of a text term: a year alone
        // in "In Text" would scan a whole year of sentences, which belongs to
        // the "In Titles" browse, not the transcript-text search.
        var yearWhere = '';
        if (parsed.filters && parsed.filters.year && parsed.filters.year.length > 0) {
            var yearConds = parsed.filters.year.map(function (y) {
                var yk = '$syr' + (paramIdx++);
                params[yk] = y + '%';
                return "l.date LIKE " + yk;
            });
            yearWhere = '(' + yearConds.join(' OR ') + ')';
        }

        var mainWhere = yearWhere ? (where + ' AND ' + yearWhere) : where;
        var sql = "SELECT s.ts, s.ts_end, s.nr, s.seq, s.sentence, l.name AS name, l.url AS url, l.tier AS tier, l.date AS date " +
                  "FROM sentences s LEFT JOIN lectures l ON s.nr = l.nr " +
                  "WHERE " + mainWhere +
                  " ORDER BY CASE WHEN l.date='unknown' OR l.date IS NULL THEN 1 ELSE 0 END, l.date DESC, s.nr, s.seq ASC LIMIT $limit";
        // The count query normally skips the lectures JOIN for speed; the year
        // filter needs l.date, so join only when a year is actually selected.
        var countSql = yearWhere
            ? "SELECT COUNT(*) AS n, COUNT(DISTINCT s.nr) AS lectures FROM sentences s LEFT JOIN lectures l ON s.nr = l.nr WHERE " + mainWhere
            : "SELECT COUNT(*) AS n, COUNT(DISTINCT s.nr) AS lectures FROM sentences s WHERE " + where;
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
