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
    function buildHeader(thead) {
        var row0 = thead.insertRow();
        for (var i = 0; i < 5; i++) {
            var c = document.createElement('th');
            c.style.border = 'none';
            c.style.backgroundColor = 'transparent';
            row0.appendChild(c);
        }

        var ltCell = document.createElement('th');
        ltCell.colSpan = 3; ltCell.style.textAlign = 'center'; ltCell.style.border = 'none';
        ltCell.style.backgroundColor = 'transparent'; ltCell.style.paddingBottom = '5px';
        var ltBtn = document.createElement('button');
        ltBtn.setAttribute('data-i18n', 'latest20Transcripts');
        ltBtn.textContent = t('latest20Transcripts');
        ltBtn.style.cssText = 'background:linear-gradient(135deg,#e8842c,#f4a54b);color:#fff;border:none;padding:6px 10px;cursor:pointer;font-weight:700;border-radius:20px;font-size:11px;width:100%;box-sizing:border-box;transition:all 0.2s;letter-spacing:0.2px;';
        ltBtn.onclick = function () { if (PPP.app && PPP.app.showLatestTranscripts) PPP.app.showLatestTranscripts(); };
        ltCell.appendChild(ltBtn);
        row0.appendChild(ltCell);

        var tCell = document.createElement('th');
        tCell.colSpan = 3; tCell.style.textAlign = 'center'; tCell.style.border = 'none';
        tCell.style.backgroundColor = 'transparent'; tCell.style.paddingBottom = '5px';
        tCell.style.position = 'relative';
        var tBtn = document.createElement('button');
        tBtn.setAttribute('data-i18n', 'lectureTopics');
        tBtn.textContent = t('lectureTopics');
        tBtn.style.cssText = 'background:linear-gradient(135deg,#1a3a6b,#2a4f8a);color:#fff;border:none;padding:6px 10px;cursor:pointer;font-weight:700;border-radius:20px;font-size:11px;width:100%;box-sizing:border-box;transition:all 0.2s;letter-spacing:0.2px;';
        tBtn.onclick = function () { if (PPP.app && PPP.app.showTopics) PPP.app.showTopics(); };
        tCell.appendChild(tBtn);
        row0.appendChild(tCell);

        var row1 = thead.insertRow();
        var row2 = thead.insertRow();
        var row3 = thead.insertRow();

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
                thBlock.innerHTML = '<div class="transcripts-title">' + t('transcriptsTitle') + '</div>' +
                    '<div class="transcripts-hintline"><span class="click-word">' + t('clickWord') + '</span> ' + t('transcriptsHint') + '</div>';
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
        buildHeader(thead);
        var tbody = table.createTBody();

        if (rows.length === 0) {
            var r = tbody.insertRow();
            var c = r.insertCell();
            c.colSpan = columnHeaders.length;
            c.className = 'empty-result-message';
            c.textContent = t('noResultsFound');
            return;
        }

        var searchTerms = searchTermStr ? searchTermStr.split(';') : [];

        for (var i = startIndex; i < endIndex && i < rows.length; i++) {
            var row = rows[i];
            var tr = tbody.insertRow();
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
                            var langLabel = col.split('_')[1];
                            var langCode = langLabel.toLowerCase();
                            var viewBtn = document.createElement('a');
                            viewBtn.href = '#';
                            viewBtn.textContent = langLabel;
                            viewBtn.title = 'Open transcript at [' + row._blockIndex + ']';
                            viewBtn.style.cssText = 'color:var(--saffron);font-weight:700;text-decoration:underline;cursor:pointer;';
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
                        }
                    } else {
                        var url = row[col + '_url'] || utils.extractUrl(val);
                        if (!url && col === 'Links') url = row['Direct URL_url'] || (row['Direct URL'] || '').toString().trim() || null;
                        if (url && !url.startsWith('http')) url = null;
                        var label = col.startsWith('Script_') ? col.split('_')[1] : (col === 'Dwnld.' ? 'Mp3' : (val || 'Link'));
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
                } else {
                    td.innerHTML = highlightSearchTerms(val, searchTerms);
                    // Add hidden column match hint
                    if (col === 'Original file name' && matchHints) {
                        var hints = matchHints.get(row);
                        if (hints && hints.length > 0) {
                            var span = document.createElement('span');
                            span.className = 'match-hint';
                            span.textContent = hints.join('; ');
                            td.appendChild(span);
                        }
                    }
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
            tdName.textContent = row.original_file_name || row['Original file name'] || '';

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
        c.colSpan = columnHeaders.length;
        c.className = 'empty-result-message';
        c.textContent = t('enterSearchTerms');
    }

    /**
     * Render topics/playlists dropdown.
     */
    function renderTopics(DB, container) {
        var counts = {};
        DB.forEach(function (r) {
            if (!utils.cellHasLink(r['Script_EN'], 'Script_EN', r)) return;
            var s = (r['Subject'] || '').trim();
            if (s) counts[s] = (counts[s] || 0) + 1;
        });

        var html = '<div id="topicsListTitle">' + t('topics') + '</div><div id="topicsListContent">';
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
     * Render concept search results (themes/summaries with lecture info).
     */
    function renderConceptResults(rows, searchTermStr) {
        var table = document.getElementById('resultsTable');
        var searchTerms = searchTermStr ? searchTermStr.split(';').map(function (s) { return s.trim(); }).filter(Boolean) : [];

        var html = '<thead><tr>' +
            '<th>Date</th>' +
            '<th>Lecture</th>' +
            '<th>Excerpt</th>' +
            '<th>Links</th>' +
            '</tr></thead><tbody>';

        if (!rows || rows.length === 0) {
            html += '<tr><td colspan="4" class="empty-result-message">' + t('noConceptResults') + '</td></tr>';
        } else {
            rows.forEach(function (row, rowIdx) {
                var date = utils.escapeHtml(row.date || '');
                var lectureName = row.original_file_name || ('Nr.' + row.lecture_nr);
                var lectureHighlighted = highlightSearchTerms(lectureName, searchTerms);

                // Show original transcript text, truncated to ~300 chars
                var fullText = row.text || row.concept_summary || '';
                var truncated = fullText.length > 300;
                var displayText = truncated ? fullText.substring(0, 300) + '...' : fullText;
                var textHighlighted = highlightSearchTerms(displayText, searchTerms);

                // "Show more" toggle for long text
                var textCellHtml = '<span class="concept-text-short" id="concept-short-' + rowIdx + '">' + textHighlighted + '</span>';
                if (truncated) {
                    textCellHtml += '<span class="concept-text-full" id="concept-full-' + rowIdx + '" style="display:none;">' +
                        highlightSearchTerms(fullText, searchTerms) + '</span>';
                    textCellHtml += ' <a href="#" class="concept-toggle" onclick="' +
                        'var s=document.getElementById(\'concept-short-' + rowIdx + '\');' +
                        'var f=document.getElementById(\'concept-full-' + rowIdx + '\');' +
                        'if(f.style.display===\'none\'){f.style.display=\'inline\';s.style.display=\'none\';this.textContent=\'less\';}' +
                        'else{f.style.display=\'none\';s.style.display=\'inline\';this.textContent=\'more\';}' +
                        'return false;" style="font-size:0.8em;color:var(--saffron);font-weight:700;">more</a>';
                }

                // Build links cell
                var linksHtml = '';
                var linkUrl = row.links_url || utils.extractUrl(row.links || '');
                if (linkUrl && linkUrl.startsWith && linkUrl.startsWith('http')) {
                    linksHtml += '<a href="' + utils.escapeHtml(linkUrl) + '" target="_blank" rel="noopener">Link</a> ';
                }
                if (row.dwnld_url) {
                    linksHtml += '<a href="' + utils.escapeHtml(row.dwnld_url) + '" target="_blank" rel="noopener">Mp3</a> ';
                }
                // Script links
                ['en', 'lv', 'ru'].forEach(function (lang) {
                    var scriptVal = row['script_' + lang] || '';
                    if (scriptVal && scriptVal !== 'N/A' && scriptVal !== '0' && scriptVal !== '') {
                        linksHtml += '<a href="#" onclick="PPP.app.openHtmlTranscriptViewer(\'' +
                            utils.escapeHtml(row.lecture_nr) + '\',\'' + lang + '\',' + (row.block_num || 0) +
                            ');return false;" style="color:var(--saffron);font-weight:700;">' + lang.toUpperCase() + '</a> ';
                    }
                });

                html += '<tr>' +
                    '<td style="white-space:nowrap;">' + date + '</td>' +
                    '<td>' + lectureHighlighted + '</td>' +
                    '<td style="font-size:0.9em;line-height:1.5;font-style:italic;color:#444;">' + textCellHtml + '</td>' +
                    '<td style="white-space:nowrap;">' + linksHtml + '</td>' +
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

    return {
        renderResults: renderResults,
        renderTranscriptResults: renderTranscriptResults,
        renderCitationResults: renderCitationResults,
        renderCitationStats: renderCitationStats,
        renderConceptResults: renderConceptResults,
        renderPagination: renderPagination,
        renderEmptyTable: renderEmptyTable,
        renderTopics: renderTopics,
        renderStats: renderStats,
        highlightSearchTerms: highlightSearchTerms,
        getSnippet: getSnippet,
        showLoading: showLoading,
        hideLoading: hideLoading,
        updateProgress: updateProgress,
        getColumnHeader: getColumnHeader,
        columnHeaders: columnHeaders
    };
})();
