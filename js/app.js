/* ===========================================================================
   PPP Link Finder — Main application controller
   Wires up all modules: db, search, ui, i18n, utils
   Primary data source: SQLite via sql.js
   Fallback: Google Sheets XLSX/CSV
   =========================================================================== */
window.PPP = window.PPP || {};

PPP.app = (function () {
    'use strict';

    var db = PPP.db;
    var search = PPP.search;
    var ui = PPP.ui;
    var i18n = PPP.i18n;
    var utils = PPP.utils;

    // ===== CONSTANTS =====
    var SPREADSHEET_ID = '1O66GTEB2AfBWYEq0sDLusVkJk9gg1XpmZNJmmQkvtls';
    var SHEET_NAME = 'Base';
    var LINK_COLS = new Set(['Dwnld.', 'Links', 'Script_EN', 'Script_LV', 'Script_RU']);

    // Column mapping: SQLite lowercase → UI display names
    var SQL_TO_UI = {
        'nr': 'Nr.', 'original_file_name': 'Original file name', 'date': 'Date',
        'type': 'Type', 'lang': 'Lang.', 'length': 'Length', 'subject': 'Subject',
        'country': 'Country', 'links': 'Links', 'dwnld': 'Dwnld.',
        'direct_url': 'Direct URL', 'script_en': 'Script_EN', 'script_lv': 'Script_LV',
        'script_ru': 'Script_RU',
        'links_url': 'Links_url', 'dwnld_url': 'Dwnld._url',
        'script_en_url': 'Script_EN_url', 'script_lv_url': 'Script_LV_url', 'script_ru_url': 'Script_RU_url',
        'source': 'Source', 'added': 'Added',
        'scripts_added': 'Scripts added', 'subtype': 'Subtype', 'author': 'Author',
        'books': 'Books', 'personality': 'Personality', 'bhajans': 'Bhajans',
        'transcribe': 'Transcribe', 'check_verses': 'Check verses', 'recheck': 'Recheck',
        'quality': 'Quality', 'duplicate': 'Duplicate', 'change_file_name': 'Change file name',
        'lang_added': 'Lang added'
    };

    // ===== ANALYTICS =====
    function track(event, data) {
        if (typeof umami !== 'undefined' && umami.track) {
            umami.track(event, data);
        }
    }

    // ===== STATE =====
    var DB = [];                    // In-memory data (mapped to UI column names)
    var currentPage = 1;
    var pageSize = 10;
    var totalResults = 0;
    var lastSearchTerm = '';
    var allResults = [];
    var matchHints = new Map();
    var dataLoaded = false;
    var usingSqlite = false;        // true if SQLite loaded successfully
    var searchMode = 'metadata';    // 'metadata', 'citations', or 'citationsTop'
    var deferredPrompt = null;
    var installMode = 'ios';
    var totalLectures = (function () {
        try {
            var v = parseInt(localStorage.getItem('ppp_total_lectures') || '0', 10);
            return v > 0 ? v : 0;
        } catch (e) { return 0; }
    })();

    // ===== COMBO DISPLAY HELPERS =====
    var _comboTooltipEl = null;
    var _comboTooltipEnter = null;
    var _comboTooltipLeave = null;

    function _ensureComboTooltipEl() {
        if (_comboTooltipEl) return _comboTooltipEl;
        _comboTooltipEl = document.createElement('div');
        _comboTooltipEl.className = 'combo-display-tooltip';
        _comboTooltipEl.setAttribute('role', 'tooltip');
        document.body.appendChild(_comboTooltipEl);
        return _comboTooltipEl;
    }

    function _positionComboTooltip(si) {
        if (!_comboTooltipEl) return;
        var rect = si.getBoundingClientRect();
        var tipRect = _comboTooltipEl.getBoundingClientRect();
        var top = window.scrollY + rect.bottom + 8;
        var left = window.scrollX + rect.left + (rect.width / 2) - (tipRect.width / 2);
        var minLeft = window.scrollX + 8;
        var maxLeft = window.scrollX + document.documentElement.clientWidth - tipRect.width - 8;
        if (left < minLeft) left = minLeft;
        if (left > maxLeft) left = maxLeft;
        _comboTooltipEl.style.top = top + 'px';
        _comboTooltipEl.style.left = left + 'px';
    }

    function setComboDisplay(label) {
        var si = document.getElementById('searchTerm');
        if (!si) return;
        si.value = label;
        si.disabled = true;
        si.classList.add('combo-display');
        si.removeAttribute('title');

        var tip = _ensureComboTooltipEl();

        if (_comboTooltipEnter) si.removeEventListener('mouseenter', _comboTooltipEnter);
        if (_comboTooltipLeave) si.removeEventListener('mouseleave', _comboTooltipLeave);

        _comboTooltipEnter = function () {
            // Read translation on each show — picks up the active language
            tip.textContent = i18n.t('comboDisplayTooltip');
            tip.classList.add('visible');
            _positionComboTooltip(si);
        };
        _comboTooltipLeave = function () {
            tip.classList.remove('visible');
        };
        si.addEventListener('mouseenter', _comboTooltipEnter);
        si.addEventListener('mouseleave', _comboTooltipLeave);
    }
    function clearComboDisplay() {
        var si = document.getElementById('searchTerm');
        if (!si) return;
        si.value = '';
        si.disabled = false;
        si.classList.remove('combo-display');
        si.removeAttribute('title');
        if (_comboTooltipEnter) {
            si.removeEventListener('mouseenter', _comboTooltipEnter);
            _comboTooltipEnter = null;
        }
        if (_comboTooltipLeave) {
            si.removeEventListener('mouseleave', _comboTooltipLeave);
            _comboTooltipLeave = null;
        }
        if (_comboTooltipEl) _comboTooltipEl.classList.remove('visible');
    }

    // ===== PANEL HELPERS =====
    function closeAllPanels() {
        var ids = ['recommendationsList', 'topicsList', 'verseSourcesList', 'verseList', 'topCitationsList'];
        ids.forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        // Re-show results table (Top 108 and similar may have hidden it)
        var rt = document.getElementById('resultsTable');
        if (rt) rt.style.display = '';
    }

    // ===== PWA =====
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(function () {});
    }

    window.addEventListener('beforeinstallprompt', function (e) {
        e.preventDefault();
        deferredPrompt = e;
        showInstallBanner('native');
    });

    // ===== INIT =====
    function initTheme() {
        var saved = localStorage.getItem('ppp_theme');
        var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        var isDark = saved === 'dark' || (!saved && prefersDark);
        if (isDark) document.body.classList.add('dark');
        var btn = document.getElementById('themeToggle');
        if (btn) btn.textContent = isDark ? '☀️' : '🌙';
    }

    function toggleTheme() {
        var isDark = document.body.classList.toggle('dark');
        localStorage.setItem('ppp_theme', isDark ? 'dark' : 'light');
        var btn = document.getElementById('themeToggle');
        if (btn) btn.textContent = isDark ? '☀️' : '🌙';
    }

    function init() {
        initTheme();

        var savedLang = localStorage.getItem('preferredLanguage') || 'en';
        setLanguage(savedLang);

        // Close List of Sources dropdown on any other button click
        document.addEventListener('click', function (e) {
            var sourcesList = document.getElementById('sourcesList');
            if (!sourcesList || sourcesList.style.display === 'none' || sourcesList.style.display === '') return;
            var btn = e.target.closest('button');
            if (!btn) return;
            if (btn.closest('.top-left-buttons')) return;
            if (sourcesList.contains(btn)) return;
            sourcesList.style.display = 'none';
        }, true);

        // Wire search input
        var searchInput = document.getElementById('searchTerm');
        searchInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') doSearch();
        });

        // Escape closes open modals (same close paths as the × buttons)
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            var tOverlay = document.getElementById('transcriptModalOverlay');
            if (tOverlay && tOverlay.classList.contains('active')) {
                closeTranscriptModal();
                return;
            }
            var hOverlay = document.getElementById('helpModalOverlay');
            if (hOverlay && hOverlay.classList.contains('active')) {
                closeHelpModal();
            }
        });

        // Ensure metadata mode is active on start
        setSearchMode('metadata');

        // Wire search mode toggle
        var modeButtons = document.querySelectorAll('.search-mode-btn');
        modeButtons.forEach(function (btn) {
            btn.addEventListener('click', function () {
                var mode = btn.getAttribute('data-mode');
                setSearchMode(mode);
                // Auto-show verse sources panel when switching to Verses
                if (mode === 'citations') {
                    showVerseSources();
                }
            });
        });

        // Load data — try SQLite first, fall back to XLSX/CSV
        loadData();

        // Install banner (delayed) — skip in automated browsers (Playwright tests etc.)
        setTimeout(function () {
            if (navigator.webdriver) return;
            var isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
            var dismissed = localStorage.getItem('installDismissed');
            var banner = document.getElementById('installBanner');
            if (deferredPrompt || (banner && banner.style.display === 'block') || isStandalone || dismissed) return;
            var isAndroid = /android/i.test(navigator.userAgent);
            showInstallBanner(isAndroid ? 'android' : 'ios');
        }, 2000);

        initMobileSwipeHint();
    }

    function initMobileSwipeHint() {
        var isPortrait = window.matchMedia('(max-width: 640px) and (orientation: portrait)').matches;
        if (!isPortrait) return;

        var hint = document.getElementById('swipeHintMobile');
        if (!hint) return;
        hint.style.display = '';
        hint.classList.remove('hiding');
        hint.classList.add('active');

        var container = document.querySelector('.results-container');
        var dismissed = false;

        // Position the hint vertically so it overlays the
        // "Enter search terms to see results" empty-state message.
        function positionHint() {
            var target = document.querySelector('.empty-result-message');
            var rect;
            if (target && target.offsetHeight > 0) {
                rect = target.getBoundingClientRect();
                var top = rect.top + (rect.height / 2) - (hint.offsetHeight / 2);
                var minTop = 20;
                var maxTop = window.innerHeight - hint.offsetHeight - 20;
                if (top < minTop) top = minTop;
                if (top > maxTop) top = maxTop;
                hint.style.top = top + 'px';
            } else if (container) {
                // Fallback: 30px below the top of the results container
                rect = container.getBoundingClientRect();
                hint.style.top = (rect.top + 30) + 'px';
            }
        }
        // Run now and also after a short delay in case layout is still settling
        positionHint();
        setTimeout(positionHint, 100);
        window.addEventListener('resize', positionHint);

        function dismiss() {
            if (dismissed) return;
            dismissed = true;
            window.removeEventListener('resize', positionHint);
            hint.classList.remove('active');
            hint.classList.add('hiding');
            setTimeout(function () {
                hint.classList.remove('hiding');
                hint.style.display = 'none';
            }, 400);
            if (container) container.removeEventListener('scroll', onScroll);
            document.removeEventListener('click', onInteraction, true);
            document.removeEventListener('touchstart', onInteraction, true);
            document.removeEventListener('keydown', onInteraction, true);
        }

        function onScroll() {
            if (container && container.scrollLeft > 30) dismiss();
        }

        function onInteraction() {
            dismiss();
        }

        if (container) container.addEventListener('scroll', onScroll, { passive: true });
        document.addEventListener('click', onInteraction, true);
        document.addEventListener('touchstart', onInteraction, true);
        document.addEventListener('keydown', onInteraction, true);

        setTimeout(function () {
            if (!dismissed) dismiss();
        }, 10000);
    }

    // ===== DATA LOADING =====

    /**
     * Map a SQLite row object (lowercase keys) to UI row object (display keys).
     */
    function mapSqlRowToUI(sqlRow) {
        var uiRow = {};
        for (var sqlCol in sqlRow) {
            if (sqlRow.hasOwnProperty(sqlCol)) {
                var uiCol = SQL_TO_UI[sqlCol] || sqlCol;
                uiRow[uiCol] = (sqlRow[sqlCol] != null) ? sqlRow[sqlCol].toString() : '';
            }
        }
        return uiRow;
    }

    /**
     * Primary load: SQLite via sql.js.
     * Fallback: XLSX from Google Sheets.
     */
    function loadData() {
        // Show progress bar
        ui.showLoading(i18n.t('loadingDB'));

        loadSqlite().then(function () {
            // App is USABLE as soon as the meta DB is ready — do not block
            // readiness on the large extras JSON (S94 perf fix).
            ui.hideLoading();
            usingSqlite = true;
            onDataLoaded();

            // Load extras (essence/summary/title translations) in the
            // background AFTER the app is ready; refresh visible results
            // when done so essence/summary data appears.
            if (ui.loadExtras) {
                ui.loadExtras().then(function () {
                    if (allResults.length > 0) displayResults();
                }).catch(function () { /* extras are optional */ });
            }
        }).catch(function (sqliteErr) {
            console.warn('SQLite load failed, falling back to XLSX:', sqliteErr);
            ui.hideLoading();
            loadXlsxFallback();
        });
    }

    /**
     * Load SQLite database via sql.js.
     */
    function loadSqlite() {
        var openingShown = false;
        return db.initSqlJs().then(function () {
            return db.loadMetaDB(function (progress) {
                ui.updateProgress(progress);
                // Download complete — the silent part (opening the DB and
                // running the initial SELECT) starts now. Tell the user.
                if (progress >= 0.999 && !openingShown) {
                    openingShown = true;
                    ui.setLoadingText(i18n.t('openingDB'));
                }
            });
        }).then(function () {
            if (!openingShown) {
                openingShown = true;
                ui.setLoadingText(i18n.t('openingDB'));
            }
        }).then(function () {
            return db.getStatsAsync();
        }).then(function (stats) {
            totalLectures = parseInt(stats.total_lectures || '0', 10);
            try { if (totalLectures > 0) localStorage.setItem('ppp_total_lectures', String(totalLectures)); } catch (e) {}

            // Also populate DB[] array for backward-compatible features
            return db.queryMetaAsync('SELECT * FROM lectures');
        }).then(function (allRows) {
            DB = allRows.map(mapSqlRowToUI);
            return db.queryMetaAsync("SELECT value AS last_update FROM stats WHERE key = 'db_updated'");
        }).then(function (dateRows) {
            if (dateRows && dateRows.length && dateRows[0].last_update) {
                var d = dateRows[0].last_update.replace(/\./g, '-');
                var el = document.getElementById('dbLastUpdate');
                if (el) {
                    el.setAttribute('data-last-update', d);
                    el.textContent = (i18n.t('lastUpdate') || 'Last update') + ': ' + d;
                    el.style.display = '';
                }
            }
        });
    }

    /**
     * XLSX fallback (original logic).
     */
    function loadXlsxFallback() {
        var xlsxUrl = 'https://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID + '/export?format=xlsx&gid=0';

        getCachedData().then(function (cached) {
            if (cached && (Date.now() - cached.timestamp < 5 * 60 * 1000)) {
                DB = cached.rows;
                totalLectures = DB.length;
                onDataLoaded();
                return;
            }
            return fetch(xlsxUrl).then(function (response) {
                return response.arrayBuffer();
            }).then(function (arrayBuffer) {
                var wb = XLSX.read(arrayBuffer, { type: 'array' });
                var rows = parseXlsxData(wb);
                DB = rows;
                totalLectures = DB.length;
                cacheData(rows);
                onDataLoaded();
            });
        }).catch(function (e) {
            console.error('XLSX load failed, trying CSV fallback:', e);
            var csvUrl = 'https://docs.google.com/spreadsheets/d/' + SPREADSHEET_ID + '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(SHEET_NAME);
            return new Promise(function (resolve, reject) {
                Papa.parse(csvUrl, { download: true, header: true, skipEmptyLines: true, complete: function (r) { resolve(r.data); }, error: reject });
            }).then(function (rows) {
                DB = rows;
                totalLectures = DB.length;
                cacheData(rows);
                onDataLoaded();
            }).catch(function (e2) {
                console.error('CSV fallback also failed:', e2);
                getCachedData().then(function (cached) {
                    if (cached) { DB = cached.rows; totalLectures = DB.length; onDataLoaded(); }
                });
            });
        });
    }

    // XLSX parser (preserves HYPERLINK formulas with URLs)
    function parseXlsxData(wb) {
        var ws = wb.Sheets[SHEET_NAME] || wb.Sheets[wb.SheetNames[0]];
        var range = XLSX.utils.decode_range(ws['!ref']);
        var headers = [];
        for (var c = range.s.c; c <= range.e.c; c++) {
            var cell = ws[XLSX.utils.encode_cell({ r: 0, c: c })];
            headers.push(cell ? cell.v.toString() : '');
        }
        var rows = [];
        for (var r = 1; r <= range.e.r; r++) {
            var row = {};
            var hasData = false;
            for (var ci = 0; ci < headers.length; ci++) {
                var h = headers[ci];
                var cell2 = ws[XLSX.utils.encode_cell({ r: r, c: ci })];
                if (!cell2) { row[h] = ''; continue; }
                hasData = true;
                row[h] = (cell2.v != null) ? cell2.v.toString() : '';
                if (LINK_COLS.has(h) || h === 'Direct URL') {
                    var url = null;
                    if (cell2.f) {
                        var m = cell2.f.match(/HYPERLINK\("([^"]+)"/i);
                        if (m) url = m[1];
                    }
                    if (!url && cell2.l && cell2.l.Target) url = cell2.l.Target;
                    if (url) row[h + '_url'] = url;
                }
            }
            if (hasData) rows.push(row);
        }
        return rows;
    }

    function onDataLoaded() {
        dataLoaded = true;
        var input = document.getElementById('searchTerm');
        input.disabled = false;
        var count = totalLectures || DB.length;
        input.placeholder = i18n.t('searchPlaceholder').replace('{count}', count.toLocaleString());
        ui.renderEmptyTable();
        updateFavoritesCount();
        handleDeepLink();
    }

    // ===== Deep Link: #nr=XXX =====
    function parseHash() {
        var hash = window.location.hash.replace(/^#/, '');
        if (!hash) return null;
        var params = {};
        hash.split('&').forEach(function (part) {
            var kv = part.split('=');
            if (kv.length === 2) params[kv[0]] = decodeURIComponent(kv[1]);
        });
        return params;
    }

    // Pending highlight text from deep link — consumed by openHtmlTranscriptViewer
    var _pendingHighlight = null;

    function handleDeepLink() {
        var params = parseHash();
        if (!params || !params.nr) return;
        var nr = params.nr.trim();
        var hl = params.hl || null;
        var hll = params.hll ? parseInt(params.hll, 10) : 0;
        var lang = params.lang || 'en';

        // Show the lecture in results
        function showLecture(uiRows) {
            lastSearchTerm = 'Nr. ' + nr;
            allResults = uiRows;
            totalResults = uiRows.length;
            currentPage = 1;
            matchHints = new Map();
            document.getElementById('searchTerm').value = 'Nr. ' + nr;
            document.getElementById('timer').textContent = '';
            displayResults();

            // If highlight parameter present — open transcript and scroll to text
            if (hl) {
                _pendingHighlight = { start: hl, len: hll || hl.length };
                openHtmlTranscriptViewer(nr, lang);
            }
        }

        if (usingSqlite) {
            db.queryMetaAsync(
                'SELECT * FROM lectures WHERE nr = ? LIMIT 1', [nr]
            ).then(function (rows) {
                if (rows.length === 0) return;
                showLecture(rows.map(mapSqlRowToUI));
            });
        } else {
            var found = DB.filter(function (r) {
                return (r['Nr.'] || '').toString().trim() === nr;
            });
            if (found.length === 0) return;
            showLecture(found);
        }
    }

    function buildShareUrl(nr, highlightText, lang) {
        var base = window.location.href.split('#')[0].replace(/index\.html$/, '');
        var hash = '#nr=' + encodeURIComponent(nr);
        if (lang && lang !== 'en') hash += '&lang=' + lang;
        if (highlightText) {
            var clean = highlightText.replace(/\s+/g, ' ').trim();
            hash += '&hl=' + encodeURIComponent(clean.substring(0, 20));
            hash += '&hll=' + clean.length;
        }
        return base + hash;
    }

    function copyShareLink(nr, title, subject) {
        var url = buildShareUrl(nr);
        // Build rich text: title + subject + URL
        var lines = [];
        if (title) lines.push(title);
        if (subject) {
            // Clean subject: remove leading dot, trim
            var subj = subject.replace(/^\./, '').trim();
            if (subj) lines.push(subj);
        }
        lines.push(url);
        var text = lines.join('\n');

        function fallbackCopy() {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            showCopyToast();
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                showCopyToast();
            }).catch(function () {
                fallbackCopy();
            });
        } else {
            fallbackCopy();
        }
    }

    function showCopyToast() {
        var toast = document.getElementById('copyToast');
        if (toast) toast.remove(); // re-create in correct parent

        toast = document.createElement('div');
        toast.id = 'copyToast';
        toast.className = 'copy-toast';

        // If transcript modal is open, put toast inside it so it's visible above overlay
        var overlay = document.getElementById('transcriptModalOverlay');
        if (overlay && overlay.classList.contains('active')) {
            var modal = overlay.querySelector('.transcript-modal');
            if (modal) {
                toast.style.position = 'absolute';
                toast.style.bottom = '20px';
                toast.style.left = '50%';
                toast.style.transform = 'translateX(-50%)';
                modal.style.position = 'relative';
                modal.appendChild(toast);
            } else {
                document.body.appendChild(toast);
            }
        } else {
            document.body.appendChild(toast);
        }

        toast.textContent = i18n.t('linkCopied') || 'Link copied!';
        toast.classList.add('show');
        setTimeout(function () { toast.classList.remove('show'); }, 2500);
    }

    // ===== IndexedDB Cache (for XLSX fallback) =====
    function openCacheDB() {
        return new Promise(function (resolve, reject) {
            var req = indexedDB.open('CA_LinkFinder', 1);
            req.onupgradeneeded = function (e) { e.target.result.createObjectStore('cache'); };
            req.onsuccess = function (e) { resolve(e.target.result); };
            req.onerror = function () { reject(req.error); };
        });
    }

    function getCachedData() {
        return openCacheDB().then(function (idb) {
            return new Promise(function (resolve) {
                var tx = idb.transaction('cache', 'readonly');
                var req = tx.objectStore('cache').get('sheets');
                req.onsuccess = function () { resolve(req.result || null); };
                req.onerror = function () { resolve(null); };
            });
        }).catch(function () { return null; });
    }

    function cacheData(rows) {
        openCacheDB().then(function (idb) {
            var tx = idb.transaction('cache', 'readwrite');
            tx.objectStore('cache').put({ timestamp: Date.now(), rows: rows }, 'sheets');
        }).catch(function (e) { console.warn('Cache fail:', e); });
    }

    // ===== SEARCH =====
    function doSearch() {
        var term = document.getElementById('searchTerm').value.trim();
        if (!dataLoaded) return;
        // Allow empty search in citations mode (shows stats overview)
        if (!term && searchMode !== 'citations' && searchMode !== 'citationsTop') return;
        setActiveCollection(null);
        lastSearchTerm = term;
        currentPage = 1;
        performSearch();
    }

    function performSearch() {
        var startTime = performance.now();
        // Clear verse position data on new search
        activeVersePositions = {};
        activeVerseReference = '';

        if (searchMode === 'citationsTop') {
            showTopCitations();
            return;
        }

        if (searchMode === 'citations') {
            performCitationSearch(startTime);
            return;
        }

        if (usingSqlite) {
            performSqliteSearch(startTime);
        } else {
            performInMemorySearch(startTime);
        }
    }

    /**
     * SQLite-powered metadata search.
     */
    function performSqliteSearch(startTime) {
        var parsed = search.parseSearchQuery(lastSearchTerm);
        var q = search.buildMetaSQL(parsed);

        db.queryMetaAsync(q.sql, q.params).then(function (sqlRows) {
            var uiRows = sqlRows.map(mapSqlRowToUI);

            // Build match hints for hidden columns
            matchHints = new Map();
            if (parsed.otherTerms && parsed.otherTerms.length > 0) {
                uiRows.forEach(function (row) {
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

            allResults = uiRows;
            totalResults = uiRows.length;
            currentPage = 1;

            var elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
            document.getElementById('timer').textContent = i18n.t('elapsedTime') + ' ' + elapsed + ' ' + i18n.t('seconds');

            track('search', { query: lastSearchTerm, mode: searchMode, results: totalResults });
            displayResults();
        }).catch(function (err) {
            console.error('SQLite search error, falling back to in-memory:', err);
            performInMemorySearch(startTime);
        });
    }

    /**
     * In-memory search (XLSX/CSV fallback).
     */
    function performInMemorySearch(startTime) {
        var result = search.searchInMemory(DB, lastSearchTerm);
        allResults = result.results;
        matchHints = result.matchHints;
        totalResults = allResults.length;
        currentPage = 1;

        var elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
        document.getElementById('timer').textContent = i18n.t('elapsedTime') + ' ' + elapsed + ' ' + i18n.t('seconds');

        displayResults();
    }

    /**
     * Find matches in hidden columns for hint display.
     */
    function findMatchingHiddenCols(row, searchTerm) {
        var HIDDEN_COLS = ['Subject', 'Subtype', 'Books', 'Author', 'Bhajans', 'Personality'];
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

    function displayResults() {
        var startIndex = (currentPage - 1) * pageSize;
        var endIndex = Math.min(currentPage * pageSize, totalResults);

        document.getElementById('resultsInfo').innerHTML =
            '<strong>' + totalResults + ' ' + i18n.t('filesFound') + '</strong>&nbsp;&nbsp;&nbsp;' +
            i18n.t('showingResults') + ' ' + (totalResults === 0 ? 0 : (startIndex + 1)) + '-' + endIndex;

        ui.renderResults(allResults, lastSearchTerm, startIndex, endIndex, matchHints);
        ui.renderPagination(totalResults, currentPage, pageSize, changePage);
    }

    function changePage(p) {
        var totalPages = Math.ceil(totalResults / pageSize);
        if (p >= 1 && p <= totalPages) {
            currentPage = p;
            displayResults();
        }
    }

    // ===== SEARCH MODE TOGGLE =====
    function setSearchMode(mode) {
        closeAllPanels();
        setActiveCollection(null);
        var prevMode = searchMode;
        searchMode = mode || 'metadata';
        if (prevMode !== mode) {
            track('mode-switch', { from: prevMode, to: searchMode });
        }
        document.querySelectorAll('.search-mode-btn').forEach(function (btn) {
            btn.classList.toggle('active', btn.getAttribute('data-mode') === searchMode);
        });
        // Hide verse sources panel when switching away from citations mode
        var versePanel = document.getElementById('verseSourcesList');
        if (versePanel && mode !== 'citations') {
            versePanel.style.display = 'none';
        }
        var verseList = document.getElementById('verseList');
        if (verseList && mode !== 'citations') {
            verseList.style.display = 'none';
        }
        // Clear results and search field when switching modes
        if (prevMode !== mode) {
            document.getElementById('searchTerm').value = '';
            document.getElementById('resultsInfo').innerHTML = '';
            document.getElementById('timer').textContent = '';
            document.getElementById('pagination').innerHTML = '';
            var tbody = document.getElementById('resultsTable').querySelector('tbody');
            if (tbody) tbody.innerHTML = '<tr><td colspan="11" class="empty-result-message" data-i18n="enterSearchTerms">' + i18n.t('enterSearchTerms') + '</td></tr>';
            allResults = [];
            totalResults = 0;
            lastSearchTerm = '';
        }
        // Update search placeholder based on mode
        var searchInput = document.getElementById('searchTerm');
        if (mode === 'citations') {
            searchInput.placeholder = i18n.t('quotesSearchHint');
            setComboDisplay(i18n.t('byCitedVersesDisplay'));
        } else if (mode === 'citationsTop') {
            searchInput.placeholder = i18n.t('quotesSearchHint');
            setComboDisplay(i18n.t('mostCitedVersesDisplay'));
        } else {
            var count = totalLectures || 0;
            if (!dataLoaded && !count) {
                // Still loading and no cached count — never show "among 0 links"
                searchInput.placeholder = i18n.t('searchPlaceholderLoading');
            } else {
                searchInput.placeholder = i18n.t('searchPlaceholder').replace('{count}', count.toLocaleString());
            }
            clearComboDisplay();
        }
        // Immediately show top 108 when that mode is selected
        if (mode === 'citationsTop') {
            showTopCitations();
        }
    }

    // ===== QUICK ACTIONS =====

    function showLatestFiles() {
        if (!dataLoaded) return;
        closeAllPanels();
        track('quick-action', { action: 'latest-files' });
        setSearchMode('metadata');

        if (usingSqlite) {
            db.queryMetaAsync(
                "SELECT * FROM lectures WHERE added != '' AND nr != '' ORDER BY added DESC LIMIT 20"
            ).then(function (rows) {
                var uiRows = rows.map(mapSqlRowToUI);
                uiRows.sort(utils.compareDates);
                lastSearchTerm = i18n.t('latest20Files');
                allResults = uiRows;
                totalResults = uiRows.length;
                currentPage = 1;
                matchHints = new Map();
                document.getElementById('searchTerm').value = i18n.t('latest20Files');
                document.getElementById('timer').textContent = '';
                displayResults();
                setComboDisplay(i18n.t('addedDateDisplay'));
            }).catch(function (e) {
                console.warn('SQLite latest files failed, falling back:', e);
                showLatestFilesFallback();
            });
            return;
        }

        showLatestFilesFallback();
    }

    function showLatestFilesFallback() {
        var withAdded = DB.filter(function (r) {
            var added = (r['Added'] || '').toString().trim();
            var nr = (r['Nr.'] || '').toString().trim();
            return added !== '' && nr !== '';
        });
        withAdded.sort(function (a, b) { return (b['Added'] || '').toString().localeCompare((a['Added'] || '').toString()); });
        var top20 = withAdded.slice(0, 20);
        var nrSet = new Set(top20.map(function (r) { return (r['Nr.'] || '').toString().trim(); }));

        lastSearchTerm = 'latest_files:' + Array.from(nrSet).join(',');
        allResults = DB.filter(function (r) { return nrSet.has((r['Nr.'] || '').toString().trim()); });
        allResults.sort(utils.compareDates);
        totalResults = allResults.length;
        currentPage = 1;
        matchHints = new Map();
        document.getElementById('searchTerm').value = i18n.t('latest20Files');
        document.getElementById('timer').textContent = '';
        displayResults();
        setComboDisplay(i18n.t('addedDateDisplay'));
    }

    function showBy2026() {
        if (!dataLoaded) return;
        closeAllPanels();
        track('quick-action', { action: 'by-2026' });
        setSearchMode('metadata');

        if (usingSqlite) {
            db.queryMetaAsync(
                "SELECT * FROM lectures WHERE date LIKE '2026%' AND nr != '' ORDER BY date DESC"
            ).then(function (rows) {
                var uiRows = rows.map(mapSqlRowToUI);
                uiRows.sort(utils.compareDates);
                lastSearchTerm = '2026';
                allResults = uiRows;
                totalResults = uiRows.length;
                currentPage = 1;
                matchHints = new Map();
                document.getElementById('searchTerm').value = '2026';
                document.getElementById('timer').textContent = '';
                displayResults();
                setComboDisplay(i18n.t('entries2026Display'));
            }).catch(function (e) {
                console.warn('SQLite by-2026 failed, falling back:', e);
                showBy2026Fallback();
            });
            return;
        }

        showBy2026Fallback();
    }

    function showBy2026Fallback() {
        var rows = DB.filter(function (r) {
            var d = (r['Date'] || '').toString().trim();
            var nr = (r['Nr.'] || '').toString().trim();
            return d.indexOf('2026') === 0 && nr !== '';
        });
        rows.sort(utils.compareDates);
        lastSearchTerm = '2026';
        allResults = rows;
        totalResults = rows.length;
        currentPage = 1;
        matchHints = new Map();
        document.getElementById('searchTerm').value = '2026';
        document.getElementById('timer').textContent = '';
        displayResults();
        setComboDisplay(i18n.t('entries2026Display'));
    }

    function showLatestTranscripts() {
        if (!dataLoaded) return;
        closeAllPanels();
        track('quick-action', { action: 'latest-transcripts' });
        setSearchMode('metadata');

        if (usingSqlite) {
            db.queryMetaAsync(
                "SELECT * FROM lectures WHERE scripts_added != '' AND nr != '' ORDER BY scripts_added DESC LIMIT 20"
            ).then(function (rows) {
                var uiRows = rows.map(mapSqlRowToUI);
                // Keep SQL order: scripts_added DESC (do NOT re-sort by Date)
                lastSearchTerm = i18n.t('latest20Transcripts');
                allResults = uiRows;
                totalResults = uiRows.length;
                currentPage = 1;
                matchHints = new Map();
                document.getElementById('searchTerm').value = i18n.t('latest20Transcripts');
                document.getElementById('timer').textContent = '';
                displayResults();
                setComboDisplay(i18n.t('newestTranscriptsDisplay'));
            }).catch(function (e) {
                console.warn('SQLite latest transcripts failed, falling back:', e);
                showLatestTranscriptsFallback();
            });
            return;
        }

        showLatestTranscriptsFallback();
    }

    function showLatestTranscriptsFallback() {
        var withScripts = DB.filter(function (r) {
            var sa = (r['Scripts added'] || '').toString().trim();
            var nr = (r['Nr.'] || '').toString().trim();
            return sa !== '' && nr !== '';
        });
        withScripts.sort(function (a, b) { return (b['Scripts added'] || '').toString().localeCompare((a['Scripts added'] || '').toString()); });
        var top20 = withScripts.slice(0, 20);
        var nrSet = new Set(top20.map(function (r) { return (r['Nr.'] || '').toString().trim(); }));

        lastSearchTerm = 'latest_transcripts:' + Array.from(nrSet).join(',');
        allResults = DB.filter(function (r) { return nrSet.has((r['Nr.'] || '').toString().trim()); });
        // Keep scripts_added DESC order from top20
        allResults.sort(function (a, b) { return (b['Scripts added'] || '').toString().localeCompare((a['Scripts added'] || '').toString()); });
        totalResults = allResults.length;
        currentPage = 1;
        matchHints = new Map();
        document.getElementById('searchTerm').value = i18n.t('latest20Transcripts');
        document.getElementById('timer').textContent = '';
        displayResults();
        setComboDisplay(i18n.t('newestTranscriptsDisplay'));
    }

    // ===== ALL TRANSCRIPTS BY DATE =====

    function showAllTranscriptsByDate() {
        if (!dataLoaded) return;
        closeAllPanels();
        track('quick-action', { action: 'all-transcripts-by-date' });
        setSearchMode('metadata');

        if (usingSqlite) {
            db.queryMetaAsync(
                "SELECT * FROM lectures " +
                "WHERE (script_en NOT IN ('', 'N/A', '0', 'Duplicate', 'Dublikāts', 'Дубликат', 'Дубикат', 'Not relevant', 'Neattiecas', 'Не относится')) " +
                "   OR (script_lv NOT IN ('', 'N/A', '0', 'Duplicate', 'Dublikāts', 'Дубликат', 'Дубикат', 'Not relevant', 'Neattiecas', 'Не относится')) " +
                "   OR (script_ru NOT IN ('', 'N/A', '0', 'Duplicate', 'Dublikāts', 'Дубликат', 'Дубикат', 'Not relevant', 'Neattiecas', 'Не относится')) " +
                "ORDER BY CASE WHEN date = 'unknown' THEN 1 ELSE 0 END, date DESC, original_file_name DESC"
            ).then(function (rows) {
                var uiRows = rows.map(mapSqlRowToUI);
                lastSearchTerm = i18n.t('allTranscriptsByDate');
                allResults = uiRows;
                totalResults = uiRows.length;
                currentPage = 1;
                matchHints = new Map();
                document.getElementById('searchTerm').value = i18n.t('allTranscriptsByDate');
                document.getElementById('timer').textContent = '';
                displayResults();
                setComboDisplay(i18n.t('transcriptsByDateDisplay'));
            }).catch(function (e) {
                console.warn('SQLite all transcripts by date failed, falling back:', e);
                showAllTranscriptsByDateFallback();
            });
            return;
        }

        showAllTranscriptsByDateFallback();
    }

    function showAllTranscriptsByDateFallback() {
        var withScripts = DB.filter(function (r) {
            var en = (r['Script_EN'] || '').toString().trim();
            var lv = (r['Script_LV'] || '').toString().trim();
            var ru = (r['Script_RU'] || '').toString().trim();
            function hasVal(v) { return v !== '' && v !== 'N/A' && v !== '0' && v !== 'Duplicate' && v !== 'Dublikāts' && v !== 'Дубликат' && v !== 'Дубикат' && v !== 'Not relevant' && v !== 'Neattiecas' && v !== 'Не относится'; }
            return hasVal(en) || hasVal(lv) || hasVal(ru);
        });
        withScripts.sort(function (a, b) {
            var dateA = (a['Date'] || '').toString().trim();
            var dateB = (b['Date'] || '').toString().trim();
            var unknownA = (dateA === 'unknown' || dateA === '') ? 1 : 0;
            var unknownB = (dateB === 'unknown' || dateB === '') ? 1 : 0;
            if (unknownA !== unknownB) return unknownA - unknownB;
            var cmp = dateB.localeCompare(dateA);
            if (cmp !== 0) return cmp;
            return ((b['Original file name'] || '').toString()).localeCompare((a['Original file name'] || '').toString());
        });

        lastSearchTerm = i18n.t('allTranscriptsByDate');
        allResults = withScripts;
        totalResults = withScripts.length;
        currentPage = 1;
        matchHints = new Map();
        document.getElementById('searchTerm').value = i18n.t('allTranscriptsByDate');
        document.getElementById('timer').textContent = '';
        displayResults();
        setComboDisplay(i18n.t('transcriptsByDateDisplay'));
    }

    // ===== FAVORITES =====

    function showFavorites() {
        if (!dataLoaded) return;
        closeAllPanels();
        var _rt = document.getElementById('resultsTable');
        if (_rt) _rt.style.display = '';
        track('quick-action', { action: 'favorites' });

        var cols = PPP.favorites ? PPP.favorites.getCollections() : [];
        if (cols.length === 0) {
            setSearchMode('metadata');
            lastSearchTerm = '';
            allResults = [];
            totalResults = 0;
            currentPage = 1;
            matchHints = new Map();
            document.getElementById('searchTerm').value = i18n.t('favorites');
            document.getElementById('timer').textContent = '';
            displayResults();
            var tbody = document.querySelector('#resultsTable tbody');
            if (tbody) {
                var row = tbody.querySelector('tr');
                if (row && row.cells[0]) row.cells[0].textContent = i18n.t('noFavorites');
            }
            return;
        }

        // Show collections picker popup under the Favorites button
        _showCollectionsPicker();
    }

    function _showCollectionsPicker() {
        // Close any existing picker
        var old = document.getElementById('collectionsPickerPopup');
        if (old) old.remove();

        var cols = PPP.favorites.getCollections();
        var btn = document.getElementById('favoritesBtn');

        var popup = document.createElement('div');
        popup.id = 'collectionsPickerPopup';
        popup.className = 'collections-picker';

        // "All saved" option
        var allItem = document.createElement('div');
        allItem.className = 'collections-picker-item';
        var allCount = PPP.favorites.count();
        allItem.innerHTML = '<span class="cpi-name">' + (i18n.t('allSaved') || 'All saved') + '</span><span class="cpi-count">' + allCount + '</span>';
        allItem.onclick = function () {
            popup.remove();
            document.removeEventListener('click', onDocClick);
            _showCollectionLectures(null, i18n.t('allSaved') || 'All saved');
        };
        popup.appendChild(allItem);

        // Divider
        var hr = document.createElement('div');
        hr.className = 'collections-picker-divider';
        popup.appendChild(hr);

        // Each collection
        cols.forEach(function (col) {
            var item = document.createElement('div');
            item.className = 'collections-picker-item';
            var dispName = (col.name === 'Favorites') ? (i18n.t('favorites') || col.name) : col.name;
            item.innerHTML = '<span class="cpi-name">' + _escHtml(dispName) + '</span><span class="cpi-count">' + col.count + '</span>';
            item.onclick = function () {
                popup.remove();
                document.removeEventListener('click', onDocClick);
                _showCollectionLectures(col.id, col.name);
            };
            popup.appendChild(item);
        });

        document.body.appendChild(popup);

        // Position under button
        var rect = btn.getBoundingClientRect();
        popup.style.top = (rect.bottom + 4 + window.scrollY) + 'px';
        popup.style.left = (rect.left + window.scrollX) + 'px';

        function onDocClick(e) {
            if (!popup.contains(e.target) && e.target !== btn) {
                popup.remove();
                document.removeEventListener('click', onDocClick);
            }
        }
        setTimeout(function () { document.addEventListener('click', onDocClick); }, 0);
    }

    function _escHtml(s) {
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    function _showCollectionLectures(colId, label) {
        setSearchMode('metadata');
        setActiveCollection(label);

        var nrs = colId !== null
            ? PPP.favorites.getCollectionLectures(colId)
            : PPP.favorites.getAll();

        if (nrs.length === 0) {
            lastSearchTerm = '';
            allResults = [];
            totalResults = 0;
            currentPage = 1;
            matchHints = new Map();
            document.getElementById('searchTerm').value = label;
            document.getElementById('timer').textContent = '';
            displayResults();
            setComboDisplay(i18n.t('favoritesBtn') || '\u2605 Favorites');
            var tbody = document.querySelector('#resultsTable tbody');
            if (tbody) {
                var row = tbody.querySelector('tr');
                if (row && row.cells[0]) row.cells[0].textContent = i18n.t('noFavorites');
            }
            return;
        }

        if (usingSqlite) {
            var placeholders = nrs.map(function () { return '?'; }).join(',');
            db.queryMetaAsync(
                'SELECT * FROM lectures WHERE nr IN (' + placeholders + ') ORDER BY date DESC',
                nrs
            ).then(function (rows) {
                var uiRows = rows.map(mapSqlRowToUI);
                lastSearchTerm = label;
                allResults = uiRows;
                totalResults = uiRows.length;
                currentPage = 1;
                matchHints = new Map();
                document.getElementById('searchTerm').value = label;
                document.getElementById('timer').textContent = '';
                displayResults();
                setComboDisplay(i18n.t('favoritesBtn') || '\u2605 Favorites');
            });
            return;
        }

        var nrSet = new Set(nrs);
        allResults = DB.filter(function (r) {
            return nrSet.has((r['Nr.'] || '').toString().trim());
        });
        allResults.sort(utils.compareDates);
        lastSearchTerm = label;
        totalResults = allResults.length;
        currentPage = 1;
        matchHints = new Map();
        document.getElementById('searchTerm').value = label;
        document.getElementById('timer').textContent = '';
        displayResults();
        setComboDisplay(i18n.t('favoritesBtn') || '\u2605 Favorites');
    }

    var _activeCollectionName = null;

    function setActiveCollection(name) {
        _activeCollectionName = name || null;
        updateFavoritesCount();
    }

    function updateFavoritesCount() {
        var btn = document.getElementById('favoritesBtn');
        var badge = document.getElementById('favCount');
        if (!badge) return;
        var c = PPP.favorites ? PPP.favorites.count() : 0;
        badge.textContent = c > 0 ? c : '';
        badge.style.display = c > 0 ? 'inline-block' : 'none';
        if (btn) {
            var label = '\u2605 ' + i18n.t('favorites') + ' ';
            btn.firstChild.textContent = label;
            // Show active collection subtitle
            var sub = document.getElementById('favActiveCol');
            if (!sub) {
                sub = document.createElement('span');
                sub.id = 'favActiveCol';
                sub.className = 'fav-active-col';
                btn.appendChild(sub);
            }
            if (_activeCollectionName) {
                sub.textContent = _activeCollectionName;
                sub.style.display = 'block';
            } else {
                sub.textContent = '';
                sub.style.display = 'none';
            }
        }
    }

    function showRecommendations() {
        track('quick-action', { action: 'recommendations' });
        var div = document.getElementById('recommendationsList');
        var resultsTable = document.getElementById('resultsTable');
        if (div.style.display !== 'none' && div.style.display !== '') {
            div.style.display = 'none';
            if (resultsTable) resultsTable.style.display = '';
            return;
        }
        closeAllPanels();
        if (!dataLoaded) return;
        if (resultsTable) resultsTable.style.display = 'none';
        setComboDisplay(i18n.t('recommendations'));

        if (usingSqlite) {
            Promise.all([
                db.queryMetaAsync(
                    "SELECT lang, COUNT(*) as cnt FROM lectures WHERE lang != '' " +
                    "AND (LOWER(lang) LIKE 'eng;%' OR LOWER(lang) = 'eng only' OR LOWER(lang) = 'rus only') " +
                    "GROUP BY lang ORDER BY lang"
                ),
                db.queryMetaAsync(
                    "SELECT subject FROM lectures WHERE subject LIKE '.%'"
                )
            ]).then(function (results) {
                var langCounts = {}, subjCounts = {};
                results[0].forEach(function (r) { langCounts[r.lang] = parseInt(r.cnt, 10); });
                results[1].forEach(function (r) {
                    var parts = (r.subject || '').split(';');
                    parts.forEach(function (p) {
                        var t = p.trim();
                        if (t.charAt(0) === '.') {
                            subjCounts[t] = (subjCounts[t] || 0) + 1;
                        }
                    });
                });
                renderRecommendationsHTML(div, langCounts, subjCounts);
            }).catch(function (e) {
                console.warn('SQLite recommendations failed, falling back:', e);
                var langCounts = {}, subjCounts = {};
                buildRecommendationsFromMemory(langCounts, subjCounts);
                renderRecommendationsHTML(div, langCounts, subjCounts);
            });
        } else {
            var langCounts = {}, subjCounts = {};
            buildRecommendationsFromMemory(langCounts, subjCounts);
            renderRecommendationsHTML(div, langCounts, subjCounts);
        }
    }

    function renderRecommendationsHTML(div, langCounts, subjCounts) {
        var esc = utils.escapeHtml;
        var enc = utils.encodeForAttr;
        var html = '<button id="recommendationsHideBtn" class="recommendations-hide-btn" onclick="PPP.app.showRecommendations()">' + utils.escapeHtml(i18n.t('hideRecommendationsBtn')) + '</button><div id="recommendationsListContent">';
        Object.entries(langCounts).sort(function (a, b) { return a[0].localeCompare(b[0]); }).forEach(function (entry) {
            var name = entry[0], count = entry[1];
            html += '<div class="recommendation-item"><span class="recommendation-name">' + esc(name) +
                ' <span style="color:var(--primary-dark);font-weight:700;">(' + count + ')</span></span>' +
                '<button class="recommendation-search-btn" onclick="PPP.app.applyLangFilter(decodeURIComponent(\'' + enc(name) + '\'))">Yes</button></div>';
        });
        Object.entries(subjCounts).sort(function (a, b) { return a[0].localeCompare(b[0]); }).forEach(function (entry) {
            var name = entry[0], count = entry[1];
            html += '<div class="recommendation-item"><span class="recommendation-name">' + esc(name) +
                ' <span style="color:var(--primary-dark);font-weight:700;">(' + count + ')</span></span>' +
                '<button class="recommendation-search-btn" onclick="PPP.app.applySubjectFilter(decodeURIComponent(\'' + enc(name) + '\'))">Yes</button></div>';
        });
        html += '</div>';
        div.innerHTML = html;
        div.style.display = 'block';
    }

    function buildRecommendationsFromMemory(langCounts, subjCounts) {
        DB.forEach(function (r) {
            var l = (r['Lang.'] || '').trim();
            if (l && (l.toLowerCase().startsWith('eng;') || l.toLowerCase() === 'eng only' || l.toLowerCase() === 'rus only'))
                langCounts[l] = (langCounts[l] || 0) + 1;
            var s = (r['Subject'] || '').trim();
            if (s && s.startsWith('.')) subjCounts[s] = (subjCounts[s] || 0) + 1;
        });
    }

    function showTopics() {
        var div = document.getElementById('topicsList');
        var resultsTable = document.getElementById('resultsTable');
        if (div.style.display !== 'none' && div.style.display !== '') {
            div.style.display = 'none';
            if (resultsTable) resultsTable.style.display = '';
            return;
        }
        closeAllPanels();
        document.getElementById('recommendationsList').style.display = 'none';
        if (!dataLoaded) return;
        if (resultsTable) resultsTable.style.display = 'none';

        if (usingSqlite) {
            // Count only ORIGINAL transcripts (any of script_en/lv/ru with non-duplicate label)
            db.queryMetaAsync(
                "SELECT subject FROM lectures " +
                "WHERE subject LIKE '.%' AND (" +
                "  (script_en NOT IN ('', 'N/A', '0', 'Duplicate', 'Dublikāts', 'Дубликат', 'Not relevant', 'Neattiecas', 'Не относится')) OR " +
                "  (script_lv NOT IN ('', 'N/A', '0', 'Duplicate', 'Dublikāts', 'Дубликат', 'Not relevant', 'Neattiecas', 'Не относится')) OR " +
                "  (script_ru NOT IN ('', 'N/A', '0', 'Duplicate', 'Dublikāts', 'Дубликат', 'Not relevant', 'Neattiecas', 'Не относится'))" +
                ")"
            ).then(function (rows) {
                var topicCounts = {};
                rows.forEach(function (r) {
                    var parts = (r.subject || '').split(';');
                    parts.forEach(function (p) {
                        var t = p.trim();
                        if (t.charAt(0) === '.') {
                            topicCounts[t] = (topicCounts[t] || 0) + 1;
                        }
                    });
                });
                var sorted = Object.keys(topicCounts).sort();
                var esc = utils.escapeHtml;
                var enc = utils.encodeForAttr;
                var html = '<button id="topicsHideBtn" class="recommendations-hide-btn" onclick="PPP.app.showTopics()">' + utils.escapeHtml(i18n.t('hideTopicsBtn')) + '</button><div id="topicsListContent">';
                sorted.forEach(function (name) {
                    html += '<div class="topic-item"><span class="topic-name">' + esc(name) +
                        ' <span style="color:var(--primary-dark);font-weight:700;">(' + topicCounts[name] + ')</span></span>' +
                        '<button class="topic-search-btn" onclick="PPP.app.applySubjectFilter(decodeURIComponent(\'' + enc(name) + '\'))">Yes</button></div>';
                });
                html += '</div>';
                div.innerHTML = html;
                div.style.display = 'block';
                setComboDisplay(i18n.t('transcriptsByTopicDisplay'));
            }).catch(function (e) {
                console.warn('SQLite topics failed, falling back:', e);
                ui.renderTopics(DB, div);
                div.style.display = 'block';
                setComboDisplay(i18n.t('transcriptsByTopicDisplay'));
            });
            return;
        }

        // Fallback: in-memory
        ui.renderTopics(DB, div);
        div.style.display = 'block';
        setComboDisplay(i18n.t('transcriptsByTopicDisplay'));
    }

    function showSources() {
        var div = document.getElementById('sourcesList');
        if (div.style.display !== 'none' && div.style.display !== '') { div.style.display = 'none'; return; }
        if (!dataLoaded) return;

        function renderSourcesHTML(sources) {
            var esc = utils.escapeHtml;
            var enc = utils.encodeForAttr;
            var html = '<h3>' + i18n.t('sources') + '</h3><ul>';
            Object.keys(sources).sort().forEach(function (name) {
                html += '<li onclick="PPP.app.applySourceFilter(decodeURIComponent(\'' + enc(name) + '\'))">' + esc(name) + '</li>';
            });
            html += '</ul>';
            div.innerHTML = html;
            div.style.display = 'block';
        }

        if (usingSqlite) {
            db.queryMetaAsync(
                "SELECT source, COUNT(*) as cnt FROM lectures WHERE source != '' GROUP BY source ORDER BY source"
            ).then(function (srcRows) {
                var sources = {};
                srcRows.forEach(function (r) { sources[r.source] = parseInt(r.cnt, 10); });
                renderSourcesHTML(sources);
            }).catch(function (e) {
                console.warn('SQLite sources failed, falling back:', e);
                var sources = {};
                DB.forEach(function (r) { var s = (r['Source'] || '').trim(); if (s) sources[s] = (sources[s] || 0) + 1; });
                renderSourcesHTML(sources);
            });
        } else {
            var sources = {};
            DB.forEach(function (r) { var s = (r['Source'] || '').trim(); if (s) sources[s] = (sources[s] || 0) + 1; });
            renderSourcesHTML(sources);
        }
    }

    // ===== VERSE NAVIGATION (Sources > Verses > Lectures) =====

    function hideVersePanels() {
        document.getElementById('verseSourcesList').style.display = 'none';
        document.getElementById('verseList').style.display = 'none';
        var tc = document.getElementById('topCitationsList');
        if (tc) tc.style.display = 'none';
        var resultsTable = document.getElementById('resultsTable');
        if (resultsTable) resultsTable.style.display = '';
    }

    function showVerseSources() {
        var div = document.getElementById('verseSourcesList');
        var resultsTable = document.getElementById('resultsTable');
        // Toggle off if already open
        if (div.style.display !== 'none' && div.style.display !== '') {
            hideVersePanels();
            if (resultsTable) resultsTable.style.display = '';
            return;
        }
        document.getElementById('verseList').style.display = 'none';
        document.getElementById('recommendationsList').style.display = 'none';
        document.getElementById('topicsList').style.display = 'none';
        if (resultsTable) resultsTable.style.display = 'none';
        if (!usingSqlite) return;

        var esc = utils.escapeHtml;
        var enc = utils.encodeForAttr;

        function renderSourceItem(row) {
            var name = row.source_canonical || '';
            var count = row.unique_verses || 0;
            return '<div class="recommendation-item">' +
                '<span class="recommendation-name">' + esc(name) +
                ' <span style="color:var(--primary-dark);font-weight:700;">(' + count + ')</span></span>' +
                '<button class="recommendation-search-btn" onclick="PPP.app.showVerseList(decodeURIComponent(\'' + enc(name) + '\'))">Yes</button>' +
                '</div>';
        }

        Promise.all([
            db.queryMetaAsync("SELECT source_canonical, unique_verses, total_citations, lecture_count FROM verse_citation_stats ORDER BY unique_verses DESC LIMIT 30"),
            db.queryMetaAsync("SELECT source_canonical, unique_verses, total_citations, lecture_count FROM verse_citation_stats ORDER BY source_canonical ASC")
        ]).then(function (results) {
            var topRows = results[0];
            var allRows = results[1];
            var topNames = {};
            topRows.forEach(function (r) { topNames[r.source_canonical] = true; });
            var otherRows = allRows.filter(function (r) { return !topNames[r.source_canonical]; });

            var html = '<button class="verse-sources-hide-btn" onclick="PPP.app.showVerseSources()">' +
                utils.escapeHtml(i18n.t('hideVerseSourcesBtn')) + ' (' + allRows.length + ')</button>' +
                '<div style="padding:6px 14px 14px;overflow-y:auto;max-height:60vh;">';

            html += '<div style="font-size:11px;color:var(--primary-dark);font-weight:600;padding:8px 0 4px;border-bottom:1px solid var(--border-light);letter-spacing:0.5px;">TOP 30</div>';
            topRows.forEach(function (row) { html += renderSourceItem(row); });

            if (otherRows.length > 0) {
                html += '<div style="font-size:11px;color:var(--primary-dark);font-weight:600;padding:12px 0 4px;border-bottom:1px solid var(--border-light);letter-spacing:0.5px;">OTHERS (' + otherRows.length + ')</div>';
                otherRows.forEach(function (row) { html += renderSourceItem(row); });
            }

            html += '</div>';
            div.innerHTML = html;
            div.style.display = 'block';
        }).catch(function (err) {
            console.error('Verse sources error:', err);
        });
    }

    function showVerseList(sourceName) {
        var div = document.getElementById('verseList');
        var resultsTable = document.getElementById('resultsTable');
        document.getElementById('verseSourcesList').style.display = 'none';
        if (resultsTable) resultsTable.style.display = 'none';
        if (!usingSqlite) return;

        db.queryMetaAsync(
            "SELECT reference, chapter_verse, COUNT(*) as lecture_count " +
            "FROM verse_citations WHERE source_canonical = $src " +
            "GROUP BY reference ORDER BY " +
            "CAST(REPLACE(SUBSTR(chapter_verse, 1, INSTR(chapter_verse || '.', '.') - 1), '-', '') AS INTEGER), " +
            "CAST(REPLACE(SUBSTR(chapter_verse, INSTR(chapter_verse || '.', '.') + 1), '-', '') AS INTEGER)",
            { $src: sourceName }
        ).then(function (rows) {
            var esc = utils.escapeHtml;
            var enc = utils.encodeForAttr;
            var html = '<button class="verse-sources-hide-btn" onclick="PPP.app.showVerseSources()">' +
                '&larr; ' + esc(sourceName) + ' (' + rows.length + ' verses)</button>' +
                '<div style="padding:6px 14px 14px;overflow-y:auto;max-height:60vh;">';

            rows.forEach(function (row) {
                var ref = row.reference || '';
                var cv = row.chapter_verse || '';
                var cnt = row.lecture_count || 0;
                html += '<div class="recommendation-item">' +
                    '<span class="recommendation-name">' + esc(cv) +
                    ' <span style="color:var(--primary-dark);font-weight:700;">(' + cnt + ')</span></span>' +
                    '<button class="recommendation-search-btn" onclick="PPP.app.showVerseLectures(decodeURIComponent(\'' + enc(ref) + '\'))">Yes</button>' +
                    '</div>';
            });
            html += '</div>';
            div.innerHTML = html;
            div.style.display = 'block';
        }).catch(function (err) {
            console.error('Verse list error:', err);
        });
    }

    // Store verse position data for transcript viewer links
    var activeVersePositions = {}; // { lectureNr: { reference, position } }
    var activeVerseReference = '';

    function showVerseLectures(reference) {
        hideVersePanels();
        // Ensure we're in citations mode for proper result rendering
        setSearchMode('citations');
        if (!usingSqlite) return;

        db.queryMetaAsync(
            "SELECT lecture_nr, position, context, block_index FROM verse_citations WHERE reference = $ref",
            { $ref: reference }
        ).then(function (vcRows) {
            if (vcRows.length === 0) return;

            // Store position data for transcript viewer
            activeVersePositions = {};
            activeVerseReference = reference;
            vcRows.forEach(function (r) {
                if (!activeVersePositions[r.lecture_nr]) {
                    activeVersePositions[r.lecture_nr] = {
                        reference: reference,
                        position: r.position || 0,
                        context: r.context || '',
                        block_index: r.block_index || null
                    };
                }
            });

            // Get unique lecture nrs
            var uniqueNrs = {};
            vcRows.forEach(function (r) { uniqueNrs[r.lecture_nr] = true; });
            var nrList = Object.keys(uniqueNrs);

            var params = {};
            var placeholders = nrList.map(function (nr, i) {
                var key = '$nr' + i;
                params[key] = nr;
                return key;
            });

            return db.queryMetaAsync(
                "SELECT * FROM lectures WHERE nr IN (" + placeholders.join(',') + ") ORDER BY CASE WHEN date = 'unknown' THEN 1 ELSE 0 END, date DESC",
                params
            ).then(function (sqlRows) {
                var uiRows = sqlRows.map(function (sqlRow) {
                    var uiRow = mapSqlRowToUI(sqlRow);
                    var nr = String(sqlRow.nr || '');
                    if (activeVersePositions[nr]) {
                        uiRow._versePosition = activeVersePositions[nr].position;
                        uiRow._verseReference = reference;
                        uiRow._lectureNr = nr;
                        uiRow._blockIndex = activeVersePositions[nr].block_index;
                    }
                    return uiRow;
                });
                allResults = uiRows;
                totalResults = uiRows.length;
                currentPage = 1;
                matchHints = new Map();

                document.getElementById('searchTerm').value = reference;
                lastSearchTerm = reference;
                document.getElementById('timer').textContent = '';

                displayResults();
            });
        }).catch(function (err) {
            console.error('Verse lectures error:', err);
        });
    }

    // ===== TRANSCRIPT VIEWER =====

    /**
     * Extract the diacritized verse reference from citation context.
     * Context format: "...text (Bhagavad-gītā 2.12 by Author)..."
     * Returns diacritized reference or null.
     */
    function extractDiacriticReference(context) {
        if (!context) return null;
        var m = context.match(/\(([^)]+?\d+[\.:]\d+[^)]*?)\s+by\s/);
        return m ? m[1].trim() : null;
    }

    /**
     * Show a temporary toast notification.
     */
    function showToast(message, durationMs) {
        var existing = document.getElementById('verseToast');
        if (existing) existing.remove();

        var toast = document.createElement('div');
        toast.id = 'verseToast';
        toast.className = 'verse-toast';
        toast.textContent = message;
        document.body.appendChild(toast);

        requestAnimationFrame(function () {
            toast.classList.add('visible');
        });

        setTimeout(function () {
            toast.classList.remove('visible');
            setTimeout(function () { toast.remove(); }, 400);
        }, durationMs || 4000);
    }

    function openTranscriptAtVerse(lectureNr, position, reference, blockIndex) {
        var nr = String(lectureNr);
        var block = blockIndex ? parseInt(blockIndex, 10) : null;

        // If no block_index from caller, try to get it from DB
        if (!block) {
            db.queryMetaAsync(
                "SELECT block_index FROM verse_citations WHERE lecture_nr = $nr AND reference = $ref LIMIT 1",
                { $nr: nr, $ref: reference }
            ).then(function (vc) {
                if (vc.length > 0 && vc[0].block_index) {
                    block = vc[0].block_index;
                }
                openHtmlTranscriptViewer(nr, 'en', block, reference);
            }).catch(function () {
                openHtmlTranscriptViewer(nr, 'en', block, reference);
            });
            return;
        }

        openHtmlTranscriptViewer(nr, 'en', block, reference);
    }

    /**
     * Open HTML transcript viewer in modal, scroll to block-N anchor.
     * lang: 'en', 'lv', 'ru'
     */
    var _currentTranscriptCtx = null;

    function _sanitizeFilename(s) {
        return String(s || '').replace(/[<>:"/\\|?* -]/g, '_').replace(/\s+/g, '_').slice(0, 120) || 'transcript';
    }

    function _escapeHtmlAttr(s) {
        return String(s || '').replace(/[<>&"']/g, function (c) {
            return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function _driveIdFromUrl(url) {
        if (!url) return null;
        var m = url.match(/\/file\/d\/([^/]+)/) || url.match(/[?&]id=([^&]+)/);
        return m ? m[1] : null;
    }

    function _triggerBlobDownload(blob, fileName) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    }

    function _buildHtmlDoc(ctx) {
        var titleText = ctx.title || ('Nr_' + ctx.nr);
        return '<!DOCTYPE html>\n<html lang="' + _escapeHtmlAttr(ctx.lang) + '">\n<head>\n' +
            '<meta charset="utf-8">\n' +
            '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
            '<title>' + _escapeHtmlAttr(titleText) + '</title>\n' +
            '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;max-width:820px;margin:1.5em auto;padding:0 1em;line-height:1.55;color:#222;background:#fff}h1,h2,h3{color:#7a1f00}a{color:#c97a00}p{margin:0.6em 0}</style>\n' +
            '</head>\n<body>\n<h1>' + _escapeHtmlAttr(titleText) + '</h1>\n' +
            ctx.html + '\n</body>\n</html>';
    }

    function downloadTranscript() {
        var ctx = _currentTranscriptCtx;
        if (!ctx) return;
        var driveId = _driveIdFromUrl(ctx.driveUrl);

        // Preferred path: navigate to drive.usercontent.google.com which sends
        // Content-Disposition: attachment. Chrome saves the original DOCX without
        // leaving the page. drive.usercontent.google.com is NOT registered for the
        // Android Drive app intent filter, so the file lands directly in Downloads.
        if (driveId) {
            var dlUrl = 'https://drive.usercontent.google.com/download?id=' + encodeURIComponent(driveId) + '&export=download';
            var a = document.createElement('a');
            a.href = dlUrl;
            a.rel = 'noopener';
            // Note: cross-origin <a download> attribute is ignored by Chrome, but
            // the server's Content-Disposition: attachment header takes effect.
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            track('transcript-download', { nr: String(ctx.nr), lang: ctx.lang, format: 'docx' });
            return;
        }

        // Fallback (no Drive URL): client-side HTML
        if (ctx.html) {
            var fileName = _sanitizeFilename(ctx.title || ('Nr_' + ctx.nr)) + '_' + ctx.lang + '.html';
            _triggerBlobDownload(new Blob([_buildHtmlDoc(ctx)], { type: 'text/html;charset=utf-8' }), fileName);
            track('transcript-download', { nr: String(ctx.nr), lang: ctx.lang, format: 'html' });
        }
    }

    function openHtmlTranscriptViewer(lectureNr, lang, blockIndex, reference, driveUrl) {
        track('transcript-open', { nr: String(lectureNr), lang: lang, block: blockIndex || 0 });
        var overlay = document.getElementById('transcriptModalOverlay');
        var body = document.getElementById('transcriptModalBody');
        var title = document.getElementById('transcriptModalTitle');

        // Reset download context — only enable button after content loads
        _currentTranscriptCtx = null;
        var dlBtn = document.getElementById('transcriptDownloadBtn');
        if (dlBtn) dlBtn.style.display = 'none';

        title.textContent = 'Loading ' + lang.toUpperCase() + ' transcript...';
        body.innerHTML = '<div class="transcript-loading"><div class="transcript-spinner"></div><span>Opening transcript...</span></div>';
        overlay.classList.add('active');

        // Phase 2: fetch a single per-lecture HTML file instead of loading the whole
        // language SQLite DB. Falls back via duplicate detection (meta DB → original
        // nr → fetch that file) when the requested nr has no own HTML file.
        function fetchTranscriptFile(nr) {
            return fetch('transcripts/' + lang + '/' + encodeURIComponent(String(nr)) + '.html')
                .then(function (r) { return r.ok ? r.text() : ''; })
                .catch(function () { return ''; });
        }

        var firstFetch = fetchTranscriptFile(lectureNr).then(function (html) {
            if (html) return [{ html_content: html }];
            // Duplicate-lecture fallback (matches the prior SQLite logic via meta DB)
            var urlCol = 'script_' + lang + '_url';
            return db.queryMetaAsync(
                "SELECT " + urlCol + " AS url FROM lectures WHERE nr = $nr LIMIT 1",
                { $nr: String(lectureNr) }
            ).then(function (urlRows) {
                if (urlRows.length === 0 || !urlRows[0].url) return [];
                var url = urlRows[0].url;
                return db.queryMetaAsync(
                    "SELECT nr FROM lectures WHERE " + urlCol + " = $url AND nr != $nr LIMIT 1",
                    { $url: url, $nr: String(lectureNr) }
                );
            }).then(function (origRows) {
                if (origRows.length === 0) return [];
                return fetchTranscriptFile(origRows[0].nr).then(function (h) {
                    return h ? [{ html_content: h }] : [];
                });
            });
        });

        firstFetch.then(function (rows) {
            if (rows.length === 0) {
                if (driveUrl) {
                    // Raw transcript: HTML not in-app, but the txt exists on Drive.
                    var rawTitle = (i18n.t && i18n.t('rawTranscriptTitle')) || 'Raw transcript (txt)';
                    var rawBody = (i18n.t && i18n.t('rawTranscriptBody')) ||
                        'This is a Raw transcript, available only in txt format. Open it from Google Drive.';
                    var openLabel = (i18n.t && i18n.t('openInGoogleDrive')) || 'Open in Google Drive';
                    title.textContent = rawTitle;
                    body.innerHTML = '<p>' + utils.escapeHtml(rawBody) + '</p><p><a href="' + driveUrl +
                        '" target="_blank" rel="noopener" style="color:var(--saffron)">' +
                        utils.escapeHtml(openLabel) + ' \u2197</a></p>';
                } else {
                    title.textContent = 'Transcript not found';
                    body.textContent = 'No ' + lang.toUpperCase() + ' transcript for lecture Nr.' + lectureNr;
                }
                return;
            }

            // Get title and Drive URL from meta DB
            return db.queryMetaAsync(
                "SELECT original_file_name, script_en_url, script_lv_url, script_ru_url FROM lectures WHERE nr = $nr LIMIT 1",
                { $nr: String(lectureNr) }
            ).then(function (meta) {
                var row = meta[0] || {};
                var origName = row.original_file_name || ('Nr.' + lectureNr);
                title.textContent = origName + (reference ? ' — ' + reference : '');
                var resolvedDriveUrl = driveUrl || row['script_' + lang + '_url'] || '';
                return { origName: origName, driveUrl: resolvedDriveUrl };
            }).catch(function () {
                title.textContent = 'Nr.' + lectureNr + (reference ? ' — ' + reference : '');
                return { origName: 'Nr_' + lectureNr, driveUrl: driveUrl || '' };
            }).then(function (info) {
                // Insert HTML content
                var htmlContent = rows[0].html_content || '';
                body.innerHTML = htmlContent;

                // Enable download button (DOCX from Drive if available, else client-side HTML)
                if ((htmlContent || info.driveUrl) && dlBtn) {
                    _currentTranscriptCtx = {
                        nr: lectureNr,
                        lang: lang,
                        title: info.origName,
                        html: htmlContent,
                        driveUrl: info.driveUrl
                    };
                    dlBtn.title = (i18n.t && i18n.t('downloadTranscript')) || 'Download';
                    dlBtn.style.display = '';
                }

                // Attach selection share handler
                _attachTranscriptSelectionShare(body, lectureNr, lang);

                // Scroll to block anchor or highlight text
                var deepHl = _pendingHighlight;
                _pendingHighlight = null;

                if (deepHl) {
                    // Deep link highlight — find text, highlight, scroll
                    setTimeout(function () {
                        _highlightAndScroll(body, deepHl);
                    }, 150);
                } else if (blockIndex) {
                    setTimeout(function () {
                        var anchor = document.getElementById('block-' + blockIndex);
                        if (anchor && body) {
                            var scrollTarget = anchor.offsetTop - body.clientHeight + 60;
                            body.scrollTop = Math.max(0, scrollTarget);
                            var blockP = anchor.closest('p') || anchor.parentElement;
                            if (blockP) {
                                blockP.classList.add('transcript-highlight');
                            }
                        }
                    }, 100);
                }
            });
        }).catch(function (err) {
            title.textContent = 'Error';
            body.textContent = 'Failed to load HTML transcripts: ' + err.message;
        });
    }

    // ===== TRANSCRIPT TEXT HIGHLIGHT SHARING =====

    function _highlightAndScroll(container, hlObj) {
        // hlObj = { start: "first 50 chars", len: total_char_count }
        var startText = (typeof hlObj === 'string') ? hlObj : hlObj.start;
        var totalLen = (typeof hlObj === 'string') ? startText.length : (hlObj.len || startText.length);
        if (!startText) return;

        // Build concatenated text map for cross-node searching
        var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
        var textNodes = [];
        var fullText = '';
        var n;
        while ((n = walker.nextNode())) {
            textNodes.push({ node: n, offset: fullText.length, len: n.textContent.length });
            fullText += n.textContent;
        }
        if (!textNodes.length) return;

        // Find start position
        var startPos = fullText.toLowerCase().indexOf(startText.toLowerCase());
        if (startPos === -1) return;
        var endPos = startPos + totalLen;

        // Map positions back to DOM nodes
        function findNodeAt(pos) {
            for (var i = 0; i < textNodes.length; i++) {
                var t = textNodes[i];
                if (pos >= t.offset && pos <= t.offset + t.len) {
                    return { node: t.node, offset: pos - t.offset };
                }
            }
            var last = textNodes[textNodes.length - 1];
            return { node: last.node, offset: last.len };
        }

        var startPoint = findNodeAt(startPos);
        var endPoint = findNodeAt(endPos);

        // Highlight each text node in range individually (works across block elements)
        var hlClass = 'transcript-deep-highlight';
        var firstMark = null;
        for (var ti = 0; ti < textNodes.length; ti++) {
            var tn = textNodes[ti];
            var nodeStart = tn.offset;
            var nodeEnd = tn.offset + tn.len;
            // Skip nodes outside the highlight range
            if (nodeEnd <= startPos || nodeStart >= endPos) continue;

            var wrapStart = Math.max(0, startPos - nodeStart);
            var wrapEnd = Math.min(tn.len, endPos - nodeStart);
            if (wrapStart >= wrapEnd) continue;

            try {
                var wr = document.createRange();
                wr.setStart(tn.node, wrapStart);
                wr.setEnd(tn.node, wrapEnd);
                var m = document.createElement('mark');
                m.className = hlClass;
                wr.surroundContents(m);
                if (!firstMark) firstMark = m;
            } catch (ex) { /* skip problematic nodes */ }
        }

        if (!firstMark) return;

        setTimeout(function () {
            var modalBody = document.getElementById('transcriptModalBody');
            if (modalBody && modalBody.contains(firstMark)) {
                var markRect = firstMark.getBoundingClientRect();
                var bodyRect = modalBody.getBoundingClientRect();
                var relativeTop = markRect.top - bodyRect.top + modalBody.scrollTop;
                modalBody.scrollTop = Math.max(0, relativeTop - 60);
            } else {
                firstMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 300);
    }

    function _attachTranscriptSelectionShare(body, lectureNr, lang) {
        // Remove old share bubble if any
        var old = document.getElementById('transcriptShareBubble');
        if (old) old.remove();

        body.addEventListener('mouseup', function (e) {
            // Don't remove bubble if user is clicking on it (click fires after mouseup)
            var existingBubble = document.getElementById('transcriptShareBubble');
            if (existingBubble && existingBubble.contains(e.target)) return;

            var sel = window.getSelection();
            var text = (sel && sel.toString() || '').trim();
            // Remove old bubble
            if (existingBubble) existingBubble.remove();

            if (!text || text.length < 5) return;

            // Create share bubble near selection
            var range = sel.getRangeAt(0);
            var rect = range.getBoundingClientRect();
            var bodyRect = body.getBoundingClientRect();

            var bubble = document.createElement('button');
            bubble.id = 'transcriptShareBubble';
            bubble.className = 'transcript-share-bubble';
            bubble.textContent = '🔗 ' + i18n.t('shareQuote');
            bubble.style.top = (rect.bottom - bodyRect.top + body.scrollTop + 6) + 'px';
            bubble.style.left = (rect.left - bodyRect.left + rect.width / 2) + 'px';
            body.appendChild(bubble);

            bubble.addEventListener('click', function (e) {
                e.stopPropagation();
                e.preventDefault();
                var url = buildShareUrl(lectureNr, text, lang);
                var title = (document.getElementById('transcriptModalTitle') || {}).textContent || '';
                var preview = text.substring(0, 60).replace(/\s+/g, ' ').trim();
                var copyText = 'Quote from:\n"' + title + '"\n\n📖 «' + preview + (text.length > 60 ? '...' : '') + '»\n' + url;
                var bbl = bubble; // keep ref

                function done() {
                    showCopyToast();
                    bbl.remove();
                }

                function fallback() {
                    var ta = document.createElement('textarea');
                    ta.value = copyText;
                    ta.style.position = 'fixed';
                    ta.style.opacity = '0';
                    document.body.appendChild(ta);
                    ta.focus();
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    done();
                }

                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(copyText).then(done).catch(fallback);
                } else {
                    fallback();
                }
            });
        });

        // Remove bubble on click elsewhere (but not on the bubble itself)
        body.addEventListener('mousedown', function (e) {
            var bubble = document.getElementById('transcriptShareBubble');
            if (bubble && !bubble.contains(e.target)) bubble.remove();
        });
    }

    function closeTranscriptModal(event) {
        if (!event || event.target === document.getElementById('transcriptModalOverlay')) {
            document.getElementById('transcriptModalOverlay').classList.remove('active');
            var dlBtn = document.getElementById('transcriptDownloadBtn');
            if (dlBtn) dlBtn.style.display = 'none';
            _currentTranscriptCtx = null;
        }
    }

    function searchCitationSource(sourceName) {
        setSearchMode('citations');
        showVerseList(sourceName);
    }

    // Legacy citation search (for manual text search in Verses mode)
    function performCitationSearch(startTime) {
        if (!usingSqlite) {
            document.getElementById('resultsInfo').innerHTML = '<strong>Citation search requires SQLite</strong>';
            return;
        }

        var parsed = search.parseSearchQuery(lastSearchTerm);
        var q = search.buildCitationSQL(parsed);

        db.queryMetaAsync(q.sql, q.params).then(function (results) {
            var elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
            document.getElementById('timer').textContent = i18n.t('elapsedTime') + ' ' + elapsed + ' ' + i18n.t('seconds');

            if (q.mode === 'stats') {
                showVerseSources();
            } else {
                document.getElementById('resultsInfo').innerHTML = '<strong>' + results.length + ' ' + i18n.t('citationResults') + '</strong>';
                ui.renderCitationResults(results, lastSearchTerm);
            }
        }).catch(function (err) {
            console.error('Citation search error:', err);
            document.getElementById('resultsInfo').innerHTML = '<strong>Error: ' + utils.escapeHtml(err.message) + '</strong>';
        });
    }

    // ===== TOP 108 CITATIONS =====
    function showTopCitations() {
        if (!usingSqlite) {
            document.getElementById('resultsInfo').innerHTML = '<strong>Top citations require SQLite</strong>';
            return;
        }

        closeAllPanels();
        var div = document.getElementById('topCitationsList');
        var resultsTable = document.getElementById('resultsTable');
        if (resultsTable) resultsTable.style.display = 'none';

        db.queryMetaAsync(
            "SELECT reference, COUNT(*) as lecture_count " +
            "FROM verse_citations " +
            "GROUP BY reference " +
            "ORDER BY lecture_count DESC " +
            "LIMIT 108"
        ).then(function (rows) {
            var resultsInfo = document.getElementById('resultsInfo');
            resultsInfo.innerHTML = '';
            document.getElementById('timer').textContent = '';

            var esc = utils.escapeHtml;
            var enc = utils.encodeForAttr;
            var html = '<button class="verse-sources-hide-btn" onclick="PPP.app.hideTopCitations()">' +
                utils.escapeHtml(i18n.t('hideTopCitationsBtn')) + '</button>' +
                '<div style="padding:6px 14px 14px;overflow-y:auto;max-height:60vh;">';
            rows.forEach(function (row, idx) {
                var ref = row.reference || '';
                var cnt = row.lecture_count || 0;
                html += '<div class="recommendation-item">' +
                    '<span class="recommendation-name">' +
                    '<span style="color:var(--primary-dark);font-weight:600;margin-right:6px;">' + (idx + 1) + '.</span>' +
                    esc(ref) +
                    ' <span style="color:var(--primary-dark);font-weight:700;">(' + cnt + ')</span>' +
                    '</span>' +
                    '<button class="recommendation-search-btn" onclick="PPP.app.showVerseLectures(decodeURIComponent(\'' + enc(ref) + '\'))">Yes</button>' +
                    '</div>';
            });
            html += '</div>';

            div.innerHTML = html;
            div.style.display = 'block';
            document.getElementById('pagination').innerHTML = '';
        }).catch(function (err) {
            console.error('Top citations error:', err);
            document.getElementById('resultsInfo').innerHTML = '<strong>Error: ' + utils.escapeHtml(err.message) + '</strong>';
        });
    }

    function hideTopCitations() {
        var div = document.getElementById('topCitationsList');
        var resultsTable = document.getElementById('resultsTable');
        if (div) div.style.display = 'none';
        if (resultsTable) resultsTable.style.display = '';
    }

    // ===== FILTER HELPERS =====
    function applyHasFilter(col) {
        document.getElementById('searchTerm').value = 'has:' + col;
        lastSearchTerm = 'has:' + col;
        currentPage = 1;
        performSearch();
    }

    function applySubjectFilter(subj) {
        document.getElementById('searchTerm').value = 'subject:' + subj;
        lastSearchTerm = 'subject:' + subj;
        currentPage = 1;
        document.getElementById('topicsList').style.display = 'none';
        document.getElementById('recommendationsList').style.display = 'none';
        var _rt = document.getElementById('resultsTable'); if (_rt) _rt.style.display = '';
        performSearch();
    }

    function applyLangFilter(lang) {
        document.getElementById('searchTerm').value = 'lang:' + lang;
        lastSearchTerm = 'lang:' + lang;
        currentPage = 1;
        document.getElementById('recommendationsList').style.display = 'none';
        var _rt = document.getElementById('resultsTable'); if (_rt) _rt.style.display = '';
        performSearch();
    }

    function applySourceFilter(src) {
        document.getElementById('searchTerm').value = '@' + src;
        lastSearchTerm = '@' + src;
        currentPage = 1;
        document.getElementById('sourcesList').style.display = 'none';
        performSearch();
    }

    // ===== LANGUAGE =====
    function setLanguage(lang) {
        track('language', { lang: lang });
        i18n.setLanguage(lang);
        document.querySelectorAll('.lang-btn').forEach(function (btn) {
            btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
        });
        document.querySelectorAll('[data-i18n]').forEach(function (el) {
            var key = el.getAttribute('data-i18n');
            var val = i18n.t(key);
            if (val !== key) el.textContent = val;
        });
        var luEl = document.getElementById('dbLastUpdate');
        if (luEl && luEl.getAttribute('data-last-update')) {
            luEl.textContent = (i18n.t('lastUpdate') || 'Last update') + ': ' + luEl.getAttribute('data-last-update');
        }
        document.querySelector('h1').textContent = i18n.t('pageTitle');
        if (dataLoaded) {
            var inp = document.getElementById('searchTerm');
            if (searchMode === 'citations' || searchMode === 'citationsTop') {
                inp.placeholder = i18n.t('quotesSearchHint');
            } else {
                var count = totalLectures || DB.length;
                inp.placeholder = i18n.t('searchPlaceholder').replace('{count}', count.toLocaleString());
            }
        }
        localStorage.setItem('preferredLanguage', lang);
        updateFavoritesCount();
        if (allResults.length > 0) displayResults();
        else ui.renderEmptyTable();
    }

    // ===== HELP MODAL =====
    function openHelpModal() {
        document.getElementById('helpModalTitle').textContent = i18n.t('helpModalTitle');
        document.getElementById('helpModalBody').innerHTML = i18n.t('helpContent');
        document.getElementById('helpModalOverlay').classList.add('active');
    }

    function closeHelpModal(event) {
        if (!event || event.target === document.getElementById('helpModalOverlay'))
            document.getElementById('helpModalOverlay').classList.remove('active');
    }

    // ===== INSTALL BANNER =====
    function showInstallBanner(mode) {
        installMode = mode || 'ios';
        var banner = document.getElementById('installBanner');
        var textEl = document.getElementById('installText');
        var btnEl = document.getElementById('installBtn');
        textEl.textContent = i18n.t('installBannerText');
        if (installMode === 'native') {
            btnEl.textContent = 'Install';
            btnEl.setAttribute('onclick', 'PPP.app.installApp()');
        } else {
            btnEl.textContent = i18n.t('installBtn');
            btnEl.setAttribute('onclick', 'PPP.app.showInstallInstruction()');
        }
        banner.style.display = 'block';
    }

    function installApp() {
        if (deferredPrompt) {
            track('pwa-install');
            deferredPrompt.prompt();
            deferredPrompt.userChoice.then(function () {
                deferredPrompt = null;
                document.getElementById('installBanner').style.display = 'none';
            });
        }
    }

    function showInstallInstruction() {
        var overlay = document.createElement('div');
        overlay.className = 'ios-install-overlay';
        overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };
        var steps;
        if (installMode === 'android') {
            steps = '<p><b>1.</b> ' + i18n.t('androidStep1') + '</p>' +
                '<p><b>2.</b> ' + i18n.t('androidStep2') + '</p>' +
                '<p><b>3.</b> ' + i18n.t('androidStep3') + '</p>' +
                '<p><b>4.</b> ' + i18n.t('androidStep4') + '</p>';
        } else {
            steps = '<p><b>1.</b> ' + i18n.t('iosStep1') + '</p>' +
                '<p><b>2.</b> ' + i18n.t('iosStep2') + '</p>' +
                '<p><b>3.</b> ' + i18n.t('iosStep3') + '</p>' +
                '<p><b>4.</b> ' + i18n.t('iosStep4') + '</p>';
        }
        overlay.innerHTML = '<div class="ios-install-card">' +
            '<div class="share-icon">' + (installMode === 'android' ? '\u22ee' : '\u2B06\uFE0F') + '</div>' +
            steps +
            '<button onclick="this.closest(\'.ios-install-overlay\').remove()">' + i18n.t('iosGotIt') + '</button>' +
            '</div>';
        document.body.appendChild(overlay);
    }

    function dismissInstall() {
        document.getElementById('installBanner').style.display = 'none';
        localStorage.setItem('installDismissed', '1');
    }

    // ===== PUBLIC API =====
    return {
        init: init,
        search: doSearch,
        setLanguage: setLanguage,
        showLatestFiles: showLatestFiles,
        showBy2026: showBy2026,
        showLatestTranscripts: showLatestTranscripts,
        showAllTranscriptsByDate: showAllTranscriptsByDate,
        showRecommendations: showRecommendations,
        showTopics: showTopics,
        showSources: showSources,
        applyHasFilter: applyHasFilter,
        applySubjectFilter: applySubjectFilter,
        applyLangFilter: applyLangFilter,
        applySourceFilter: applySourceFilter,
        openHelpModal: openHelpModal,
        closeHelpModal: closeHelpModal,
        installApp: installApp,
        showInstallInstruction: showInstallInstruction,
        dismissInstall: dismissInstall,
        setSearchMode: setSearchMode,
        searchCitationSource: searchCitationSource,
        showVerseSources: showVerseSources,
        showVerseList: showVerseList,
        showVerseLectures: showVerseLectures,
        showTopCitations: showTopCitations,
        hideTopCitations: hideTopCitations,
        openTranscriptAtVerse: openTranscriptAtVerse,
        openHtmlTranscriptViewer: openHtmlTranscriptViewer,
        closeTranscriptModal: closeTranscriptModal,
        downloadTranscript: downloadTranscript,
        showFavorites: showFavorites,
        updateFavoritesCount: updateFavoritesCount,
        copyShareLink: copyShareLink,
        buildShareUrl: buildShareUrl,
        toggleTheme: toggleTheme,
        openGuide: function () {
            var lang = localStorage.getItem('preferredLanguage') || 'en';
            window.open('guide/' + lang + '/', '_blank');
        }
    };
})();

// ===== Auto-init on DOM ready =====
document.addEventListener('DOMContentLoaded', function () {
    PPP.app.init();
});
