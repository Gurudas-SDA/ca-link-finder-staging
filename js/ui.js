/* ===========================================================================
   PPP Link Finder — UI rendering
   Extracted and enhanced from original index.html
   =========================================================================== */
window.PPP = window.PPP || {};

PPP.ui = (function () {
    'use strict';

    var t = function (key) { return PPP.i18n.t(key); };
    var utils = PPP.utils;

    var columnHeaders = ['Date', 'Type', 'Original file name', 'Country', 'Lang.', 'Links', 'Dwnld.', 'Length', 'Script_EN', 'Script_LV', 'Script_RU'];
    // "In Text" (sentence search) table — SAME column set/renderer as the
    // metadata table, with these differences (Rājan design, Phase B):
    // no Length column, and NO separate Timestamp column — the matched
    // sentence's time is shown inline after the lecture name, in parentheses
    // (see _renderLectureRow: "Name (ts)"). The name
    // column header reads "File title / Sentence" in this mode.
    var sentenceColumnHeaders = ['Date', 'Type', 'Original file name', 'Country', 'Lang.', 'Links', 'Dwnld.', 'Script_EN', 'Script_LV', 'Script_RU'];

    /**
     * Build a per-language selection checkbox. ALWAYS rendered next to each
     * selectable transcript chip (no select-mode). Carries data-nr + data-lang;
     * toggling adds/removes "<nr>|<lang>" from the selection Set.
     */
    function _makeSelCheckbox(nr, lang, langLabel) {
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'select-checkbox';
        cb.setAttribute('data-nr', nr);
        cb.setAttribute('data-lang', lang);
        cb.checked = !!(PPP.app.isSelectedPair && PPP.app.isSelectedPair(nr, lang));
        cb.setAttribute('aria-label', t('selectTranscriptAria').replace('{lang}', (langLabel || lang).toString().toUpperCase()));
        cb.onclick = function (e) { e.stopPropagation(); };
        cb.onchange = function (e) {
            var el = e.currentTarget;
            var nr = el.getAttribute('data-nr');
            var lang = el.getAttribute('data-lang');
            var applied = PPP.app.toggleSelectPair(nr, lang, el.checked);
            // Rejected (e.g. MP3_ZIP_MAX_COUNT hard cap) — snap the checkbox
            // back to unchecked; the selection Set was never touched.
            if (applied === false) { el.checked = false; return; }
            // Checkbox-sync: sentence search can render several rows for the
            // SAME lecture. The selection Set is keyed by "<nr>|<lang>", so the
            // state is already shared — mirror the new checked state onto every
            // sibling checkbox with the same nr+lang so all rows of that lecture
            // stay visually in sync (otherwise siblings look stale until the
            // next re-render).
            _syncSelCheckboxes(nr, lang, el.checked, el);
        };
        return cb;
    }

    /**
     * Mirror a (nr,lang) selection state onto every rendered select-checkbox
     * that shares the same lecture nr + language, EXCEPT the one just toggled.
     * Keeps duplicate rows (sentence search renders one row per matching
     * sentence) visually consistent with the shared selection Set. DOM-only —
     * never touches the selection Set itself.
     */
    function _syncSelCheckboxes(nr, lang, checked, exceptEl) {
        var boxes = document.querySelectorAll('input.select-checkbox');
        for (var i = 0; i < boxes.length; i++) {
            var b = boxes[i];
            if (b === exceptEl) continue;
            if (b.getAttribute('data-nr') === nr && b.getAttribute('data-lang') === lang) {
                b.checked = checked;
            }
        }
    }

    /**
     * Shared script-transcript chip renderer (checkbox + EN/Raw/Duplicate
     * link). Used by BOTH the metadata table's Script_EN/LV/RU cells
     * (non-verse mode) and the sentence-search table's Transkripts cell, so
     * the chip markup/behavior/selection-key semantics never drift apart
     * between the two tables.
     *
     * langLabel precedence: duplicate label > 'Raw' > defaultLangLabel.
     * Duplicates are never selectable (no checkbox).
     */
    function _renderScriptChip(td, nr, langCode, defaultLangLabel, isRaw, isDuplicate, dupLabel, driveUrl, highlightSentence) {
        var langLabel = isDuplicate ? dupLabel : (isRaw ? 'Raw' : defaultLangLabel);
        var viewBtn = document.createElement('a');
        viewBtn.href = '#';
        viewBtn.textContent = langLabel;
        // S94: class only used by mobile card CSS (desktop keeps inline styles)
        viewBtn.className = 'script-chip ' + (isDuplicate ? 'script-dup' : (isRaw ? 'script-raw' : 'script-orig'));
        viewBtn.title = isRaw ? 'Open raw (auto) transcript' : 'Open transcript';
        if (isDuplicate) {
            // Duplicate label: blue, 11px, same as Essence
            viewBtn.style.cssText = 'color:#1a4fa8;font-weight:600;font-size:11px;text-decoration:underline;cursor:pointer;';
        } else if (isRaw) {
            // Raw (auto) transcript: muted gray so users see it is not polished
            viewBtn.style.cssText = 'color:#888;font-weight:600;text-decoration:underline;cursor:pointer;';
        } else {
            viewBtn.style.cssText = 'color:var(--saffron);font-weight:700;text-decoration:underline;cursor:pointer;';
        }
        viewBtn.setAttribute('data-nr', nr);
        viewBtn.setAttribute('data-lang', langCode);
        viewBtn.setAttribute('data-drive-url', driveUrl || '');
        // "In Text" mode: carry the matched sentence so the viewer opens right
        // at it. Only on the EN chip — the sentence DB (and thus the match) is
        // English; an LV/RU transcript would not contain it.
        if (highlightSentence && langCode === 'en') {
            viewBtn.setAttribute('data-sentence', highlightSentence);
        }
        viewBtn.onclick = function (e) {
            e.preventDefault();
            var el = e.currentTarget;
            var elNr = el.getAttribute('data-nr');
            var elLang = el.getAttribute('data-lang');
            var dUrl = el.getAttribute('data-drive-url') || undefined;
            var hlText = el.getAttribute('data-sentence') || undefined;
            if (elNr) {
                PPP.app.openHtmlTranscriptViewer(elNr, elLang, null, null, dUrl, hlText);
            } else if (dUrl) {
                window.open(dUrl, '_blank');
            }
        };
        // Per-language checkbox ALWAYS rendered before selectable chips
        // (premium or raw). Duplicates stay non-selectable.
        if (!isDuplicate) {
            td.appendChild(_makeSelCheckbox(nr, langCode, langLabel));
        }
        td.appendChild(viewBtn);
    }

    /**
     * Get localized column header name.
     */
    function getColumnHeader(colName) {
        var map = {
            'Date': 'colDate', 'Type': 'colType', 'Original file name': 'colOriginalFileName',
            'Country': 'colCountry', 'Lang.': 'colLang', 'Links': 'colLinks',
            'Dwnld.': 'colDwnld', 'Length': 'colLength'
        };
        return map[colName] ? t(map[colName]) : colName;
    }

    /**
     * Per-language transcript counts for the header row ("EN - 1,234").
     * Counted over the CURRENT result set (the same rows the table renders),
     * not over the whole database. EN/LV/RU count real, original transcripts
     * (duplicates, "Not relevant" and auto "Raw" cells excluded); Raw counts
     * the Script_EN cells marked "Raw".
     */
    var DUP_LABELS_H = { 'Duplicate': 1, 'Dublik\u0101ts': 1, '\u0414\u0443\u0431\u043b\u0438\u043a\u0430\u0442': 1, '\u0414\u0443\u0431\u0438\u043a\u0430\u0442': 1 };
    var NOT_REL_LABELS_H = { 'Not relevant': 1, 'Neattiecas': 1, '\u041d\u0435 \u043e\u0442\u043d\u043e\u0441\u0438\u0442\u0441\u044f': 1 };
    /** "EN - 676" (or a bare "EN" while the number is not known yet). */
    function _langCountLabel(lang, n) {
        return (typeof n === 'number') ? (lang + ' - ' + n.toLocaleString()) : lang;
    }

    // Whole-database totals, used whenever the header has no result set to
    // describe (empty search box / empty table). Loaded once, then cached.
    var _totalCounts = null;
    var _totalsPending = false;
    var _totalsTries = 0;

    /**
     * Count the transcripts of the WHOLE database (one SQL pass) and put the
     * numbers into any header already on screen. Safe to call repeatedly.
     */
    function loadTotalScriptCounts() {
        if (_totalCounts || _totalsPending) return;
        if (!PPP.db || !PPP.db.queryMetaAsync) return;
        _totalsPending = true;
        var lvDup = 'Dublik' + String.fromCharCode(257) + 'ts';
        var ruDup = String.fromCharCode(1044, 1091, 1073, 1083, 1080, 1082, 1072, 1090);
        var ruDupTypo = String.fromCharCode(1044, 1091, 1073, 1080, 1082, 1072, 1090);
        var ruNotRel = String.fromCharCode(1053, 1077, 32, 1086, 1090, 1085, 1086, 1089, 1080, 1090, 1089, 1103);
        function q(list) {
            return list.map(function (v) { return "'" + v.replace(/'/g, "''") + "'"; }).join(',');
        }
        var enSkip = q(['', 'N/A', '0', 'Raw', 'Duplicate', 'Not relevant']);
        var lvSkip = q(['', 'N/A', '0', 'Duplicate', lvDup, 'Not relevant', 'Neattiecas']);
        var ruSkip = q(['', 'N/A', '0', 'Duplicate', ruDup, ruDupTypo, 'Not relevant', ruNotRel]);
        var sql =
            'SELECT ' +
            "SUM(CASE WHEN TRIM(COALESCE(script_en,'')) NOT IN (" + enSkip + ') THEN 1 ELSE 0 END) AS en, ' +
            "SUM(CASE WHEN TRIM(COALESCE(script_lv,'')) NOT IN (" + lvSkip + ') THEN 1 ELSE 0 END) AS lv, ' +
            "SUM(CASE WHEN TRIM(COALESCE(script_ru,'')) NOT IN (" + ruSkip + ') THEN 1 ELSE 0 END) AS ru, ' +
            "SUM(CASE WHEN TRIM(COALESCE(script_en,'')) = 'Raw' THEN 1 ELSE 0 END) AS raw " +
            'FROM lectures';
        PPP.db.queryMetaAsync(sql).then(function (res) {
            var r = (res && res[0]) || null;
            if (!r) { _totalsPending = false; return; }
            _totalCounts = {
                'Script_EN': parseInt(r.en, 10) || 0,
                'Script_LV': parseInt(r.lv, 10) || 0,
                'Script_RU': parseInt(r.ru, 10) || 0,
                'Script_RAW': parseInt(r.raw, 10) || 0
            };
            _totalsPending = false;
            _fillHeaderCounts();
        }).catch(function (e) {
            _totalsPending = false;
            // The header is built before the meta DB finishes loading, so the
            // first attempts legitimately fail with 'Database "meta" not
            // loaded'. Retry quietly until it is there (~1 min ceiling).
            if (++_totalsTries < 40) { setTimeout(loadTotalScriptCounts, 1500); return; }
            console.warn('transcript totals failed:', e);
        });
    }

    /**
     * Patch the totals into a header that was rendered before they arrived
     * (first paint) — only where no result-set count is shown yet.
     */
    function _fillHeaderCounts() {
        if (!_totalCounts) return;
        var LABEL = { 'Script_EN': 'EN', 'Script_LV': 'LV', 'Script_RU': 'RU', 'Script_RAW': 'Raw' };
        var nodes = document.querySelectorAll('#resultsTable thead [data-count-col]');
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            if (el.textContent.indexOf('-') !== -1) continue;   // already counted
            var key = el.getAttribute('data-count-col');
            el.textContent = _langCountLabel(LABEL[key], _totalCounts[key]);
        }
    }

    function countScriptCols(rows) {
        var c = { 'Script_EN': 0, 'Script_LV': 0, 'Script_RU': 0, 'Script_RAW': 0 };
        if (!rows) return c;
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            ['Script_EN', 'Script_LV', 'Script_RU'].forEach(function (col) {
                var v = (r[col] || '').toString().trim();
                if (v === '' || v === 'N/A' || v === '0') return;
                if (DUP_LABELS_H[v] || NOT_REL_LABELS_H[v]) return;
                if (col === 'Script_EN' && v === 'Raw') { c['Script_RAW']++; return; }
                c[col]++;
            });
        }
        return c;
    }

    /**
     * Build the multi-row table header (same structure as original).
     * mode 'sentences' swaps in the sentence-search column set (no Length
     * column, "File title / Sentence" header on the name column).
     */
    function buildHeader(thead, totalCount, mode, counts) {
        // Empty search box -> the header describes the whole database; make sure
        // those totals are on their way (no-op once loaded).
        if (!counts) loadTotalScriptCounts();
        var cols = (mode === 'sentences') ? sentenceColumnHeaders : columnHeaders;
        var row0 = thead.insertRow();
        // Extra spacer for star + share columns
        var starSpacer = document.createElement('th');
        starSpacer.colSpan = 2;
        starSpacer.style.border = 'none';
        starSpacer.style.backgroundColor = 'transparent';
        row0.appendChild(starSpacer);
        // Spacer-cell count must mirror the REAL column count the loop below
        // builds (Script_LV/Script_RU are skipped, not real columns; Script_EN
        // becomes a 3-wide block): a hardcoded 11 matched metadata mode's 11
        // real columns by coincidence, but sentence mode has no Length column
        // (10 real columns) — the mismatch left this invisible row one column
        // WIDER than the visible header rows, so the colored header band fell
        // a column short of the table's actual (rounded) right edge, exposing
        // a cream notch at the corner (Rājan report, 2026-07-25).
        var extraCols = 0;
        for (var ci = 0; ci < cols.length; ci++) {
            if (cols[ci] === 'Script_LV' || cols[ci] === 'Script_RU') continue;
            extraCols += (cols[ci] === 'Script_EN') ? 3 : 1;
        }
        for (var i = 0; i < extraCols; i++) {
            var c = document.createElement('th');
            c.style.border = 'none';
            c.style.backgroundColor = 'transparent';
            row0.appendChild(c);
        }

        var row1 = thead.insertRow();
        var row2 = thead.insertRow();
        var row3 = thead.insertRow();

        // Star column header
        var starTh = document.createElement('th');
        starTh.rowSpan = 3;
        starTh.className = 'fav-cell';
        starTh.innerHTML = '&#9733;';
        starTh.style.color = 'var(--primary)';
        starTh.style.fontSize = '14px';
        row1.appendChild(starTh);

        // Share column header
        var shareTh = document.createElement('th');
        shareTh.rowSpan = 3;
        shareTh.className = 'share-cell';
        shareTh.innerHTML = '&#128279;';
        shareTh.style.fontSize = '12px';
        row1.appendChild(shareTh);

        for (var idx = 0; idx < cols.length; idx++) {
            var h = cols[idx];
            if (h === 'Length') {
                var th = document.createElement('th');
                th.textContent = getColumnHeader(h);
                th.rowSpan = 3;
                row1.appendChild(th);
                continue;
            }
            if (h === 'Script_EN') {
                var thBlock = document.createElement('th');
                thBlock.colSpan = 3; thBlock.rowSpan = 2; thBlock.className = 'transcripts-block';
                thBlock.style.textAlign = 'left'; thBlock.style.verticalAlign = 'middle';

                var comboContainer = document.createElement('div');
                comboContainer.style.cssText = 'display:inline-block;';
                thBlock.appendChild(comboContainer);

                var ttLabel = document.createElement('div');
                ttLabel.setAttribute('data-i18n', 'transcriptsAndTranslations');
                var countStr = (typeof totalCount === 'number' && totalCount > 0) ? (totalCount.toLocaleString() + ' ') : '';
                ttLabel.textContent = countStr + t('transcriptsAndTranslations');
                ttLabel.style.cssText = 'font-weight:700;font-size:14px;color:#1a3a6b;margin-bottom:6px;text-transform:none;text-align:center;letter-spacing:0.3px;';
                comboContainer.appendChild(ttLabel);

                // The By Date / By Topic / Newest buttons are lecture-BROWSE
                // navigation — they switch to a different view. In the sentence
                // ("In Text") results they are redundant/confusing (clicking one
                // throws the user out of their search), so render them only in the
                // non-sentence (lecture) tables. Keep the label in every view.
                if (mode !== 'sentences') {
                    var btnWrap = document.createElement('div');
                    btnWrap.className = 'tt-btnwrap'; // S94: mobile card CSS hook (inert on desktop)
                    btnWrap.style.cssText = 'display:inline-flex;gap:0;justify-content:flex-start;align-items:center;';

                    var bdBtn = document.createElement('button');
                    bdBtn.setAttribute('data-i18n', 'byDate');
                    bdBtn.textContent = t('byDate');
                    bdBtn.style.cssText = 'background:linear-gradient(135deg,#e8842c,#f4a54b);color:#fff;border:none;padding:6px 14px;cursor:pointer;font-weight:700;border-radius:20px 0 0 20px;font-size:11px;transition:all 0.2s;letter-spacing:0.2px;';
                    bdBtn.onclick = function () { if (PPP.app && PPP.app.showAllTranscriptsByDate) PPP.app.showAllTranscriptsByDate(); };

                    var btBtn = document.createElement('button');
                    btBtn.setAttribute('data-i18n', 'lectureTopics');
                    btBtn.textContent = t('lectureTopics');
                    btBtn.style.cssText = 'background:linear-gradient(135deg,#1a3a6b,#2a4f8a);color:#fff;border:none;padding:6px 14px;cursor:pointer;font-weight:700;border-radius:0;font-size:11px;transition:all 0.2s;letter-spacing:0.2px;';
                    btBtn.onclick = function () { if (PPP.app && PPP.app.showTopics) PPP.app.showTopics(); };

                    var nBtn = document.createElement('button');
                    nBtn.setAttribute('data-i18n', 'latest20Transcripts');
                    nBtn.textContent = t('latest20Transcripts');
                    nBtn.style.cssText = 'background:linear-gradient(135deg,#b8860b,#d4a843);color:#fff;border:none;padding:6px 14px;cursor:pointer;font-weight:700;border-radius:0 20px 20px 0;font-size:11px;transition:all 0.2s;letter-spacing:0.2px;';
                    nBtn.onclick = function () { if (PPP.app && PPP.app.showLatestTranscripts) PPP.app.showLatestTranscripts(); };

                    // Single-active state (Rājan UX): highlight the button for
                    // the currently-showing transcript view, dim the others so
                    // the user can tell which sort is active. State lives in app
                    // (PPP.app.getTranscriptView) so it survives re-renders.
                    bdBtn.setAttribute('data-view', 'byDate');
                    btBtn.setAttribute('data-view', 'byTopic');
                    nBtn.setAttribute('data-view', 'newest');
                    var _activeTv = (PPP.app && PPP.app.getTranscriptView) ? PPP.app.getTranscriptView() : null;
                    // Single-active (Rājan): the active sort is vivid; the others
                    // are ALWAYS clearly greyed — including when no sort is active
                    // (then all three are greyed), matching the top button groups.
                    [bdBtn, btBtn, nBtn].forEach(function (b) {
                        if (_activeTv && b.getAttribute('data-view') === _activeTv) {
                            b.classList.add('active');
                            b.style.opacity = '1';
                            b.style.filter = 'none';
                            b.style.boxShadow = 'inset 0 0 0 2px rgba(255,255,255,0.65), 0 2px 6px rgba(0,0,0,0.28)';
                        } else {
                            b.style.opacity = '0.45';
                            b.style.filter = 'grayscale(0.7)';
                        }
                    });

                    btnWrap.appendChild(bdBtn);
                    btnWrap.appendChild(btBtn);
                    btnWrap.appendChild(nBtn);
                    comboContainer.appendChild(btnWrap);
                }

                row1.appendChild(thBlock);
                // Transcript counts in the language headers (Rajan,
                // 2026-08-22): "EN - 676". With an empty search box the numbers
                // describe the WHOLE database; with results they describe the
                // current result set.
                //
                // Raw transcripts ARE English and live in the EN column itself,
                // so their count is a SUB-LINE under EN (black, not saffron) —
                // not a fourth language.
                var _cnt = counts || _totalCounts || {};
                [['EN', 'Script_EN'], ['LV', 'Script_LV'], ['RU', 'Script_RU']].forEach(function (pair) {
                    var lang = pair[0], colKey = pair[1];
                    var thL = document.createElement('th');
                    thL.className = 'transcript-lang';

                    var line = document.createElement('div');
                    line.className = 'tl-lang';
                    line.setAttribute('data-count-col', colKey);
                    line.textContent = _langCountLabel(lang, _cnt[colKey]);
                    line.onclick = function () {
                        if (PPP.app && PPP.app.applyHasFilter) PPP.app.applyHasFilter(colKey);
                    };
                    thL.appendChild(line);

                    if (colKey === 'Script_EN') {
                        var rawLine = document.createElement('div');
                        rawLine.className = 'tl-raw';
                        rawLine.setAttribute('data-count-col', 'Script_RAW');
                        rawLine.textContent = _langCountLabel('Raw', _cnt['Script_RAW']);
                        rawLine.onclick = function () {
                            if (PPP.app && PPP.app.applyHasFilter) PPP.app.applyHasFilter('Script_RAW');
                        };
                        thL.appendChild(rawLine);
                    }
                    row3.appendChild(thL);
                });
                idx += 2; // skip Script_LV and Script_RU
                continue;
            }
            if (h === 'Script_LV' || h === 'Script_RU') continue;
            var th2 = document.createElement('th');
            th2.textContent = (mode === 'sentences' && h === 'Original file name')
                ? t('sentColFileSentence')
                : getColumnHeader(h);
            th2.rowSpan = 3;
            row1.appendChild(th2);
        }
    }

    /**
     * Render results table rows.
     */
    function renderResults(rows, searchTermStr, startIndex, endIndex, matchHints, showAddedDate) {
        // Language switch: the extras cache holds only the previously active
        // language, so re-scope it from core:extras and render again when it
        // lands. Rendering continues immediately with what is cached (EN
        // fallback) rather than blanking the essence/summary column.
        _syncExtrasLang(function () {
            renderResults(rows, searchTermStr, startIndex, endIndex, matchHints, showAddedDate);
        });
        var table = document.getElementById('resultsTable');
        table.innerHTML = '';
        // S94: mobile card layout hook — CSS (≤640px) turns rows of THIS
        // 13-column lecture table into cards. Other tables (citations,
        // transcript snippets) keep the classic table layout.
        table.classList.add('lecture-cards');
        table.classList.remove('sentence-mode');
        var thead = table.createTHead();
        // Count: only lectures with at least one ORIGINAL transcript (EN/LV/RU non-duplicate)
        var DUP_LABELS = { 'Duplicate': 1, 'Dublikāts': 1, 'Дубликат': 1, 'Дубикат': 1 };
        var NOT_REL_LABELS = { 'Not relevant': 1, 'Neattiecas': 1, 'Не относится': 1 };
        function isOrig(v) {
            v = (v || '').toString().trim();
            return v !== '' && v !== 'N/A' && v !== '0' && !DUP_LABELS[v] && !NOT_REL_LABELS[v];
        }
        var origCount = rows ? rows.filter(function (r) {
            return isOrig(r['Script_EN']) || isOrig(r['Script_LV']) || isOrig(r['Script_RU']);
        }).length : 0;
        buildHeader(thead, origCount, null, countScriptCols(rows));
        var tbody = table.createTBody();

        if (rows.length === 0) {
            var r = tbody.insertRow();
            var c = r.insertCell();
            c.colSpan = columnHeaders.length + 2;
            c.className = 'empty-result-message';
            c.textContent = t('noResultsFound');
            return;
        }

        var searchTerms = searchTermStr ? searchTermStr.split(';') : [];

        for (var i = startIndex; i < endIndex && i < rows.length; i++) {
            _renderLectureRow(tbody, rows[i], searchTerms, columnHeaders, null, showAddedDate);
        }
    }

    /**
     * Render ONE lecture row (star + share + data cells) into tbody.
     * Shared by the metadata table (cols = columnHeaders, sentCtx = null) and
     * the sentence-search table (cols = sentenceColumnHeaders, sentCtx =
     * { ts, sentenceHtml }) so the two tables render identically.
     * sentCtx.ts is shown inline after the lecture name "Name (ts)";
     * sentCtx.sentenceHtml (already highlighted + escaped) is appended under
     * the file title, using the same match-hint visual mechanism as translated
     * titles / essence lines.
     */
    function _renderLectureRow(tbody, row, searchTerms, cols, sentCtx, showAddedDate) {
        {
            var tr = tbody.insertRow();

            // Star / favorite cell
            var starTd = tr.insertCell();
            starTd.className = 'fav-cell';
            var nr = (row['Nr.'] || '').toString().trim();
            // Per-language multi-select checkboxes now live BEFORE each transcript
            // chip (script-orig / script-raw) in the Script_* columns — see
            // _makeSelCheckbox() below. Duplicates (script-dup) are not selectable.
            if (nr && PPP.favorites) {
                var btn = document.createElement('button');
                btn.className = 'fav-star' + (PPP.favorites.isFavorite(nr) ? ' active' : '');
                btn.setAttribute('data-nr', nr);
                btn.setAttribute('aria-label', t('saveTo'));
                btn.innerHTML = '&#9733;';
                btn.onclick = function (e) {
                    e.stopPropagation();
                    var el = e.currentTarget;
                    var nrVal = el.getAttribute('data-nr');
                    showSaveToPopup(nrVal, el);
                };
                starTd.appendChild(btn);
            }

            // Share / deep link cell
            var shareTd = tr.insertCell();
            shareTd.className = 'share-cell';
            if (nr && PPP.app.copyShareLink) {
                var shareBtn = document.createElement('button');
                shareBtn.className = 'share-btn';
                shareBtn.setAttribute('data-nr', nr);
                shareBtn.setAttribute('data-title', (row['Original file name'] || '').toString().trim());
                shareBtn.setAttribute('data-subject', (row['Subject'] || '').toString().trim());
                shareBtn.innerHTML = '&#128279;'; // 🔗
                shareBtn.title = t('copyLink');
                shareBtn.setAttribute('aria-label', t('copyLink'));
                shareBtn.onclick = function (e) {
                    var el = e.currentTarget;
                    PPP.app.copyShareLink(
                        el.getAttribute('data-nr'),
                        el.getAttribute('data-title'),
                        el.getAttribute('data-subject')
                    );
                };
                shareTd.appendChild(shareBtn);
            }

            for (var ci = 0; ci < cols.length; ci++) {
                var col = cols[ci];
                var td = tr.insertCell();
                var val = row[col] || '';

                if (col === 'Links' || col === 'Dwnld.' || col === 'Script_EN' || col === 'Script_LV' || col === 'Script_RU') {
                    // For verse search results: all script columns get auto-scroll links
                    var isScriptCol = (col === 'Script_EN' || col === 'Script_LV' || col === 'Script_RU');
                    if (isScriptCol && row._blockIndex && row._lectureNr) {
                        var hasScript = val && val !== 'N/A' && val !== '0' && val !== '';
                        if (hasScript) {
                            var cellTrimNR = (val || '').toString().trim();
                            if (cellTrimNR === 'Not relevant' || cellTrimNR === 'Neattiecas' || cellTrimNR === 'Не относится') {
                                var spanNR = document.createElement('span');
                                spanNR.textContent = cellTrimNR;
                                spanNR.style.cssText = 'color:#222;font-size:11px;';
                                td.appendChild(spanNR);
                            } else {
                            var defaultLangLabel = col.split('_')[1];
                            var langCode = defaultLangLabel.toLowerCase();
                            // Recognize special cell markers like the non-verse path.
                            // Non-ASCII duplicate labels (LV "Dublikats" with a-macron,
                            // RU "Dubikat") are built via char codes to keep source ASCII-safe.
                            var lvDup = 'Dublik' + String.fromCharCode(257) + 'ts';
                            var ruDup = String.fromCharCode(1044, 1091, 1073, 1080, 1082, 1072, 1090);
                            var ruDupCorrect = String.fromCharCode(1044, 1091, 1073, 1083, 1080, 1082, 1072, 1090);
                            var cellTrim = (val || '').toString().trim();
                            var isDuplicate = (cellTrim === 'Duplicate' || cellTrim === lvDup || cellTrim === ruDup || cellTrim === ruDupCorrect);
                            var isRaw = (cellTrim === 'Raw');
                            var langLabel = isDuplicate ? cellTrim : (isRaw ? 'Raw' : defaultLangLabel);
                            var viewBtn = document.createElement('a');
                            viewBtn.href = '#';
                            viewBtn.textContent = langLabel;
                            // S94: class only used by mobile card CSS (desktop keeps inline styles)
                            viewBtn.className = 'script-chip ' + (isDuplicate ? 'script-dup' : (isRaw ? 'script-raw' : 'script-orig'));
                            viewBtn.title = isRaw ? 'Open raw (auto) transcript at [' + row._blockIndex + ']' : 'Open transcript at [' + row._blockIndex + ']';
                            if (isDuplicate) {
                                viewBtn.style.cssText = 'color:#1a4fa8;font-weight:600;font-size:11px;text-decoration:underline;cursor:pointer;';
                            } else if (isRaw) {
                                viewBtn.style.cssText = 'color:#888;font-weight:600;text-decoration:underline;cursor:pointer;';
                            } else {
                                viewBtn.style.cssText = 'color:var(--saffron);font-weight:700;text-decoration:underline;cursor:pointer;';
                            }
                            viewBtn.setAttribute('data-nr', row._lectureNr);
                            viewBtn.setAttribute('data-lang', langCode);
                            viewBtn.setAttribute('data-block', row._blockIndex);
                            viewBtn.setAttribute('data-ref', row._verseReference || '');
                            viewBtn.onclick = function (e) {
                                e.preventDefault();
                                var el = e.currentTarget;
                                PPP.app.openHtmlTranscriptViewer(
                                    el.getAttribute('data-nr'),
                                    el.getAttribute('data-lang'),
                                    parseInt(el.getAttribute('data-block'), 10),
                                    el.getAttribute('data-ref')
                                );
                            };
                            // Per-language checkbox ALWAYS rendered before selectable
                            // chips (premium or raw). Duplicates stay non-selectable.
                            if (!isDuplicate) {
                                td.appendChild(_makeSelCheckbox(row._lectureNr, langCode, langLabel));
                            }
                            td.appendChild(viewBtn);
                            } // end else (not-relevant check)
                        }
                    } else if (isScriptCol) {
                        // NON-VERSE MODE: open in-app modal for script columns
                        var scriptDriveUrl = row[col + '_url'] || utils.extractUrl(val);
                        if (scriptDriveUrl && !scriptDriveUrl.startsWith('http')) scriptDriveUrl = null;
                        var hasScript = val && val !== 'N/A' && val !== '0' && val !== '';
                        if (hasScript) {
                            var cellTrim = (val || '').toString().trim();
                            if (cellTrim === 'Not relevant' || cellTrim === 'Neattiecas' || cellTrim === 'Не относится') {
                                var spanNRnv = document.createElement('span');
                                spanNRnv.textContent = cellTrim;
                                spanNRnv.style.cssText = 'color:#222;font-size:11px;';
                                td.appendChild(spanNRnv);
                            } else {
                            var defaultLangLabel = col.split('_')[1];
                            var langCode = defaultLangLabel.toLowerCase();
                            // If the cell value is a duplicate label, show it; otherwise show EN/LV/RU
                            var DUP_LABELS = { 'Duplicate': 1, 'Dublikāts': 1, 'Дубликат': 1, 'Дубикат': 1 };
                            var isDuplicate = !!DUP_LABELS[cellTrim];
                            var isRaw = (cellTrim === 'Raw');
                            var lectNr = (row['Nr.'] || '').toString().trim();
                            // In sentence ("In Text") mode the row carries the
                            // matched sentence — pass it so the EN chip opens the
                            // transcript scrolled to that sentence.
                            _renderScriptChip(td, lectNr, langCode, defaultLangLabel, isRaw, isDuplicate, cellTrim, scriptDriveUrl, (sentCtx && sentCtx.sentence) || null);
                            } // end else (not-relevant check)
                        }
                    } else {
                        // Links and Dwnld. columns — keep existing behavior (external links)
                        var url = row[col + '_url'] || utils.extractUrl(val);
                        if (!url && col === 'Links') url = row['Direct URL_url'] || (row['Direct URL'] || '').toString().trim() || null;
                        if (url && !url.startsWith('http')) url = null;
                        var label = col === 'Dwnld.' ? 'Mp3' : (val || 'Link');
                        if (url) {
                            if (col === 'Dwnld.' && nr) {
                                td.appendChild(_makeSelCheckbox(nr, 'mp3', 'Mp3'));
                            }
                            var a = document.createElement('a');
                            a.href = url;
                            a.textContent = label;
                            a.className = 'ext-chip'; // S94: mobile card chip styling hook
                            a.target = '_blank';
                            a.rel = 'noopener';
                            // Offline guard: MP3/YouTube/Drive links need the network.
                            a.onclick = function (e) {
                                if (window.PPP && PPP.net && !PPP.net.online) {
                                    e.preventDefault();
                                    toast(t('requiresInternet'));
                                }
                            };
                            td.appendChild(a);
                        } else if (val && val !== 'N/A' && val !== '0' && val !== '') {
                            td.textContent = label;
                        }
                    }
                } else if (col === 'Length') {
                    td.textContent = utils.formatLength(val);
                } else if (col === 'Original file name') {
                    var lectureHasSummary = nr && hasSummary(nr);
                    if (lectureHasSummary) {
                        var link = document.createElement('a');
                        link.href = '#';
                        link.innerHTML = highlightSearchTerms(val, searchTerms);
                        link.style.cssText = 'color:inherit;text-decoration:underline;text-decoration-style:dotted;cursor:pointer;';
                        link.setAttribute('data-nr', nr);
                        link.setAttribute('data-name', val);
                        link.onclick = function (e) {
                            e.preventDefault();
                            var el = e.currentTarget;
                            openSummaryModal(el.getAttribute('data-name'), el.getAttribute('data-nr'));
                        };
                        td.appendChild(link);
                    } else {
                        td.innerHTML = highlightSearchTerms(val, searchTerms);
                    }
                    // Sentence-mode only: append the matched sentence's start
                    // time inline after the lecture name, in parentheses —
                    // always "Name (ts)" (start only; Rājan cancelled the
                    // both-bounds range design). Replaces the former standalone
                    // Timestamp column (removed in Phase B).
                    if (sentCtx && sentCtx.ts) {
                        var tsSpan = document.createElement('span');
                        tsSpan.className = 'sentence-ts';
                        tsSpan.textContent = ' (' + sentCtx.ts + ')';
                        td.appendChild(tsSpan);
                    }
                    if (!sentCtx) {
                        // Metadata ("In Titles") mode only — Rājan rule: a
                        // sentence-hit row shows ONLY title + matched sentence,
                        // never the translated-title hint or the essence line.
                        // "By Added" view only: the visible Date column is the
                        // LECTURE date, not when it was added to the DB — show
                        // the added date too so the sort order is legible
                        // (Rājan report, 2026-07-31).
                        if (showAddedDate) {
                            var addedVal = (row['Added'] || '').toString().trim();
                            if (addedVal) {
                                var addedSpan = document.createElement('span');
                                addedSpan.className = 'match-hint added-hint';
                                addedSpan.textContent = t('addedLabel') + ': ' + addedVal;
                                td.appendChild(addedSpan);
                            }
                        }
                        // Tulkotais nosaukums zem oriģināla (tumši zils) — tikai non-EN valodās
                        var langPref = localStorage.getItem('preferredLanguage') || 'en';
                        if (langPref !== 'en' && nr) {
                            var translatedTitle = getTitleTranslation(nr, langPref);
                            if (translatedTitle) {
                                var titleSpan = document.createElement('span');
                                titleSpan.className = 'match-hint translated-title';
                                titleSpan.textContent = translatedTitle;
                                td.appendChild(titleSpan);
                            }
                        }
                        // Essence zem nosaukuma (sarkans, prefiksu lokalizē LV/RU)
                        var essenceText = nr ? getEssence(nr) : '';
                        if (essenceText) {
                            var prefix = (langPref === 'lv') ? 'Būtība: ' : (langPref === 'ru') ? 'Суть: ' : 'Essence: ';
                            var essSpan = document.createElement('span');
                            essSpan.className = 'match-hint essence-hint';
                            essSpan.textContent = prefix + essenceText;
                            td.appendChild(essSpan);
                        }
                    } else if (sentCtx.sentenceHtml) {
                        // Sentence-mode: the matched sentence (pre-highlighted,
                        // pre-escaped HTML) under the title — the ONLY extra
                        // line in this cell.
                        var sentSpan = document.createElement('span');
                        sentSpan.className = 'match-hint sentence-hit';
                        sentSpan.innerHTML = sentCtx.sentenceHtml;
                        td.appendChild(sentSpan);
                    }
                } else {
                    td.innerHTML = highlightSearchTerms(val, searchTerms);
                }
            }
        }
    }

    /**
     * Render the empty sentence-mode frame — shown IMMEDIATELY when the user
     * switches to "In Text" mode, before any search has run, so the results
     * area changes look (localized headers + distinct header tone) the
     * instant the mode button is pressed rather than only after a search.
     * Uses the SAME multi-row header as the metadata table (buildHeader with
     * mode 'sentences') — the unified full column set.
     */
    function renderEmptySentenceTable() {
        _syncExtrasLang();   // nothing to re-render, just warm the next search
        var table = document.getElementById('resultsTable');
        table.innerHTML = '';
        table.classList.remove('lecture-cards');
        table.classList.add('sentence-mode');
        var thead = table.createTHead();
        buildHeader(thead, undefined, 'sentences');
        var tbody = table.createTBody();
        var r = tbody.insertRow();
        var c = r.insertCell();
        c.colSpan = sentenceColumnHeaders.length + 2;
        c.className = 'empty-result-message';
        c.textContent = t('sentEmptyHint');
    }

    /**
     * Render advanced transcript (sentence) search results — UNIFIED layout
     * (Rājan design pivot): every sentence hit renders as a FULL metadata
     * lecture row (star, share, Date, Type, Country, Lang., Links, Dwnld.
     * incl. mp3 checkbox, EN/LV/RU transcript chips incl. checkboxes) via the
     * shared _renderLectureRow, with exactly two differences from "In Titles":
     * no Length column, and the matched sentence's start time is shown inline
     * after the lecture name "Name (ts)" while the matched sentence
     * (highlighted) shows UNDER the file title in the "File title / Sentence"
     * column (match-hint mechanism). One lecture
     * can appear in several rows — one per sentence hit.
     * rows: [{ ts, nr, seq, sentence, name, url, tier, date }]
     * totals: { total, lectures, shown }
     */
    function renderSentenceResults(rows, searchTermStr, totals, foldedWords) {
        // See renderResults(): re-scope extras to the newly active language
        // and render again once it lands.
        _syncExtrasLang(function () {
            renderSentenceResults(rows, searchTermStr, totals, foldedWords);
        });
        totals = totals || {};
        foldedWords = foldedWords || [];

        // Summary line + Download Excel button above the table.
        var info = document.getElementById('resultsInfo');
        if (info) {
            if (rows && rows.length > 0) {
                var summary = t('sentenceResultsSummary')
                    .replace('{n}', totals.total != null ? totals.total : rows.length)
                    .replace('{m}', totals.lectures != null ? totals.lectures : '')
                    .replace('{k}', totals.shown != null ? totals.shown : rows.length);
                info.innerHTML = '<strong>' + utils.escapeHtml(summary) + '</strong> ' +
                    '<button type="button" class="search-button" style="margin-left:10px;" ' +
                    'onclick="PPP.app.exportSentencesExcel()">' + utils.escapeHtml(t('downloadExcel')) + '</button>';
            } else {
                info.innerHTML = '';
            }
        }

        var table = document.getElementById('resultsTable');
        table.innerHTML = '';
        // sentence-mode (olive header) instead of lecture-cards: the mobile
        // card CSS is tuned for the "In Titles" result set; sentence hits
        // keep the classic table layout like citations do.
        table.classList.remove('lecture-cards');
        table.classList.add('sentence-mode');
        var thead = table.createTHead();
        buildHeader(thead, undefined, 'sentences');
        var tbody = table.createTBody();

        if (!rows || rows.length === 0) {
            var r0 = tbody.insertRow();
            var c0 = r0.insertCell();
            c0.colSpan = sentenceColumnHeaders.length + 2;
            c0.className = 'empty-result-message';
            c0.textContent = t('noTranscriptResults');
        } else {
            rows.forEach(function (row) {
                var nr = (row.nr != null) ? String(row.nr) : '';
                // Full lecture metadata row from the already-loaded meta DB.
                // If it is missing (should not happen — sentences DB is built
                // from the same lectures), fall back to a minimal stub built
                // from the sentences DB fields so the row still renders
                // (title + EN chip + timestamp; other cells stay empty).
                var metaRow = (nr && PPP.app && PPP.app.getDbRowByNr) ? PPP.app.getDbRowByNr(nr) : null;
                if (!metaRow) {
                    metaRow = {
                        'Nr.': nr,
                        'Original file name': row.name || ('Nr.' + nr),
                        'Script_EN': ((row.tier || '').toString().toLowerCase() === 'raw') ? 'Raw' : 'EN',
                        'Script_EN_url': row.url || ''
                    };
                }
                var sentCtx = {
                    ts: row.ts || '',
                    ts_end: row.ts_end || '',
                    sentence: row.sentence || '',   // raw text → deep-open scroll target
                    sentenceHtml: highlightSentencePrefix(row.sentence || '', foldedWords)
                };
                // searchTerms deliberately [] — highlighting belongs to the
                // sentence line, not the title (the sentence words need not
                // appear in the title at all).
                _renderLectureRow(tbody, metaRow, [], sentenceColumnHeaders, sentCtx);
            });
        }

        // Show/hide the persistent "Download selected" button + panel — same
        // mechanism the metadata table results use.
        if (PPP.app && PPP.app.showSelectToggle) {
            PPP.app.showSelectToggle(!!(rows && rows.length > 0));
        }
    }

    /**
     * Render pagination controls.
     */
    function renderPagination(totalResults, currentPage, pageSize, onPageChange) {
        var div = document.getElementById('pagination');
        div.innerHTML = '';
        var totalPages = Math.ceil(totalResults / pageSize);
        if (totalPages <= 0) return;

        var tp = document.createElement('button');
        tp.textContent = totalPages === 1 ? '1 ' + t('page') : totalPages + ' ' + t('pages');
        tp.className = 'total-pages-button';
        div.appendChild(tp);

        var prev = document.createElement('button');
        prev.innerHTML = '&lt; ' + t('previous');
        prev.onclick = function () { onPageChange(currentPage - 1); };
        prev.disabled = currentPage === 1;
        prev.className = 'nav-button';
        div.appendChild(prev);

        var maxV = 5;
        var sP = Math.max(1, currentPage - Math.floor(maxV / 2));
        var eP = Math.min(totalPages, sP + maxV - 1);
        if (eP - sP + 1 < maxV) sP = Math.max(1, eP - maxV + 1);

        for (var i = sP; i <= eP; i++) {
            var b = document.createElement('button');
            b.textContent = i;
            b.onclick = (function (page) {
                return function () { onPageChange(page); };
            })(i);
            b.className = i === currentPage ? 'current-page' : 'nav-button';
            div.appendChild(b);
        }

        var next = document.createElement('button');
        next.innerHTML = t('next') + ' &gt;';
        next.onclick = function () { onPageChange(currentPage + 1); };
        next.disabled = currentPage === totalPages || totalPages === 0;
        next.className = 'nav-button';
        div.appendChild(next);
    }

    /**
     * Render the empty table with header.
     */
    function renderEmptyTable() {
        _syncExtrasLang();   // nothing to re-render, just warm the next search
        var table = document.getElementById('resultsTable');
        table.innerHTML = '';
        table.classList.add('lecture-cards'); // S94: keep card layout hook on empty state too
        table.classList.remove('sentence-mode');
        var thead = table.createTHead();
        buildHeader(thead);
        var tbody = table.createTBody();
        var r = tbody.insertRow();
        var c = r.insertCell();
        c.colSpan = columnHeaders.length + 2;
        c.className = 'empty-result-message';
        c.textContent = t('enterSearchTerms');
    }

    /**
     * Render topics/playlists dropdown.
     */
    function renderTopics(DB, container) {
        var counts = {};
        DB.forEach(function (r) {
            // Count only lectures with at least one ORIGINAL transcript (EN/LV/RU)
            var hasOrig = utils.cellHasOriginalLink(r['Script_EN'], 'Script_EN', r) ||
                utils.cellHasOriginalLink(r['Script_LV'], 'Script_LV', r) ||
                utils.cellHasOriginalLink(r['Script_RU'], 'Script_RU', r);
            if (!hasOrig) return;
            var s = (r['Subject'] || '').trim();
            if (s) counts[s] = (counts[s] || 0) + 1;
        });

        var html = '<button id="topicsHideBtn" class="recommendations-hide-btn" onclick="PPP.app.showTopics()">' + utils.escapeHtml(t('hideTopicsBtn')) + '</button><div id="topicsListContent">';
        Object.entries(counts).sort(function (a, b) { return a[0].localeCompare(b[0]); }).forEach(function (entry) {
            var name = entry[0], count = entry[1];
            var nameSafe = utils.encodeForAttr(name);
            html += '<div class="topic-item"><span class="topic-name">' + utils.escapeHtml(name) +
                ' <span style="color:var(--primary-dark);font-weight:700;">(' + count + ')</span></span>' +
                '<button class="topic-search-btn" onclick="PPP.app.applySubjectFilter(decodeURIComponent(\'' + nameSafe + '\'))">Yes</button></div>';
        });
        html += '</div>';
        container.innerHTML = html;
    }

    /**
     * Render stats in connection status area.
     */
    function renderStats(stats) {
        var el = document.getElementById('connectionStatus');
        if (!el || !stats) return;
        var total = stats.total_lectures || '0';
        el.textContent = total + ' lectures';
    }

    /**
     * Highlight search terms in text (exact port from original).
     */
    function highlightSearchTerms(text, searchTerms) {
        if (!text || !Array.isArray(searchTerms)) return utils.escapeHtml(text) || '';
        var result = utils.escapeHtml(text);
        searchTerms.forEach(function (term) {
            if (!term) return;
            term = term.trim();
            if (!term || term.startsWith('subject:') || term.startsWith('lang:') || term.startsWith('latest_') || term.startsWith('has:')) return;
            if (term.startsWith('@')) {
                var re = new RegExp('(' + utils.escapeRegex(term.slice(1)) + ')', 'gi');
                result = result.replace(re, '<span style="background-color: #d4edda; border-radius: 2px; padding: 0 2px;">$1</span>');
                return;
            }
            term.split('//').forEach(function (sub) {
                var subTrimmed = sub.trim();
                if (!subTrimmed) return;
                var nTerm = utils.removeDiacritics(subTrimmed.toLowerCase());
                // Exact highlight
                var exactRe = new RegExp('(' + utils.escapeRegex(subTrimmed) + ')', 'gi');
                result = result.replace(exactRe, '<span style="background-color: #fce9b8; border-radius: 2px; padding: 0 2px;">$1</span>');
                // Diacritic highlight
                var diaRe = new RegExp('(\\p{L}+)', 'gu');
                result = result.replace(diaRe, function (m) {
                    if (utils.removeDiacritics(m.toLowerCase()) === nTerm && m.toLowerCase() !== nTerm) {
                        return '<span style="background-color: #c8ddf0; border-radius: 2px; padding: 0 2px;">' + m + '</span>';
                    }
                    return m;
                });
                // Cyrillic highlight
                var cyrTerm = utils.transliterate(nTerm);
                if (cyrTerm !== nTerm) {
                    var cyrRe = new RegExp('(' + utils.escapeRegex(cyrTerm) + ')', 'gi');
                    result = result.replace(cyrRe, function (m) {
                        return !/[a-zA-Z0-9]/.test(m) ? '<span style="background-color: #f5d0b0; border-radius: 2px; padding: 0 2px;">' + m + '</span>' : m;
                    });
                }
            });
        });
        return result;
    }

    /**
     * Compute the length (in original code units of `run`) whose folded
     * (diacritic-stripped, lowercased) form has exactly `wLen` characters.
     * Robust to combining marks folding to zero-width and multi-char folds.
     */
    function _foldedPrefixLen(run, wLen) {
        var acc = 0, i = 0;
        while (i < run.length && acc < wLen) {
            acc += utils.removeDiacritics(run[i].toLowerCase()).length;
            i++;
        }
        return i;
    }

    /**
     * Diacritic- and case-insensitive, word-start-prefix highlighter for the
     * sentence-search ("Text" mode) results table. Unlike highlightSearchTerms
     * (which does whole-term/whole-word matching for the other search modes),
     * this matches a folded WORD PREFIX so "mahaprabh" highlights "Mahāprabh"
     * inside "Mahāprabhu" without highlighting the trailing "u".
     *
     * foldedWords: already diacritic-stripped, lowercased search words.
     */
    function highlightSentencePrefix(text, foldedWords) {
        if (!text || !foldedWords || !foldedWords.length) return utils.escapeHtml(text || '');
        return text.replace(/[\p{L}\p{M}\p{N}]+|[^\p{L}\p{M}\p{N}]+/gu, function (tok) {
            if (!/^[\p{L}\p{M}\p{N}]/u.test(tok)) return utils.escapeHtml(tok);
            var folded = utils.removeDiacritics(tok.toLowerCase());
            var best = null;
            foldedWords.forEach(function (w) {
                if (w && folded.indexOf(w) === 0 && (!best || w.length > best.length)) best = w;
            });
            if (!best) return utils.escapeHtml(tok);
            var prefixLen = _foldedPrefixLen(tok, best.length);
            // Two-tier highlight (matches the ZIP-export mark.tr-word): the
            // matched WORD sits on light green inside the yellow sentence line
            // (.sentence-hit). Dark text keeps green-on-yellow readable.
            return '<span class="sent-word-hit">' +
                utils.escapeHtml(tok.slice(0, prefixLen)) + '</span>' + utils.escapeHtml(tok.slice(prefixLen));
        });
    }

    /**
     * Extract snippet around first match.
     */
    function getSnippet(text, terms, contextChars) {
        if (!text) return '';
        contextChars = contextChars || 120;
        var lowerText = utils.removeDiacritics(text.toLowerCase());
        var firstIdx = -1;

        for (var i = 0; i < terms.length && firstIdx === -1; i++) {
            var term = terms[i].trim();
            if (!term || term.startsWith('subject:') || term.startsWith('lang:') || term.startsWith('has:') || term.startsWith('latest_') || term.startsWith('@')) continue;
            term.split('//').forEach(function (sub) {
                if (firstIdx !== -1) return;
                var normalized = utils.removeDiacritics(sub.trim().toLowerCase());
                if (normalized) {
                    var idx = lowerText.indexOf(normalized);
                    if (idx !== -1) firstIdx = idx;
                }
            });
        }

        if (firstIdx === -1) {
            return text.substring(0, contextChars * 2) + (text.length > contextChars * 2 ? '...' : '');
        }

        var start = Math.max(0, firstIdx - contextChars);
        var end = Math.min(text.length, firstIdx + contextChars);
        var snippet = '';
        if (start > 0) snippet += '...';
        snippet += text.substring(start, end);
        if (end < text.length) snippet += '...';
        return snippet;
    }

    /**
     * Show loading message.
     */
    function showLoading(message) {
        var bar = document.getElementById('progressBar');
        if (bar) {
            bar.style.display = 'block';
            var label = bar.querySelector('.progress-label');
            if (label) label.textContent = message || t('loadingDB');
        }
    }

    function setLoadingText(message) {
        var bar = document.getElementById('progressBar');
        if (!bar) return;
        var label = bar.querySelector('.progress-label');
        if (label && message) label.textContent = message;
    }

    function extrasReady() {
        return _extrasCache !== null;
    }

    /**
     * Hide loading message.
     */
    function hideLoading() {
        var bar = document.getElementById('progressBar');
        if (bar) bar.style.display = 'none';
    }

    /**
     * Update progress bar value.
     */
    function updateProgress(fraction) {
        var fill = document.getElementById('progressFill');
        if (fill) fill.style.width = Math.round(fraction * 100) + '%';
    }

    /**
     * Render citation search results (individual verse citations with lecture info).
     */
    function renderCitationResults(rows, searchTerms) {
        var table = document.getElementById('resultsTable');
        table.classList.remove('lecture-cards'); // not the 13-col lecture table
        table.classList.remove('sentence-mode');
        var html = '<thead><tr>' +
            '<th>Reference</th>' +
            '<th>Source</th>' +
            '<th>Chapter:Verse</th>' +
            '<th>Lecture</th>' +
            '<th>Date</th>' +
            '<th>Context</th>' +
            '</tr></thead><tbody>';

        if (!rows || rows.length === 0) {
            html += '<tr><td colspan="6" class="empty-result-message">' + t('noCitationResults') + '</td></tr>';
        } else {
            rows.forEach(function (row) {
                var ref = highlightSearchTerms(row.reference || '', searchTerms);
                var source = utils.escapeHtml(row.source_canonical || '');
                var cv = utils.escapeHtml(row.chapter_verse || '');
                var lecture = highlightSearchTerms(row.original_file_name || ('Nr.' + row.lecture_nr), searchTerms);
                var date = utils.escapeHtml(row.date || '');
                var ctx = row.context || '';
                if (ctx.length > 150) ctx = ctx.substring(0, 150) + '...';
                ctx = highlightSearchTerms(ctx, searchTerms);

                html += '<tr>' +
                    '<td><strong>' + ref + '</strong></td>' +
                    '<td>' + source + '</td>' +
                    '<td>' + cv + '</td>' +
                    '<td>' + lecture + '</td>' +
                    '<td>' + date + '</td>' +
                    '<td style="font-size:0.85em;color:#666;">' + ctx + '</td>' +
                    '</tr>';
            });
        }
        html += '</tbody>';
        table.innerHTML = html;
    }

    /**
     * Render citation stats overview (when no search term entered in Verses mode).
     */
    function renderCitationStats(rows) {
        var table = document.getElementById('resultsTable');
        table.classList.remove('lecture-cards'); // not the 13-col lecture table
        table.classList.remove('sentence-mode');
        var html = '<thead><tr>' +
            '<th>Source</th>' +
            '<th>Total Citations</th>' +
            '<th>Unique Verses</th>' +
            '<th>Lectures</th>' +
            '</tr></thead><tbody>';

        if (!rows || rows.length === 0) {
            html += '<tr><td colspan="4" class="empty-result-message">No citation data available</td></tr>';
        } else {
            rows.forEach(function (row) {
                var srcSafe = utils.encodeForAttr(row.source_canonical || '');
                html += '<tr style="cursor:pointer;" onclick="PPP.app.searchCitationSource(decodeURIComponent(\'' + srcSafe + '\'))">' +
                    '<td><strong>' + utils.escapeHtml(row.source_canonical || '') + '</strong></td>' +
                    '<td>' + (parseInt(row.total_citations, 10) || 0) + '</td>' +
                    '<td>' + (parseInt(row.unique_verses, 10) || 0) + '</td>' +
                    '<td>' + (parseInt(row.lecture_count, 10) || 0) + '</td>' +
                    '</tr>';
            });
        }
        html += '</tbody>';
        table.innerHTML = html;
    }

    // ===== "Save to..." popup =====
    var _activePopup = null;

    function closeSaveToPopup() {
        if (_activePopup) {
            _activePopup.remove();
            _activePopup = null;
        }
        document.removeEventListener('click', _onDocClick);
    }

    function _onDocClick(e) {
        if (_activePopup && !_activePopup.contains(e.target)) {
            closeSaveToPopup();
        }
    }

    function showSaveToPopup(nr, anchorEl) {
        closeSaveToPopup();
        var fav = PPP.favorites;
        var cols = fav.getCollections();

        // A brand-new device has no collections, and this popup is the ONLY way
        // a user can reach favorites — so the list came up empty and the only
        // option was "+ New collection", i.e. you had to invent a folder name
        // before you could star anything. The backward-compatible toggle() API
        // has always auto-created 'Favorites' in exactly this case; the UI now
        // matches it. Test "11" passed throughout because it calls that API
        // directly, bypassing the path a real user has to take.
        // (Manual audit 2026-07-26.)
        if (cols.length === 0) {
            fav.createCollection('Favorites');
            cols = fav.getCollections();
        }

        var popup = document.createElement('div');
        popup.className = 'save-to-popup';
        _activePopup = popup;

        // Header
        var header = document.createElement('div');
        header.className = 'save-to-header';
        header.textContent = t('saveTo') || 'Save to...';
        popup.appendChild(header);

        // Collection list
        var list = document.createElement('div');
        list.className = 'save-to-list';

        cols.forEach(function (col) {
            var item = document.createElement('label');
            item.className = 'save-to-item';
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = fav.isInCollection(col.id, nr);
            cb.onchange = function () {
                if (cb.checked) {
                    fav.addToCollection(col.id, nr);
                } else {
                    fav.removeFromCollection(col.id, nr);
                }
                _updateStarState(nr);
                if (PPP.app.updateFavoritesCount) PPP.app.updateFavoritesCount();
            };
            var nameSpan = document.createElement('span');
            nameSpan.className = 'save-to-name';
            nameSpan.textContent = (col.name === 'Favorites') ? (t('favorites') || col.name) : col.name;
            var countSpan = document.createElement('span');
            countSpan.className = 'save-to-count';
            countSpan.textContent = col.count;
            item.appendChild(cb);
            item.appendChild(nameSpan);
            item.appendChild(countSpan);
            list.appendChild(item);
        });

        popup.appendChild(list);

        // "+ New collection" button
        var newBtn = document.createElement('button');
        newBtn.className = 'save-to-new';
        newBtn.innerHTML = '+ ' + (t('newCollection') || 'New collection');
        newBtn.onclick = function (e) {
            e.stopPropagation();
            _showNewCollectionInput(popup, nr);
        };
        popup.appendChild(newBtn);

        // Position popup near the star
        document.body.appendChild(popup);
        var rect = anchorEl.getBoundingClientRect();
        var popupRect = popup.getBoundingClientRect();
        var top = rect.bottom + 4;
        var left = rect.left;
        // Keep within viewport
        if (left + popupRect.width > window.innerWidth - 8) {
            left = window.innerWidth - popupRect.width - 8;
        }
        if (top + popupRect.height > window.innerHeight - 8) {
            top = rect.top - popupRect.height - 4;
        }
        popup.style.top = (top + window.scrollY) + 'px';
        popup.style.left = (left + window.scrollX) + 'px';

        setTimeout(function () {
            document.addEventListener('click', _onDocClick);
        }, 0);
    }

    function _showNewCollectionInput(popup, nr) {
        var existing = popup.querySelector('.save-to-input-row');
        if (existing) return;
        var newBtn = popup.querySelector('.save-to-new');

        var row = document.createElement('div');
        row.className = 'save-to-input-row';
        var input = document.createElement('input');
        input.type = 'text';
        input.className = 'save-to-input';
        input.placeholder = t('collectionName') || 'Collection name';
        input.maxLength = 40;
        var okBtn = document.createElement('button');
        okBtn.className = 'save-to-ok';
        okBtn.textContent = '✓';
        okBtn.onclick = function (e) {
            e.stopPropagation();
            var name = input.value.trim();
            if (!name) return;
            var col = PPP.favorites.createCollection(name);
            PPP.favorites.addToCollection(col.id, nr);
            _updateStarState(nr);
            if (PPP.app.updateFavoritesCount) PPP.app.updateFavoritesCount();
            closeSaveToPopup();
        };
        input.onkeydown = function (e) {
            if (e.key === 'Enter') okBtn.click();
            if (e.key === 'Escape') closeSaveToPopup();
        };
        row.appendChild(input);
        row.appendChild(okBtn);
        popup.insertBefore(row, newBtn);
        input.focus();
    }

    function _updateStarState(nr) {
        var stars = document.querySelectorAll('.fav-star[data-nr="' + nr + '"]');
        var isFav = PPP.favorites.isFavorite(nr);
        stars.forEach(function (s) { s.classList.toggle('active', isFav); });
    }

    // ===== EXTRAS CACHE — language-scoped =====
    // The extras payload carries summary/essence/title for SIX languages
    // (s|e|t × en,lv,ru,es,it,fr). Holding all six resident cost 63.1 MB of a
    // 114.3 MB idle heap while only ONE language is ever read. The cache now
    // keeps the active language only — plus the EN base (`s`/`e`), which
    // getSummary()/getEssence() use as their documented fallback — and a
    // language switch re-reads core:extras from the offline store.
    //
    // Scope note, so this is not later re-sold as something it is not: this is
    // a RESIDENT-memory fix, not a search-peak fix. Measured across a 190 MB
    // live-heap ladder, the search peak is baseline + a constant, and that
    // constant is ~155 MB of NON-JS-heap decode buffers (gunzip output +
    // sql.js wasm memory) that no heap reduction can touch — the peak DELTA
    // slope came out at +0.003 MB per MB of live heap, i.e. zero
    // (bench/gc/results-hypothesis-krishna.txt). What this DOES buy is idle
    // PSS and, 1:1 with it, the ABSOLUTE peak — which is what Android's
    // low-memory killer reads.
    var _extrasCache = null;
    var _extrasLoading = null;
    var _extrasLoadingLang = null;
    var _extrasLang = null;         // language _extrasCache is scoped to
    var _extrasLangPending = null;  // language whose re-scope is in flight
    var _extrasLangFailed = null;   // language whose re-scope failed (no retry loop)

    // ONLY these keys are language-owned. Anything else in an entry is copied
    // through untouched, so a field added upstream can never be silently lost.
    var _EXTRAS_LANG_KEY = /^([set])(lv|ru|es|it|fr)$/;

    function _extrasCurrentLang() {
        return localStorage.getItem('preferredLanguage') || 'en';
    }

    /**
     * Project freshly parsed extras onto ONE language. Values are copied by
     * reference, so the surviving strings are the very same string objects —
     * this allocates ~9 800 small entry objects and lets everything else go.
     */
    function _scopeExtras(data, lang) {
        var out = {};
        if (!data) return out;
        for (var nr in data) {
            var src = data[nr];
            if (!src || typeof src !== 'object') { out[nr] = src; continue; }
            var dst = {};
            for (var k in src) {
                var m = _EXTRAS_LANG_KEY.exec(k);
                if (m && m[2] !== lang) continue;
                dst[k] = src[k];
            }
            out[nr] = dst;
        }
        return out;
    }

    function _loadExtrasNetwork() {
        var versionsP = (window.PPP && PPP.db && PPP.db.getDbVersions)
            ? PPP.db.getDbVersions()
            : Promise.resolve({});
        return versionsP
            .then(function (v) {
                var url = 'data/ppp_lecture_extras.json' +
                    (v && v.extras ? ('?v=' + v.extras) : '');
                return fetch(url);
            })
            .then(function (r) {
                if (!r.ok) throw new Error('extras HTTP ' + r.status);
                return r.json();
            });
    }

    /**
     * Read the FULL extras payload. Offline-first: the installed library keeps
     * extras gzipped in the IndexedDB store (core:extras). Network stays as
     * the fallback for unsupported browsers / not-yet-installed state.
     * Unchanged from before the language scoping — how the data is READ is the
     * same; only how much of it is KEPT changed.
     */
    function _fetchExtrasSource() {
        var offlineP = (window.PPP && PPP.offlineStore && PPP.offlineStore.supported())
            ? PPP.offlineStore.getText('core:extras').catch(function () { return null; })
            : Promise.resolve(null);
        return offlineP.then(function (txt) {
            if (txt) return JSON.parse(txt);
            return _loadExtrasNetwork();
        });
    }

    function loadExtras() {
        var lang = _extrasCurrentLang();
        if (_extrasCache && _extrasLang === lang) return Promise.resolve(_extrasCache);
        if (_extrasLoading && _extrasLoadingLang === lang) return _extrasLoading;
        _extrasLoadingLang = lang;
        _extrasLoading = _fetchExtrasSource()
            .then(function (data) {
                _extrasCache = _scopeExtras(data, lang);
                _extrasLang = lang;
                _extrasLangFailed = null;
                _extrasLoading = null;
                _extrasLoadingLang = null;
                return _extrasCache;
            })
            .catch(function () {
                // Do NOT cache the failure (S95 fix): on a FIRST load
                // _extrasCache stays null so extrasReady() stays false and the
                // next call (app.js scheduled retry, or openSummaryModal on
                // demand) fetches again. On a LANGUAGE SWITCH the previous
                // language's cache survives on purpose — an English fallback
                // line beats a blank one.
                _extrasLoading = null;
                _extrasLoadingLang = null;
                return _extrasCache || {};
            });
        return _extrasLoading;
    }

    /**
     * Re-scope the cache when the active language no longer matches the one it
     * was built for, then hand control back so the caller can re-render.
     *
     * app.js switches language and immediately re-renders through one of the
     * render entry points below, so hooking those keeps the whole mechanism
     * inside ui.js — no new export, no new call site for app.js to forget.
     * `rerender` is optional; the empty-table paths only need the cache warmed
     * for the next search.
     */
    function _syncExtrasLang(rerender) {
        var lang = _extrasCurrentLang();
        if (!_extrasCache) return;              // first load is app.js's job
        if (_extrasLang === lang) return;
        if (_extrasLangPending === lang) return;
        if (_extrasLangFailed === lang) return; // failed once — do not spin
        _extrasLangPending = lang;
        loadExtras().then(function () {
            _extrasLangPending = null;
            if (_extrasLang === lang) {
                if (rerender) rerender();
            } else {
                _extrasLangFailed = lang;
            }
        }, function () {
            _extrasLangPending = null;
            _extrasLangFailed = lang;
        });
    }

    /**
     * Drop the in-memory extras cache (delta update replaced core:extras in
     * the offline store) so the next loadExtras() re-reads fresh data.
     */
    function clearExtrasCache() {
        _extrasCache = null;
        _extrasLoading = null;
        _extrasLoadingLang = null;
        _extrasLang = null;
        _extrasLangPending = null;
        _extrasLangFailed = null;
    }

    function getExtras(nr) {
        if (!_extrasCache || !nr) return null;
        return _extrasCache[String(nr)] || null;
    }

    function hasSummary(nr) {
        var e = getExtras(nr);
        return !!(e && e.s);
    }

    function getEssence(nr) {
        var ex = getExtras(nr);
        if (!ex) return '';
        var lang = localStorage.getItem('preferredLanguage') || 'en';
        if (lang === 'lv' && ex.elv) return ex.elv;
        if (lang === 'ru' && ex.eru) return ex.eru;
        if (lang === 'fr' && ex.efr) return ex.efr;
        if (lang === 'es' && ex.ees) return ex.ees;
        if (lang === 'it' && ex.eit) return ex.eit;
        return ex.e || '';
    }

    function getTitleTranslation(nr, lang) {
        var ex = getExtras(nr);
        if (!ex || !lang || lang === 'en') return '';
        return ex['t' + lang] || '';
    }

    function getSummary(nr, lang) {
        var ex = getExtras(nr);
        if (!ex) return '';
        if (lang && lang !== 'en') {
            var key = 's' + lang;
            if (ex[key]) return ex[key];
        }
        return ex.s || '';
    }

    // NOTE (S94 perf fix): extras are NO LONGER pre-loaded at module load.
    // app.js starts loadExtras() in the background AFTER the meta DB is ready,
    // so the large extras JSON does not compete with meta.db for bandwidth.

    function openSummaryModal(title, lectureNr) {
        var overlay = document.getElementById('summaryModalOverlay');
        var titleEl = document.getElementById('summaryModalTitle');
        var bodyEl = document.getElementById('summaryModalBody');
        if (!overlay) return;
        titleEl.textContent = title;
        bodyEl.textContent = '…';
        overlay.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        loadExtras().then(function () {
            var lang = localStorage.getItem('preferredLanguage') || 'en';
            var summaryText = getSummary(lectureNr, lang);
            bodyEl.textContent = summaryText || '(nav kopsavilkuma)';
        }).catch(function () {
            bodyEl.textContent = '(kļūda ielādējot kopsavilkumu)';
        });
    }

    // ===== TOASTS & UPDATE NOTES =====

    var _toastTimer = null;

    /**
     * Small transient message, bottom center. Reuses the .copy-toast styling.
     */
    function toast(text) {
        var el = document.getElementById('uiToast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'uiToast';
            el.className = 'copy-toast';
            document.body.appendChild(el);
        }
        el.textContent = text;
        el.classList.add('show');
        if (_toastTimer) clearTimeout(_toastTimer);
        _toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3000);
    }

    /**
     * Discreet one-line note (delta update summary) styled like the
     * extrasLoadingInfo indicator; auto-hides after 6 s.
     */
    function showUpdateNote(text) {
        var el = document.getElementById('updateNoteInfo');
        if (!el) {
            var info = document.getElementById('resultsInfo');
            if (!info || !info.parentNode) return;
            el = document.createElement('div');
            el.id = 'updateNoteInfo';
            el.style.cssText = 'font-size:0.8em;color:#888;margin-top:4px;';
            info.parentNode.insertBefore(el, info.nextSibling);
        }
        el.textContent = text;
        el.style.display = 'block';
        setTimeout(function () { el.style.display = 'none'; }, 6000);
    }

    function closeSummaryModal(e) {
        var overlay = document.getElementById('summaryModalOverlay');
        if (!overlay) return;
        if (e && e.target !== overlay) return;
        overlay.style.display = 'none';
        document.body.style.overflow = '';
    }

    return {
        renderResults: renderResults,
        renderSentenceResults: renderSentenceResults,
        renderEmptySentenceTable: renderEmptySentenceTable,
        renderCitationResults: renderCitationResults,
        renderCitationStats: renderCitationStats,
        renderPagination: renderPagination,
        renderEmptyTable: renderEmptyTable,
        renderTopics: renderTopics,
        renderStats: renderStats,
        highlightSearchTerms: highlightSearchTerms,
        highlightSentencePrefix: highlightSentencePrefix,
        getSnippet: getSnippet,
        showLoading: showLoading,
        hideLoading: hideLoading,
        setLoadingText: setLoadingText,
        updateProgress: updateProgress,
        loadExtras: loadExtras,
        extrasReady: extrasReady,
        clearExtrasCache: clearExtrasCache,
        // Build marker for the memory bench's mode echo: a run that expects the
        // language-scoped cache fails loudly if it is served a pre-fix copy.
        // Deliberately NOT a data door — tests read the cache through
        // loadExtras(), the same path the app uses.
        __extrasScopeVersion: 'lang-scope-1',
        toast: toast,
        showUpdateNote: showUpdateNote,
        getColumnHeader: getColumnHeader,
        columnHeaders: columnHeaders,
        loadTotalScriptCounts: loadTotalScriptCounts,
        openSummaryModal: openSummaryModal,
        closeSummaryModal: closeSummaryModal
    };
})();
