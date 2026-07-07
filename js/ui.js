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
     * Build the multi-row table header (same structure as original).
     */
    function buildHeader(thead, totalCount) {
        var row0 = thead.insertRow();
        // Extra spacer for star + share columns
        var starSpacer = document.createElement('th');
        starSpacer.colSpan = 2;
        starSpacer.style.border = 'none';
        starSpacer.style.backgroundColor = 'transparent';
        row0.appendChild(starSpacer);
        for (var i = 0; i < 11; i++) {
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

        for (var idx = 0; idx < columnHeaders.length; idx++) {
            var h = columnHeaders[idx];
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

                var btnWrap = document.createElement('div');
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

                btnWrap.appendChild(bdBtn);
                btnWrap.appendChild(btBtn);
                btnWrap.appendChild(nBtn);
                comboContainer.appendChild(btnWrap);

                row1.appendChild(thBlock);
                ['EN', 'LV', 'RU'].forEach(function (lang) {
                    var thL = document.createElement('th');
                    thL.textContent = lang;
                    thL.className = 'transcript-lang';
                    thL.onclick = function () {
                        if (PPP.app && PPP.app.applyHasFilter) PPP.app.applyHasFilter('Script_' + lang);
                    };
                    row3.appendChild(thL);
                });
                idx += 2; // skip Script_LV and Script_RU
                continue;
            }
            if (h === 'Script_LV' || h === 'Script_RU') continue;
            var th2 = document.createElement('th');
            th2.textContent = getColumnHeader(h);
            th2.rowSpan = 3;
            row1.appendChild(th2);
        }
    }

    /**
     * Render results table rows.
     */
    function renderResults(rows, searchTermStr, startIndex, endIndex, matchHints) {
        var table = document.getElementById('resultsTable');
        table.innerHTML = '';
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
        buildHeader(thead, origCount);
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
            var row = rows[i];
            var tr = tbody.insertRow();

            // Star / favorite cell
            var starTd = tr.insertCell();
            starTd.className = 'fav-cell';
            var nr = (row['Nr.'] || '').toString().trim();
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

            for (var ci = 0; ci < columnHeaders.length; ci++) {
                var col = columnHeaders[ci];
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
                            cellTrim = cellTrim;
                            var isDuplicate = !!DUP_LABELS[cellTrim];
                            var isRaw = (cellTrim === 'Raw');
                            var langLabel = isDuplicate ? cellTrim : (isRaw ? 'Raw' : defaultLangLabel);
                            var lectNr = (row['Nr.'] || '').toString().trim();
                            var viewBtn = document.createElement('a');
                            viewBtn.href = '#';
                            viewBtn.textContent = langLabel;
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
                            viewBtn.setAttribute('data-nr', lectNr);
                            viewBtn.setAttribute('data-lang', langCode);
                            viewBtn.setAttribute('data-drive-url', scriptDriveUrl || '');
                            viewBtn.onclick = function (e) {
                                e.preventDefault();
                                var el = e.currentTarget;
                                var nr = el.getAttribute('data-nr');
                                var lang = el.getAttribute('data-lang');
                                var dUrl = el.getAttribute('data-drive-url') || undefined;
                                if (nr) {
                                    PPP.app.openHtmlTranscriptViewer(nr, lang, null, null, dUrl);
                                } else if (dUrl) {
                                    window.open(dUrl, '_blank');
                                }
                            };
                            td.appendChild(viewBtn);
                            } // end else (not-relevant check)
                        }
                    } else {
                        // Links and Dwnld. columns — keep existing behavior (external links)
                        var url = row[col + '_url'] || utils.extractUrl(val);
                        if (!url && col === 'Links') url = row['Direct URL_url'] || (row['Direct URL'] || '').toString().trim() || null;
                        if (url && !url.startsWith('http')) url = null;
                        var label = col === 'Dwnld.' ? 'Mp3' : (val || 'Link');
                        if (url) {
                            var a = document.createElement('a');
                            a.href = url;
                            a.textContent = label;
                            a.target = '_blank';
                            a.rel = 'noopener';
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
                } else {
                    td.innerHTML = highlightSearchTerms(val, searchTerms);
                }
            }
        }
    }

    /**
     * Render transcript search results with snippets.
     */
    function renderTranscriptResults(rows, searchTermStr) {
        var container = document.getElementById('resultsTable');
        container.innerHTML = '';

        if (rows.length === 0) {
            container.innerHTML = '<div class="empty-result-message">' + t('noTranscriptResults') + '</div>';
            return;
        }

        var searchTerms = searchTermStr ? searchTermStr.split(';').map(function (s) { return s.trim(); }).filter(Boolean) : [];
        var table = document.createElement('table');
        table.id = 'resultsTable';
        table.style.width = '100%';

        var thead = table.createTHead();
        var hr = thead.insertRow();
        ['Date', 'Lecture', 'Snippet'].forEach(function (h) {
            var th = document.createElement('th');
            th.textContent = h;
            hr.appendChild(th);
        });

        var tbody = table.createTBody();
        rows.forEach(function (row) {
            var tr = tbody.insertRow();
            var tdDate = tr.insertCell();
            tdDate.textContent = row.date || row.Date || '';

            var tdName = tr.insertCell();
            var lectureName = row.original_file_name || row['Original file name'] || '';
            var lectureNr = row.nr || row['Nr.'] || '';
            if (lectureNr && hasSummary(lectureNr)) {
                var link = document.createElement('a');
                link.href = '#';
                link.textContent = lectureName;
                link.style.cssText = 'color:inherit;text-decoration:underline;text-decoration-style:dotted;cursor:pointer;';
                link.addEventListener('click', function (e) {
                    e.preventDefault();
                    PPP.ui.openSummaryModal(lectureName, lectureNr);
                });
                tdName.appendChild(link);
            } else {
                tdName.textContent = lectureName;
            }

            var tdSnippet = tr.insertCell();
            var text = row.text_content || row.text || row.content || '';
            var snippet = getSnippet(text, searchTerms, 120);
            tdSnippet.innerHTML = highlightSearchTerms(snippet, searchTerms);
            tdSnippet.style.fontSize = '12px';
            tdSnippet.style.lineHeight = '1.5';
        });

        container.parentNode.replaceChild(table, container);
        table.id = 'resultsTable';
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
        var table = document.getElementById('resultsTable');
        table.innerHTML = '';
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

    var _extrasCache = null;
    var _extrasLoading = null;

    function loadExtras() {
        if (_extrasCache) return Promise.resolve(_extrasCache);
        if (_extrasLoading) return _extrasLoading;
        var versionsP = (window.PPP && PPP.db && PPP.db.getDbVersions)
            ? PPP.db.getDbVersions()
            : Promise.resolve({});
        _extrasLoading = versionsP
            .then(function (v) {
                var url = 'data/ppp_lecture_extras.json' +
                    (v && v.extras ? ('?v=' + v.extras) : '');
                return fetch(url);
            })
            .then(function (r) { return r.ok ? r.json() : {}; })
            .then(function (data) {
                _extrasCache = data || {};
                _extrasLoading = null;
                return _extrasCache;
            })
            .catch(function () {
                _extrasCache = {};
                _extrasLoading = null;
                return _extrasCache;
            });
        return _extrasLoading;
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

    function closeSummaryModal(e) {
        var overlay = document.getElementById('summaryModalOverlay');
        if (!overlay) return;
        if (e && e.target !== overlay) return;
        overlay.style.display = 'none';
        document.body.style.overflow = '';
    }

    return {
        renderResults: renderResults,
        renderTranscriptResults: renderTranscriptResults,
        renderCitationResults: renderCitationResults,
        renderCitationStats: renderCitationStats,
        renderPagination: renderPagination,
        renderEmptyTable: renderEmptyTable,
        renderTopics: renderTopics,
        renderStats: renderStats,
        highlightSearchTerms: highlightSearchTerms,
        getSnippet: getSnippet,
        showLoading: showLoading,
        hideLoading: hideLoading,
        setLoadingText: setLoadingText,
        updateProgress: updateProgress,
        loadExtras: loadExtras,
        extrasReady: extrasReady,
        getColumnHeader: getColumnHeader,
        columnHeaders: columnHeaders,
        openSummaryModal: openSummaryModal,
        closeSummaryModal: closeSummaryModal
    };
})();
