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
    // ===== MULTI-SELECT → ZIP STATE =====
    // Checkboxes are ALWAYS visible next to selectable transcript chips (no
    // select-mode). Ticking any checkbox enables the "Download selected (N)"
    // button; clicking that button opens the top download panel.
    var selectedNrs = new Set();        // Set of "<nr>|<lang>" keys (per lecture x language) selected for ZIP
    var _selResultsRef = null;          // identity of the result set selection belongs to
    var _zipAbort = null;               // AbortController for an in-flight ZIP download
    var _panelOpen = false;             // is the top download panel currently open?
    var dataLoaded = false;
    var usingSqlite = false;        // true if SQLite loaded successfully
    var searchMode = 'metadata';    // 'metadata', 'citations', or 'citationsTop'
    // ---- Single-active button state (Rājan "confusing mode" fix) ----
    // Three independent button GROUPS, each shows exactly one active button:
    //  A) In Titles / In Text   -> textSearchMode ('metadata' | 'sentences'),
    //     sticky so one text mode always stays highlighted even in a verse view.
    //  B) top nav row (By 2026 / By Added / Top Searches / By Verse /
    //     Verses (Top) / Favorites) -> navView (a data-navview id, or null when
    //     a plain text search is showing).
    //  C) By Date / By Topic / Newest (transcripts header, built in ui.js)
    //     -> transcriptView ('byDate' | 'byTopic' | 'newest' | null).
    var textSearchMode = 'metadata';
    var navView = null;
    var transcriptView = null;
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

    // ===== NETWORK STATE =====
    // Tiny shared flag + listeners: offline guards (ZIP, Drive, MP3 links)
    // read PPP.net.online instead of probing navigator each time, and the
    // #connectionStatus line shows a badge while offline.
    var net = { online: navigator.onLine };
    PPP.net = net;

    function _renderConnectionState() {
        var el = document.getElementById('connectionStatus');
        if (!el) return;
        if (net.online) {
            el.textContent = '';
        } else {
            el.textContent = i18n.t('offlineBadge');
        }
    }

    window.addEventListener('online', function () {
        net.online = true;
        _renderConnectionState();
    });
    window.addEventListener('offline', function () {
        net.online = false;
        _renderConnectionState();
    });

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
        _renderConnectionState();

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
                // Group B highlight: verse buttons live in the top nav row and
                // ARE a browse view; In Titles/In Text are plain text search and
                // clear the top-nav highlight. Group C also resets.
                if (mode === 'citations') navView = 'citations';
                else if (mode === 'citationsTop') navView = 'citationsTop';
                else navView = null; // metadata / sentences
                transcriptView = null;
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

        // S94: swipe hint disabled — mobile results are cards now (nothing to swipe).
        // initMobileSwipeHint();
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
     * Startup dispatcher.
     * NEW (offline PWA): when the browser supports the offline store
     * (IndexedDB + DecompressionStream + SW) the app runs from the installed
     * IndexedDB library — first visit shows a confirmation button, downloads
     * everything once, later visits open instantly from IDB and check for
     * delta updates in the background.
     * Unsupported browsers keep the EXACT legacy behavior (network SQLite,
     * XLSX/CSV fallback).
     */
    function loadData() {
        var store = PPP.offlineStore;
        if (!store || !store.supported() || !PPP.downloader) {
            loadDataLegacy();
            return;
        }
        store.open().then(function () {
            return store.getState('localManifest');
        }).then(function (localManifest) {
            if (localManifest) {
                // Installed — open instantly from IDB, then check for deltas.
                return openFromIdb().then(function () {
                    if (navigator.onLine) backgroundUpdateCheck();
                });
            }
            // PARTIAL install (interrupted download). A half-downloaded library
            // used to give zero offline capability; it no longer does. When the
            // two core files landed, the meta DB is in IDB and the app opens
            // FULLY offline — individual missing transcripts fall back to the
            // network inside openHtmlTranscriptViewer (fetchTranscriptFile,
            // guarded by net.online), so nothing breaks while the rest arrives.
            // CRITICAL: this path never writes localManifest — offline
            // usability here comes from the presence of the records, not from
            // the manifest fence (which must keep meaning "complete install").
            return Promise.all([
                PPP.downloader.getResumeState ? PPP.downloader.getResumeState() : null,
                PPP.downloader.isCoreReady ? PPP.downloader.isCoreReady() : false
            ]).then(function (res) {
                var resume = res[0];
                var coreReady = res[1];
                if (resume && coreReady) {
                    // The app opens offline, but the library is NOT complete —
                    // the info panel must say "continue", not "all downloaded".
                    _offlinePartial = true;
                    return openFromIdb().then(function () {
                        // Continue the SAME selection the user originally
                        // chose, in the background, with visible progress.
                        if (navigator.onLine) startBackgroundInstall(resume.langs, resume.shards);
                        else _ensureInstallListeners(resume.langs, resume.shards);
                    });
                }
                if (resume) {
                    // Core not there yet — today's behaviour (online app), but
                    // the interrupted install resumes by itself.
                    loadDataLegacy();
                    if (navigator.onLine) startBackgroundInstall(resume.langs, resume.shards);
                    else _ensureInstallListeners(resume.langs, resume.shards);
                    return;
                }
                // ONLINE is the base experience: load online immediately (fully usable).
                // The offline download is OPTIONAL and offered only via the small
                // "Work offline" button once the online DB is ready (see
                // loadDataLegacy() -> onDataLoaded() -> maybeShowOfflineWorkButton()),
                // never as an upfront banner while the DB is still loading.
                loadDataLegacy();
                var auto = false; try { auto = localStorage.getItem('ppp_auto_install') === '1'; } catch (e) {}
                if (auto) { startBackgroundInstall(); }   // test/CI hook keeps exercising install
                return;
            });
        }).catch(function (err) {
            console.warn('Offline store startup failed, using legacy load:', err);
            loadDataLegacy();
        });
    }

    /**
     * Legacy load path (pre-offline behavior, unchanged): network SQLite via
     * sql.js, XLSX/CSV fallback. Kept for browsers without the offline store.
     */
    function loadDataLegacy() {
        // Show progress bar
        ui.showLoading(i18n.t('loadingDB'));

        loadSqlite().then(function () {
            // App is USABLE as soon as the meta DB is ready — do not block
            // readiness on the large extras JSON (S94 perf fix).
            ui.hideLoading();
            usingSqlite = true;
            onDataLoaded();

            // Online DB is ready — NOW (not before) it's safe to offer the
            // optional offline install. No-op if the offline store/downloader
            // isn't supported (true legacy browsers) or install already ran.
            maybeShowOfflineWorkButton();

            // Load extras (essence/summary/title translations) in the
            // background AFTER the app is ready; refresh visible results
            // when done so essence/summary data appears. On failure one
            // automatic retry is scheduled (S95 fix — mobile network hiccup
            // used to permanently hide essence/summary for the session).
            startExtrasLoad();
        }).catch(function (sqliteErr) {
            console.warn('SQLite load failed, falling back to XLSX:', sqliteErr);
            ui.hideLoading();
            // Offline guard: the XLSX/CSV fallback is remote-only — pointless
            // (and noisy) without a connection.
            if (!net.online) {
                ui.showLoading(i18n.t('requiresInternet'));
                return;
            }
            loadXlsxFallback();
        });
    }

    /**
     * Shared post-open chain: stats, in-memory DB[] array, last-update line.
     */
    function _loadMetaIntoApp() {
        return db.getStatsAsync().then(function (stats) {
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
     * Load SQLite database via sql.js (legacy network path).
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
            return _loadMetaIntoApp();
        });
    }

    // ===== OFFLINE LIBRARY (first install / open-from-IDB / delta updates) =====

    /**
     * Open the app entirely from the installed IndexedDB library. Same
     * stats/SELECT flow as the legacy path — only the bytes come from IDB.
     */
    function openFromIdb() {
        ui.showLoading(i18n.t('openingDB'));
        return db.initSqlJs().then(function () {
            return db.loadMetaDB(); // IDB-first inside db.js
        }).then(function () {
            return _loadMetaIntoApp();
        }).then(function () {
            ui.hideLoading();
            usingSqlite = true;
            onDataLoaded();
            // Offline-ready status for the (separate) SW step: data is served
            // from IDB; the shell is offline-capable once a SW controls us.
            PPP.offlineStatus = {
                dataReady: true,
                shellReady: !!(navigator.serviceWorker && navigator.serviceWorker.controller)
            };
            // Installed path: show the offline status button in its ✓ state
            // (the old code never showed the button here — Rājan UX fix).
            maybeShowOfflineWorkButton(true);
            startExtrasLoad(); // reads core:extras from IDB (ui.js)
        });
    }

    // ---- Language selection (offline pack picker) --------------------------

    var LANG_LABELS = { en: 'English', lv: 'Latviešu', ru: 'Русский', it: 'Italiano', fr: 'Français', es: 'Español' };
    function _langLabel(l) { return LANG_LABELS[l] || String(l).toUpperCase(); }

    /**
     * Opt-in languages present in a manifest (EN excluded, it is the mandatory
     * base), in a stable display order (LV, RU first, then any others).
     */
    function _optInLangsFromManifest(manifest) {
        var seen = {};
        (manifest.packs || []).forEach(function (p) {
            if (p.lang && p.lang !== 'en') seen[p.lang] = true;
        });
        var out = [];
        ['lv', 'ru'].forEach(function (l) { if (seen[l]) { out.push(l); delete seen[l]; } });
        Object.keys(seen).forEach(function (l) { out.push(l); });
        return out;
    }

    // Cache the EN-base size (MB) so the offline-first-run/offer copy can show a
    // computed value even before a manifest is fetched this session.
    function _cacheBaseMB(manifest) {
        try {
            var mb = Math.round(PPP.downloader.computeInstallBytes(manifest, []) / 1048576);
            if (mb > 0) localStorage.setItem('ppp_base_mb', String(mb));
        } catch (e) {}
    }
    function _baseMB() {
        try { var v = parseInt(localStorage.getItem('ppp_base_mb'), 10); if (v > 0) return v; } catch (e) {}
        return 151; // EN base fallback (core + prem-en + raw-en ≈ 150.8 MB)
    }

    /**
     * Test/CI hook: ppp_install_langs (JSON array) selects opt-in languages for
     * the auto-install path; when absent the auto path installs EVERYTHING (all
     * opt-in languages) to preserve the legacy full-library install the
     * regression suite depends on. Real users choose via the checkboxes.
     */
    function _autoInstallLangs(manifest) {
        try {
            var raw = localStorage.getItem('ppp_install_langs');
            if (raw) {
                var arr = JSON.parse(raw);
                if (Array.isArray(arr)) return arr.filter(function (l) { return l && l !== 'en'; });
            }
        } catch (e) {}
        return _optInLangsFromManifest(manifest);
    }

    /**
     * Test/CI hook: ppp_install_shards === '1' opts the auto-install path into
     * the sentence shards (offline text search). Real users choose via the
     * "Offline text search" checkbox. Default OFF — shards are opt-in.
     */
    function _autoInstallShards() {
        try { return localStorage.getItem('ppp_install_shards') === '1'; } catch (e) { return false; }
    }

    /**
     * Build a language-selection widget. opts:
     *   langList    — languages shown as checkboxes (default: opt-in langs)
     *   baseChecked — prepend a disabled, checked EN "base" row
     *   preselected — languages initially ticked
     *   sizeMode    — 'total' (core+EN+selected) | 'delta' (only selected packs)
     *   shardToggle — add the opt-in "Offline text search" (sentence shards)
     *                 checkbox (default unchecked); getIncludeShards() reads it
     * Returns { el, getLangs, getIncludeShards }. getLangs() reads the ticked
     * opt-in langs; getIncludeShards() reads the shard checkbox (false when the
     * toggle is absent). The live size label recomputes from BOTH the language
     * selection and the shard toggle via computeInstallBytes.
     */
    function _buildLangSelector(manifest, opts) {
        opts = opts || {};
        var langList = opts.langList || _optInLangsFromManifest(manifest);
        var pre = {};
        (opts.preselected || []).forEach(function (l) { pre[l] = true; });

        var wrap = document.createElement('div');
        wrap.className = 'offline-lang-select';
        var shardCb = null;   // set when the shard toggle is rendered
        var sizeLabel = document.createElement('div');
        sizeLabel.className = 'offline-lang-size';

        function selectedLangs() {
            var out = [];
            var cbs = wrap.querySelectorAll('input[type="checkbox"][data-lang]');
            for (var i = 0; i < cbs.length; i++) {
                var cb = cbs[i];
                if (cb.checked && cb.getAttribute('data-lang') !== 'en') out.push(cb.getAttribute('data-lang'));
            }
            return out;
        }
        function includeShards() { return !!(shardCb && shardCb.checked); }
        function refreshSize() {
            var sel = selectedLangs();
            var bytes = PPP.downloader.computeInstallBytes(manifest, sel, includeShards());
            if (opts.sizeMode === 'delta') bytes -= PPP.downloader.computeInstallBytes(manifest, []);
            var mb = Math.round(bytes / 1048576);
            sizeLabel.textContent = i18n.t('offlineSizeSelected').replace('{size}', mb);
        }

        function addRow(lang, base) {
            var lbl = document.createElement('label');
            lbl.className = 'offline-lang-row';
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.setAttribute('data-lang', lang);
            if (base) { cb.checked = true; cb.disabled = true; }
            else { cb.checked = !!pre[lang]; cb.onchange = refreshSize; }
            var span = document.createElement('span');
            span.textContent = _langLabel(lang) + (base ? ' (' + i18n.t('offlineLangBase') + ')' : '');
            lbl.appendChild(cb);
            lbl.appendChild(span);
            wrap.appendChild(lbl);
        }

        function addShardRow() {
            var lbl = document.createElement('label');
            lbl.className = 'offline-lang-row offline-shard-row';
            shardCb = document.createElement('input');
            shardCb.type = 'checkbox';
            shardCb.setAttribute('data-shard', '1');
            shardCb.checked = false;              // opt-in — unchecked by default
            shardCb.onchange = refreshSize;
            var span = document.createElement('span');
            span.textContent = i18n.t('offlineTextSearch');
            lbl.appendChild(shardCb);
            lbl.appendChild(span);
            wrap.appendChild(lbl);
        }

        if (opts.baseChecked) addRow('en', true);
        langList.forEach(function (l) { addRow(l, false); });
        if (opts.shardToggle) addShardRow();
        wrap.appendChild(sizeLabel);
        refreshSize();
        return { el: wrap, getLangs: selectedLangs, getIncludeShards: includeShards };
    }

    /**
     * First-run flow: fetch the manifest, show the download-confirmation
     * button with a per-language selection (EN base + opt-in packs), then
     * install with a single byte-weighted progress bar.
     */
    function startFirstInstallFlow() {
        if (!navigator.onLine) {
            // First run offline — nothing to open yet; explain, and retry
            // automatically the moment a connection appears.
            ui.showLoading(i18n.t('offlineFirstRun').replace('{size}', String(_baseMB())));
            window.addEventListener('online', function retryInstall() {
                window.removeEventListener('online', retryInstall);
                loadData();
            });
            return Promise.resolve();
        }
        return PPP.downloader.fetchManifest().then(function (manifest) {
            _cacheBaseMB(manifest);
            // Prompt headline shows the EN-only base size; ticking LV/RU grows it.
            var sizeMB = Math.round(PPP.downloader.computeInstallBytes(manifest, []) / (1024 * 1024));
            // TEST HOOK: Playwright sets localStorage ppp_auto_install=1 so
            // headless runs exercise the REAL install flow without a click.
            var auto = false;
            try { auto = localStorage.getItem('ppp_auto_install') === '1'; } catch (e) {}
            if (auto) return beginInstall(manifest, _autoInstallLangs(manifest), _autoInstallShards());
            showInstallPrompt(manifest, sizeMB);
        }).catch(function (err) {
            console.warn('Manifest fetch failed, using legacy load:', err);
            loadDataLegacy();
        });
    }

    function showInstallPrompt(manifest, sizeMB) {
        _cacheBaseMB(manifest);
        ui.showLoading(i18n.t('installPrompt').replace('{size}', sizeMB));
        ui.updateProgress(0);
        var bar = document.getElementById('progressBar');
        if (!bar) return;
        var old = document.getElementById('installOfflineBtn');
        if (old) old.remove();
        var oldSel = document.getElementById('installLangSelect');
        if (oldSel) oldSel.remove();

        // EN mandatory base + LV/RU opt-in checkboxes + opt-in offline text
        // search (sentence shards), with a live size label.
        var selector = _buildLangSelector(manifest, { baseChecked: true, sizeMode: 'total', shardToggle: true });
        selector.el.id = 'installLangSelect';
        bar.appendChild(selector.el);

        var btn = document.createElement('button');
        btn.id = 'installOfflineBtn';
        btn.type = 'button';
        btn.className = 'search-button';
        btn.style.marginTop = '8px';
        btn.textContent = i18n.t('installButton');
        btn.onclick = function () {
            var langs = selector.getLangs();
            var incShards = selector.getIncludeShards();
            selector.el.remove();
            btn.remove();
            beginInstall(manifest, langs, incShards);
        };
        bar.appendChild(btn);
    }

    // Capture-phase click interceptor active DURING the first install:
    // interactions outside the loading area answer with a "still
    // downloading — X%" toast instead of half-working on missing data.
    var _installPct = 0;
    function _installGuardHandler(e) {
        var bar = document.getElementById('progressBar');
        if (bar && bar.contains(e.target)) return;
        var el = e.target.closest ? e.target.closest('button, input, a, select') : null;
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        ui.toast(i18n.t('stillDownloading').replace('{pct}', _installPct));
    }

    // ---- Install continuity (single flight, auto-retry, wake lock) ---------
    // A phone download of ~139 MB is routinely interrupted: the screen sleeps,
    // the tab is backgrounded, the network flaps. These three helpers make the
    // install survive all of it — exactly ONE install runs at a time, it is
    // retried automatically the moment the device is online and visible, and
    // the screen is (best-effort) kept awake while it runs.
    var _installInFlight = false;
    var _installListenersOn = false;
    var _retryLangs = null;         // selection to resume with (null = default)
    var _retryShards = false;
    var _wakeLock = null;

    function _acquireWakeLock() {
        // Advisory only: unsupported browsers, denied permission or a hidden
        // document must never break the install, hence the blanket try/catch.
        try {
            if (_wakeLock) return;
            if (!(navigator.wakeLock && navigator.wakeLock.request)) return;
            navigator.wakeLock.request('screen').then(function (lock) {
                _wakeLock = lock;
                lock.addEventListener('release', function () { _wakeLock = null; });
            }).catch(function () {});
        } catch (e) {}
    }

    function _releaseWakeLock() {
        try {
            if (_wakeLock && _wakeLock.release) _wakeLock.release().catch(function () {});
        } catch (e) {}
        _wakeLock = null;
    }

    function _installRetryTick() {
        // De-duplication: the guard is the single source of truth, so an
        // 'online' burst plus a visibilitychange can never start two pools.
        if (_installInFlight || !navigator.onLine) return;
        startBackgroundInstall(_retryLangs, _retryShards);
    }

    function _onlineRetryHandler() { _installRetryTick(); }

    function _visibilityRetryHandler() {
        if (document.visibilityState !== 'visible') return;
        if (_installInFlight) {
            // Coming back to the foreground: the OS drops the screen wake lock
            // whenever the document is hidden, so re-request it.
            _acquireWakeLock();
            return;
        }
        _installRetryTick();
    }

    /**
     * Arm the automatic-retry listeners for the remaining install work and
     * remember the selection they should resume with. Idempotent.
     */
    function _ensureInstallListeners(langs, includeShards) {
        if (langs != null) _retryLangs = langs;
        if (includeShards != null) _retryShards = includeShards;
        if (_installListenersOn) return;
        _installListenersOn = true;
        window.addEventListener('online', _onlineRetryHandler);
        document.addEventListener('visibilitychange', _visibilityRetryHandler);
    }

    /** Remove the retry listeners — only on a fully successful install. */
    function _removeInstallListeners() {
        if (!_installListenersOn) return;
        _installListenersOn = false;
        window.removeEventListener('online', _onlineRetryHandler);
        document.removeEventListener('visibilitychange', _visibilityRetryHandler);
    }

    /**
     * Bytes already on the device according to a resume state: every completed
     * core file / pack / shard records its own size, so the "already
     * downloaded" figure needs no manifest lookup.
     */
    function _resumeDoneBytes(install) {
        var bytes = 0;
        ['completedCore', 'completedPacks', 'completedShards'].forEach(function (group) {
            var map = install && install[group];
            if (!map) return;
            Object.keys(map).forEach(function (id) {
                bytes += (map[id] && map[id].size) || 0;
            });
        });
        return bytes;
    }

    /**
     * Short human-readable diagnostic for a partial-install error: the first
     * failing item's name + underlying error (and a "+N" for the rest).
     * Appended to the interrupted copy so a field report can pinpoint WHICH
     * item and WHICH stage (HTTP / size or sha256 mismatch / IndexedDB write)
     * keeps failing — before this, the toast only said how many MB were left.
     */
    function _installFailDetail(err) {
        var items = (err && err.failedItems) || [];
        if (!items.length) return '';
        var first = items[0];
        var extra = items.length > 1 ? ' +' + (items.length - 1) : '';
        return ' [' + first.name + ': ' + first.error + extra + ']';
    }

    function beginInstall(manifest, langs, includeShards) {
        _installPct = 0;
        document.addEventListener('click', _installGuardHandler, true);
        ui.showLoading(i18n.t('downloadingAll'));
        ui.updateProgress(0);

        var totalMB = Math.round(PPP.downloader.computeInstallBytes(manifest, langs, includeShards) / (1024 * 1024));
        _installInFlight = true;
        _ensureInstallListeners(langs, includeShards);
        _acquireWakeLock();
        return PPP.downloader.firstInstall(function (p) {
            var frac = p.totalBytes ? p.loadedBytes / p.totalBytes : 0;
            _installPct = Math.round(frac * 100);
            ui.updateProgress(frac);
            ui.setLoadingText(i18n.t('downloadingAll') + ' ' +
                Math.round(p.loadedBytes / (1024 * 1024)) + ' / ' + totalMB + ' MB');
        }, langs, includeShards).then(function () {
            document.removeEventListener('click', _installGuardHandler, true);
            _installInFlight = false;
            _offlinePartial = false;
            _removeInstallListeners();
            _releaseWakeLock();
            PPP.offlineStore.requestPersist();
            return openFromIdb();
        }).catch(function (err) {
            document.removeEventListener('click', _installGuardHandler, true);
            _installInFlight = false;
            _releaseWakeLock();
            console.error('Offline install failed:', err);
            if (err && err.notEnoughStorage) {
                ui.showLoading(i18n.t('notEnoughStorage').replace('{size}', totalMB));
                return;
            }
            if (err && err.partial) {
                // Some items failed but the rest IS on the device and the
                // resume state survived. Never fail silently: say what is left
                // and that it continues by itself (the retry listeners stay
                // armed), then give the user the best app we can right now —
                // the offline one when the core landed.
                var leftMB = Math.max(1, Math.round(
                    (((err.totalBytes || 0) - (err.doneBytes || 0)) / 1048576)));
                _offlinePartial = true;
                ui.hideLoading();
                if (err.failedItems) console.error('Offline install failed items:', JSON.stringify(err.failedItems));
                if (err.quotaExceeded) {
                    // The device is out of storage — an automatic retry can
                    // only repeat the exact same failing write (the iPad
                    // 69%→79%→69% loop). Disarm the auto-resume listeners and
                    // say the real cause; a manual retry / next boot still
                    // resumes from the durable install state.
                    _removeInstallListeners();
                    ui.toast(i18n.t('offlineStorageFull').replace('{left}', String(leftMB)));
                } else {
                    ui.toast(i18n.t('offlineInterrupted').replace('{left}', String(leftMB)) +
                        _installFailDetail(err));
                }
                return PPP.downloader.isCoreReady().then(function (ready) {
                    if (ready) return openFromIdb();
                    loadDataLegacy();
                });
            }
            // Partial progress is durable (resume state) — next start resumes.
            // For THIS session, fall back to the legacy network path so the
            // user is never stuck on a broken screen.
            ui.hideLoading();
            loadDataLegacy();
        });
    }

    // Whether the offline library is installed (localManifest present /
    // install finished this session) — drives the #offlineWorkBtn state:
    // not installed = download offer, installed = "Offline ✓" status button.
    var _offlineInstalled = false;

    // True when the app runs offline-capable from a PARTIAL library (core
    // present, packs still missing). openFromIdb flips _offlineInstalled to
    // its ✓ state on this path too — which is honest about "offline works" —
    // but the info panel must still offer "continue the download", not claim
    // the library is complete. Cleared when an install finishes fully.
    var _offlinePartial = false;

    /**
     * Reveal the small "Work offline" button (next to "How to use search?")
     * once the database is ready — on BOTH paths: legacy/online load (offer
     * state) and openFromIdb (installed state, `installed` flag true). Never
     * shown while the DB is still loading — that was the old bug (big banner
     * popping up mid-"Loading database…"). No-op if the offline install
     * feature isn't available. The session "dismissed" flag only suppresses
     * the OFFER state; the installed ✓ status button always shows so the
     * user can see offline already works for them.
     *
     * Browsers without DecompressionStream/IndexedDB/serviceWorker (old
     * Safari/iOS, old Chrome) can never use the offline store — that's the
     * `!store.supported()` branch below. Those users used to get silence
     * (button just never appeared, no explanation). Now they get a single
     * quiet note in the button's place so they know WHY there's no offline
     * option, instead of assuming the app is broken.
     */
    function maybeShowOfflineWorkButton(installed) {
        var store = PPP.offlineStore;
        if (!store || !store.supported()) {
            _showOfflineUnsupportedNote();
            return;
        }
        if (!PPP.downloader) return;
        if (installed) _offlineInstalled = true;
        var btn = document.getElementById('offlineWorkBtn');
        if (!btn) return;
        if (_offlineInstalled) {
            // Installed state: label with ✓; swap the data-i18n key so a
            // later language switch keeps the installed label.
            btn.setAttribute('data-i18n', 'offlineReadyBtn');
            btn.textContent = i18n.t('offlineReadyBtn');
            btn.style.display = '';
            return;
        }
        try {
            if (sessionStorage.getItem('ppp_offline_offer_dismissed') === '1') return;
        } catch (e) {}
        btn.style.display = '';
    }

    /**
     * Unsupported-browser explanation, shown ONCE in the same spot the
     * "Work offline" button would otherwise sit (inside .search-time, next
     * to "How to use search?"). No CSS class needed: a plain <span> there
     * already inherits .search-time's muted/small styling (11px,
     * var(--text-muted)), so it reads as a quiet hint, not an error banner.
     * Idempotent via the element id — safe to call more than once (loadData
     * only reaches here after the DB is ready, so it never races the
     * loading state, but maybeShowOfflineWorkButton() is also invoked from a
     * couple of other spots and must not duplicate the note).
     */
    function _showOfflineUnsupportedNote() {
        if (document.getElementById('offlineUnsupportedNote')) return;
        var btn = document.getElementById('offlineWorkBtn');
        if (!btn || !btn.parentNode) return;
        var note = document.createElement('span');
        note.id = 'offlineUnsupportedNote';
        note.setAttribute('data-i18n', 'offlineUnsupported');
        note.textContent = i18n.t('offlineUnsupported');
        btn.parentNode.insertBefore(note, btn.nextSibling);
    }

    /**
     * Click on #offlineWorkBtn: toggle the info panel (size/time text +
     * Download button) open/closed underneath the button.
     */
    function toggleOfflineInfoPanel() {
        var panel = document.getElementById('offlineInfoPanel');
        if (!panel) return;
        var isOpen = panel.style.display !== 'none' && panel.style.display !== '';
        if (isOpen) {
            closeOfflineInfoPanel();
        } else {
            renderOfflineInfoPanel();
            panel.style.display = 'flex';
        }
    }

    /**
     * Close (and clear) the info panel. Deliberately does NOT touch
     * #offlineProgress — an in-flight download keeps showing there even
     * after the info panel is closed (S: progress persistence fix).
     */
    function closeOfflineInfoPanel() {
        var panel = document.getElementById('offlineInfoPanel');
        if (!panel) return;
        panel.style.display = 'none';
        panel.innerHTML = '';
    }

    function _appendCloseBtn(panel) {
        var closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.textContent = '×';
        closeBtn.style.cssText = 'background:none;border:none;font-size:18px;cursor:pointer;line-height:1;padding:0 4px;';
        closeBtn.onclick = function () {
            closeOfflineInfoPanel();
            // Offer state: remember the dismissal for this session (hides the
            // button). Installed state: only close the panel — the ✓ status
            // button must stay visible.
            if (!_offlineInstalled) {
                try { sessionStorage.setItem('ppp_offline_offer_dismissed', '1'); } catch (e) {}
            }
        };
        panel.appendChild(closeBtn);
    }

    /**
     * Installed state UI: list installed languages (EN base + any opt-in) and,
     * for languages not yet downloaded, a checkbox picker + "Add language"
     * button that pulls just those packs into the existing library.
     */
    function _renderAddLanguageUI(panel) {
        var holder = document.createElement('div');
        holder.id = 'offlineAddLangs';
        panel.appendChild(holder);
        Promise.all([
            PPP.downloader.fetchManifest(),
            PPP.downloader.getInstalledLangs()
        ]).then(function (res) {
            var manifest = res[0], installed = res[1];
            if (!document.body.contains(holder)) return;
            _cacheBaseMB(manifest);
            holder.innerHTML = '';

            var line = document.createElement('div');
            line.className = 'offline-lang-installed';
            var names = ['en'].concat(installed).map(_langLabel).join(', ');
            line.textContent = i18n.t('offlineLangsInstalled').replace('{langs}', names);
            holder.appendChild(line);

            var available = _optInLangsFromManifest(manifest).filter(function (l) {
                return installed.indexOf(l) === -1;
            });
            if (available.length === 0) return;

            var selector = _buildLangSelector(manifest, { langList: available, sizeMode: 'delta' });
            holder.appendChild(selector.el);

            var addBtn = document.createElement('button');
            addBtn.type = 'button';
            addBtn.id = 'offlineAddLangBtn';
            addBtn.className = 'search-button';
            addBtn.textContent = i18n.t('offlineAddLangBtn');
            addBtn.onclick = function () {
                var toAdd = selector.getLangs();
                if (toAdd.length === 0) return;
                _runAddLanguages(toAdd, holder);
            };
            holder.appendChild(addBtn);
        }).catch(function (e) { console.warn('Add-language UI failed:', e); });
    }

    function _runAddLanguages(toAdd, holder) {
        holder.innerHTML = '';
        var msg = document.createElement('span');
        msg.textContent = i18n.t('offlineDownloading')
            .replace('{loaded}', '0').replace('{total}', '?').replace('{pct}', '0');
        holder.appendChild(msg);
        PPP.downloader.addLanguages(toAdd, function (p) {
            var mb = Math.round(p.loadedBytes / 1048576);
            var totalMB = Math.round(p.totalBytes / 1048576);
            var pct = p.totalBytes ? Math.round(p.loadedBytes / p.totalBytes * 100) : 0;
            msg.textContent = i18n.t('offlineDownloading')
                .replace('{loaded}', mb).replace('{total}', totalMB).replace('{pct}', pct);
        }).then(function () {
            holder.innerHTML = '';
            var done = document.createElement('span');
            done.textContent = i18n.t('offlineLangAdded');
            holder.appendChild(done);
            var reloadBtn = document.createElement('button');
            reloadBtn.type = 'button';
            reloadBtn.className = 'search-button';
            reloadBtn.textContent = i18n.t('offlineReloadBtn');
            reloadBtn.onclick = function () { location.reload(); };
            holder.appendChild(reloadBtn);
        }).catch(function (err) {
            console.error('Add language failed:', err);
            holder.innerHTML = '';
            var em = document.createElement('span');
            em.textContent = i18n.t('offlineOfferError');
            holder.appendChild(em);
        });
    }

    function renderOfflineInfoPanel() {
        var panel = document.getElementById('offlineInfoPanel');
        if (!panel) return;
        panel.innerHTML = '';

        if (_offlineInstalled && !_offlinePartial) {
            var rtext = document.createElement('span');
            rtext.textContent = i18n.t('offlineReadyText');
            panel.appendChild(rtext);
            _renderAddLanguageUI(panel);
            _appendCloseBtn(panel);
            return;
        }

        // Offer state: headline size (EN base) + language picker + Download.
        var baseMB = _baseMB();
        var text = document.createElement('span');
        text.textContent = i18n.t('offlineInfoText')
            .replace('{size}', String(baseMB))
            .replace('{min}', String(Math.max(1, Math.round(baseMB / 10))));
        panel.appendChild(text);

        var selHolder = document.createElement('div');
        selHolder.id = 'offlineOfferLangs';
        panel.appendChild(selHolder);

        // Selection is read at click time; defaults to EN-only + shards OFF
        // until the manifest arrives and the checkboxes render.
        var getLangs = function () { return []; };
        var getIncludeShards = function () { return false; };
        // Set by the resume check below; both blocks are async, so the
        // from-scratch copy must never overwrite the resume copy.
        var hasResume = false;
        PPP.downloader.fetchManifest().then(function (manifest) {
            _cacheBaseMB(manifest);
            if (!document.body.contains(selHolder)) return;
            var selector = _buildLangSelector(manifest, { baseChecked: true, sizeMode: 'total', shardToggle: true });
            selHolder.innerHTML = '';
            selHolder.appendChild(selector.el);
            getLangs = selector.getLangs;
            getIncludeShards = selector.getIncludeShards;
            if (hasResume) { selHolder.style.display = 'none'; return; }
            var mb = Math.round(PPP.downloader.computeInstallBytes(manifest, []) / 1048576);
            text.textContent = i18n.t('offlineInfoText')
                .replace('{size}', String(mb))
                .replace('{min}', String(Math.max(1, Math.round(mb / 10))));
        }).catch(function () {});

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'offlineOfferBtn';
        btn.className = 'search-button';
        btn.textContent = i18n.t('offlineOfferBtn');
        btn.onclick = function () { startBackgroundInstall(getLangs(), getIncludeShards()); };
        panel.appendChild(btn);

        // Interrupted install: offering the full base size "as if from
        // scratch" would be a lie — those megabytes are already on the device
        // and are not downloaded again. Show what is done vs. the total of the
        // ORIGINAL selection, and continue exactly that selection (so the
        // language picker is hidden — the choice was already made).
        if (PPP.downloader.getResumeState) {
            PPP.downloader.getResumeState().then(function (resume) {
                if (!resume || !document.body.contains(btn)) return;
                hasResume = true;
                selHolder.style.display = 'none';
                btn.textContent = i18n.t('offlineResumeBtn');
                btn.onclick = function () { startBackgroundInstall(resume.langs, resume.shards); };
                var doneMB = Math.round(_resumeDoneBytes(resume.install) / 1048576);
                text.textContent = i18n.t('offlineResumeText')
                    .replace('{done}', String(doneMB))
                    .replace('{total}', '?');
                return PPP.downloader.fetchManifest().then(function (manifest) {
                    if (!document.body.contains(text)) return;
                    var totalMB = Math.round(PPP.downloader.computeInstallBytes(
                        manifest, resume.langs, resume.shards) / 1048576);
                    text.textContent = i18n.t('offlineResumeText')
                        .replace('{done}', String(doneMB))
                        .replace('{total}', String(totalMB));
                });
            }).catch(function () {});
        }

        _appendCloseBtn(panel);
    }

    /**
     * Optional, non-blocking offline install. Progress/completion render
     * ONLY inside #offlineProgress (below #offlineWorkBtn) — independent of
     * #offlineInfoPanel, so closing the info panel mid-download does not
     * hide progress. The app itself stays fully usable throughout (no click
     * guard, no full-screen loading overlay).
     */
    function startBackgroundInstall(langs, includeShards) {
        if (!PPP.downloader) return Promise.resolve();
        // Single flight: boot auto-resume, the online/visibility retries and a
        // manual Download click all land here — never run two pools at once.
        if (_installInFlight) return Promise.resolve();
        _installInFlight = true;
        _ensureInstallListeners(langs, includeShards);
        _acquireWakeLock();

        var box = document.getElementById('offlineProgress');
        if (box) {
            box.style.display = 'flex';
            box.innerHTML = '';
            var msg = document.createElement('span');
            msg.id = 'offlineProgressMsg';
            msg.textContent = i18n.t('offlineDownloading')
                .replace('{loaded}', '0').replace('{total}', '?').replace('{pct}', '0');
            box.appendChild(msg);
        }

        return PPP.downloader.fetchManifest().then(function (manifest) {
            _cacheBaseMB(manifest);
            // Selection: explicit arg wins; otherwise the auto/CI hook installs
            // the full library, and a real user with no arg gets the EN base.
            var sel = langs;
            var incShards = includeShards;
            if (sel == null) {
                var auto = false;
                try { auto = localStorage.getItem('ppp_auto_install') === '1'; } catch (e) {}
                sel = auto ? _autoInstallLangs(manifest) : [];
                if (incShards == null) incShards = auto ? _autoInstallShards() : false;
            }
            if (incShards == null) incShards = false;
            // Remember the RESOLVED selection so an automatic retry continues
            // the same library, not the EN-only default.
            _retryLangs = sel;
            _retryShards = incShards;
            var totalMB = Math.round(PPP.downloader.computeInstallBytes(manifest, sel, incShards) / 1048576);
            return PPP.downloader.firstInstall(function (p) {
                var mb = Math.round(p.loadedBytes / 1048576);
                var pct = p.totalBytes ? Math.round(p.loadedBytes / p.totalBytes * 100) : 0;
                var m = document.getElementById('offlineProgressMsg');
                if (m) {
                    m.textContent = i18n.t('offlineDownloading')
                        .replace('{loaded}', mb).replace('{total}', totalMB).replace('{pct}', pct);
                }
            }, sel, incShards).then(function () {
                _installInFlight = false;
                _offlinePartial = false;
                _removeInstallListeners();
                _releaseWakeLock();
                PPP.offlineStore.requestPersist();
                // Install finished this session — flip the status button to
                // its installed ✓ state right away.
                maybeShowOfflineWorkButton(true);
                var b = document.getElementById('offlineProgress');
                if (b) {
                    b.innerHTML = '';
                    var readyMsg = document.createElement('span');
                    readyMsg.textContent = i18n.t('offlineReady');
                    b.appendChild(readyMsg);
                    var reloadBtn = document.createElement('button');
                    reloadBtn.type = 'button';
                    reloadBtn.className = 'search-button';
                    reloadBtn.textContent = i18n.t('offlineReloadBtn');
                    reloadBtn.onclick = function () { location.reload(); };
                    b.appendChild(reloadBtn);
                }
            });
        }).catch(function (err) {
            _installInFlight = false;
            _releaseWakeLock();
            // Listeners stay armed on failure — that is the whole point: the
            // remaining work restarts by itself once online and visible.
            console.error('Background offline install failed:', err);
            var b = document.getElementById('offlineProgress');
            if (b) {
                b.style.display = 'flex';
                b.innerHTML = '';
                var errMsg = document.createElement('span');
                if (err && err.partial) {
                    // Interrupted, not lost: say how much is left and that it
                    // continues automatically (the Retry button stays as a
                    // manual shortcut). With the failing item + stage appended,
                    // so the loop is never an anonymous "X MB left".
                    _offlinePartial = true;
                    if (err.failedItems) console.error('Offline install failed items:', JSON.stringify(err.failedItems));
                    var leftMB = Math.max(1, Math.round(
                        (((err.totalBytes || 0) - (err.doneBytes || 0)) / 1048576)));
                    if (err.quotaExceeded) {
                        // Storage full: retrying automatically only repeats
                        // the same failing IndexedDB write — stop the loop and
                        // name the real cause. Manual Retry stays available.
                        _removeInstallListeners();
                        errMsg.textContent = i18n.t('offlineStorageFull').replace('{left}', String(leftMB));
                    } else {
                        errMsg.textContent = i18n.t('offlineInterrupted').replace('{left}', String(leftMB)) +
                            _installFailDetail(err);
                    }
                } else {
                    errMsg.textContent = i18n.t('offlineOfferError');
                }
                b.appendChild(errMsg);
                var retryBtn = document.createElement('button');
                retryBtn.type = 'button';
                retryBtn.className = 'search-button';
                retryBtn.textContent = i18n.t('offlineOfferBtn');
                // Retry the SAME selection that failed, not the EN-only default.
                retryBtn.onclick = function () { startBackgroundInstall(_retryLangs, _retryShards); };
                b.appendChild(retryBtn);
            }
        });
    }

    /**
     * Background delta check (installed state, online). Applies changed
     * packs/core files to IDB, then refreshes the running app in place.
     */
    function backgroundUpdateCheck() {
        PPP.downloader.checkForUpdates().then(function (res) {
            if (!res || !res.changedItems) return;
            ui.showUpdateNote(i18n.t('updatedItems').replace('{n}', res.changedItems));
            if (res.coreChanged && res.coreChanged.meta) {
                // Re-open the meta DB from the fresh IDB copy and re-run the
                // in-memory load; refresh visible results in place.
                db.reloadMetaFromStore().then(function (reloaded) {
                    if (!reloaded) return;
                    return _loadMetaIntoApp().then(function () {
                        // Refresh the count placeholder and visible results in
                        // place (no onDataLoaded — that would re-run deep-link
                        // handling and clear the current view). Centralized
                        // helper only touches the placeholder when it's
                        // relevant to the currently active mode.
                        updateSearchModePlaceholder();
                        if (allResults.length > 0) displayResults();
                    });
                }).catch(function (e) { console.warn('Meta refresh failed:', e); });
            }
            if (res.coreChanged && res.coreChanged.extras) {
                if (ui.clearExtrasCache) ui.clearExtrasCache();
                startExtrasLoad();
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
        // Centralized — respects whatever mode the user already switched to
        // while the DB was still loading in the background (race fix).
        updateSearchModePlaceholder();
        // Don't clobber a non-metadata frame (e.g. sentence-mode header) the
        // user already switched to while this load was still in flight.
        if (searchMode === 'metadata') ui.renderEmptyTable();
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
        if (_sentenceSearchBusy) { ui.toast(i18n.t('searchInProgress')); return; }
        var term = document.getElementById('searchTerm').value.trim();
        if (!dataLoaded) return;
        // Allow empty search in citations mode (shows stats overview)
        if (!term && searchMode !== 'citations' && searchMode !== 'citationsTop') return;
        setActiveCollection(null);
        // A typed search is not a browse view / transcript sort — clear both so
        // the top-nav and By Date/Topic/Newest highlights don't linger. Verse
        // modes keep their nav highlight (the search IS the verse view).
        if (searchMode === 'metadata' || searchMode === 'sentences') navView = null;
        transcriptView = null;
        _refreshButtonGroups();
        lastSearchTerm = term;
        currentPage = 1;
        performSearch();
    }

    function performSearch() {
        var startTime = performance.now();
        // Multi-select UI belongs to the lecture table only. Hide it now; lecture
        // modes call displayResults() which re-shows the toggle for the fresh set.
        _showSelectToggle(false);
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

        if (searchMode === 'sentences') {
            performSentenceSearch(startTime);
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

    // ===== EXTRAS BACKGROUND LOAD (essence / summary / title translations) =====
    // extras.json is large (~13 MB gzipped over the wire) and loads AFTER app
    // readiness (S94 perf fix). Until it arrives, essence lines and summary
    // links do not exist — show a small indicator and retry once on failure.
    var _extrasRetryScheduled = false;

    function _extrasIndicatorEl(create) {
        var el = document.getElementById('extrasLoadingInfo');
        if (!el && create) {
            var info = document.getElementById('resultsInfo');
            if (!info || !info.parentNode) return null;
            el = document.createElement('div');
            el.id = 'extrasLoadingInfo';
            // Inline styles: one small muted line, no layout jump on removal.
            el.style.cssText = 'font-size:0.8em;color:#888;margin-top:4px;';
            info.parentNode.insertBefore(el, info.nextSibling);
        }
        return el;
    }

    function showExtrasIndicator() {
        var el = _extrasIndicatorEl(true);
        if (!el) return;
        el.textContent = i18n.t('loadingExtras');
        el.style.display = 'block';
    }

    function hideExtrasIndicator() {
        var el = _extrasIndicatorEl(false);
        if (el) el.style.display = 'none';
    }

    function startExtrasLoad() {
        if (!ui.loadExtras) return;
        if (ui.extrasReady && ui.extrasReady()) {
            hideExtrasIndicator();
            return;
        }
        showExtrasIndicator();
        ui.loadExtras().then(function () {
            if (!ui.extrasReady || ui.extrasReady()) {
                // Loaded — remove the indicator and refresh visible results
                // so essence lines / summary links appear.
                hideExtrasIndicator();
                if (allResults.length > 0) displayResults();
            } else if (!_extrasRetryScheduled) {
                // First attempt failed (e.g. network hiccup on mobile) —
                // retry ONCE automatically after 20 s. Further retries happen
                // on demand: openSummaryModal() calls loadExtras() again.
                _extrasRetryScheduled = true;
                setTimeout(startExtrasLoad, 20000);
            } else {
                hideExtrasIndicator();
            }
        }).catch(function () { hideExtrasIndicator(); /* extras are optional */ });
    }

    function displayResults() {
        var startIndex = (currentPage - 1) * pageSize;
        var endIndex = Math.min(currentPage * pageSize, totalResults);

        // A new result set clears the selection. Every loader (search, favorites,
        // by-date, …) assigns a FRESH allResults array, so an identity change means
        // "new search". Pagination and language switches re-render the SAME array,
        // so the selection persists across pages within one result set.
        if (allResults !== _selResultsRef) {
            _selResultsRef = allResults;
            selectedNrs.clear();
            // Let the zip-name default repopulate from the new search term.
            var _zi = document.getElementById('zipNameInput');
            if (_zi) _zi.value = '';
        }

        document.getElementById('resultsInfo').innerHTML =
            '<strong>' + totalResults + ' ' + i18n.t('filesFound') + '</strong>&nbsp;&nbsp;&nbsp;' +
            i18n.t('showingResults') + ' ' + (totalResults === 0 ? 0 : (startIndex + 1)) + '-' + endIndex;

        ui.renderResults(allResults, lastSearchTerm, startIndex, endIndex, matchHints);
        ui.renderPagination(totalResults, currentPage, pageSize, changePage);

        _showSelectToggle(totalResults > 0);
        _updateSelectBar();
    }

    function changePage(p) {
        var totalPages = Math.ceil(totalResults / pageSize);
        if (p >= 1 && p <= totalPages) {
            currentPage = p;
            displayResults();
        }
    }

    // ===========================================================================
    // MULTI-SELECT TRANSCRIPTS -> ONE NAMED ZIP
    // Use case: search a topic, tick the lectures you want, download every
    // transcript in one named .zip for offline theme-searching. No transcript is
    // ever preloaded — raw/premium bodies are fetched ONLY on demand here.
    // ===========================================================================

    var MP3_ZIP_MAX_COUNT = 5; // maks. MP3 skaits uz vienu ZIP (pārlūka atmiņas aizsardzība; 5 × ~80MB worst-case)

    // --- ui.js reads these to render + reflect the per-language checkboxes ---
    function _selKey(nr, lang) { return String(nr) + '|' + String(lang).toLowerCase(); }
    function isSelectedPair(nr, lang) { return selectedNrs.has(_selKey(nr, lang)); }

    // A transcript language cell is selectable when it holds a real premium OR raw
    // value — not empty, not N/A, not a duplicate pointer, not "Not relevant".
    function _langCellAvailable(val) {
        var v = (val || '').toString().trim();
        if (!v || v === 'N/A' || v === '0') return false;
        var EXCLUDE = {
            'Not relevant': 1, 'Neattiecas': 1, 'Не относится': 1,
            'Duplicate': 1, 'Dublikāts': 1, 'Дубликат': 1, 'Дубикат': 1
        };
        return !EXCLUDE[v];
    }

    // Distinct lecture count behind the currently selected pairs.
    function _distinctNrCount() {
        var seen = {};
        selectedNrs.forEach(function (k) { seen[k.split('|')[0]] = 1; });
        return Object.keys(seen).length;
    }

    // Show/hide the "Download selected" button wrapper. Shown only when the
    // current result set has lecture rows; hidden (and panel closed) otherwise.
    function _showSelectToggle(show) {
        var wrap = document.getElementById('selectToggleWrap');
        if (wrap) wrap.style.display = show ? '' : 'none';
        if (!show) closeDownloadPanel();
        _updateDownloadSelectedBtn();
    }

    // Reflect the selection count on the persistent "Download selected" button:
    // disabled + base label at 0; enabled + "Download selected (N)" at ≥1.
    function _updateDownloadSelectedBtn() {
        var btn = document.getElementById('downloadSelectedBtn');
        if (!btn) return;
        btn.title = i18n.t('downloadSelectedTip');   // localized tooltip; re-set on language change
        var n = selectedNrs.size;
        if (n > 0) {
            btn.disabled = false;
            btn.classList.remove('disabled');
            btn.textContent = i18n.t('downloadSelectedBtnN').replace('{n}', n);
        } else {
            btn.disabled = true;
            btn.classList.add('disabled');
            btn.textContent = i18n.t('downloadSelectedBtn');
        }
    }

    // Count how many MP3 pairs are currently selected.
    function _selectedMp3Count() {
        var n = 0;
        selectedNrs.forEach(function (k) { if (k.split('|')[1] === 'mp3') n++; });
        return n;
    }

    // Toggle one (lecture x language) transcript in/out of the selection.
    // Returns true if the toggle was applied, false if it was refused (hard
    // MP3_ZIP_MAX_COUNT cap hit) — the caller (ui.js checkbox onchange) must
    // then reset the checkbox back to unchecked.
    function toggleSelectPair(nr, lang, checked) {
        var key = _selKey(nr, lang);
        if (checked) {
            // Hard block: never let the selection exceed MP3_ZIP_MAX_COUNT MP3s.
            if (String(lang).toLowerCase() === 'mp3' && !selectedNrs.has(key) && _selectedMp3Count() >= MP3_ZIP_MAX_COUNT) {
                ui.toast(i18n.t('mp3ZipMaxCount').replace('{max}', MP3_ZIP_MAX_COUNT));
                return false;
            }
            selectedNrs.add(key);
        } else {
            selectedNrs.delete(key);
        }
        _updateDownloadSelectedBtn();
        _updateSelectBar();   // refresh panel count if it is open
        return true;
    }

    // Clear the whole selection (unchecks every box on re-render) and close panel.
    function clearSelection() {
        selectedNrs.clear();
        closeDownloadPanel();
        if (allResults.length > 0) displayResults();
        else _updateDownloadSelectedBtn();
    }

    function _defaultZipName() {
        var base = _sanitizeFilename(lastSearchTerm || '');
        if (!base || base === 'transcript') {
            var d = new Date();
            var pad = function (n) { return (n < 10 ? '0' : '') + n; };
            base = 'transcripts_' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
        }
        return base;
    }

    // Open the top download panel (only meaningful when ≥1 transcript is selected).
    function openDownloadPanel() {
        if (selectedNrs.size === 0) return;   // button is disabled in this state
        _panelOpen = true;
        var bar = document.getElementById('selectActionBar');
        if (bar) { bar.removeAttribute('data-summary'); bar.style.display = ''; }
        var progRow = document.getElementById('zipProgressRow');
        if (progRow) progRow.style.display = 'none';
        _updateSelectBar();   // fills count + default zip name
        var input = document.getElementById('zipNameInput');
        if (input) { input.placeholder = i18n.t('zipNamePlaceholder'); if (!input.value) input.value = _defaultZipName(); input.focus(); }
    }

    // Close/dismiss the panel. Keeps the selection intact so the button stays
    // enabled and the panel can be reopened.
    function closeDownloadPanel() {
        _panelOpen = false;
        var bar = document.getElementById('selectActionBar');
        if (bar) { bar.style.display = 'none'; bar.removeAttribute('data-summary'); }
    }

    // Refresh the panel body (count + zip-name default) while it is open.
    function _updateSelectBar() {
        if (!_panelOpen) return;
        var bar = document.getElementById('selectActionBar');
        if (!bar) return;
        if (bar.getAttribute('data-summary') === '1') return; // keep post-download summary
        var count = selectedNrs.size;
        if (count === 0) { closeDownloadPanel(); return; } // nothing left to download
        var summaryRow = document.getElementById('zipSummaryRow');
        if (summaryRow) { summaryRow.style.display = 'none'; summaryRow.textContent = ''; }
        var countEl = document.getElementById('selectCount');
        if (countEl) {
            // Split the selection by key space: "<nr>|mp3" picks are MP3
            // audio, everything else is a transcript — never count MP3s as
            // transcripts in the panel headline (Rājan fix). Lecture count
            // stays distinct-nr across the WHOLE selection.
            var mp3Sel = 0;
            selectedNrs.forEach(function (k) { if (k.split('|')[1] === 'mp3') mp3Sel++; });
            var trSel = count - mp3Sel;
            var lect = _distinctNrCount();
            var summaryTxt;
            if (trSel > 0 && mp3Sel > 0) {
                summaryTxt = i18n.t('zipPanelSummaryMixed')
                    .replace('{t}', trSel).replace('{a}', mp3Sel).replace('{m}', lect);
            } else if (mp3Sel > 0) {
                summaryTxt = i18n.t('zipPanelSummaryMp3')
                    .replace('{a}', mp3Sel).replace('{m}', lect);
            } else {
                summaryTxt = i18n.t('nSelectedPairs')
                    .replace('{t}', trSel).replace('{l}', lect);
            }
            countEl.textContent = summaryTxt;
        }
        var input = document.getElementById('zipNameInput');
        if (input) {
            input.placeholder = i18n.t('zipNamePlaceholder');
            if (!input.value) input.value = _defaultZipName();
        }
        bar.style.display = '';
    }

    // --- progress + summary UI ---
    function _setZipDownloading(on) {
        var row = document.getElementById('zipProgressRow');
        if (row) row.style.display = on ? '' : 'none';
        var dlBtn = document.getElementById('zipDownloadBtn');
        if (dlBtn) dlBtn.disabled = !!on;
    }

    function _setZipProgress(done, total) {
        var fill = document.getElementById('zipProgressFill');
        if (fill) fill.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
        var txt = document.getElementById('zipProgressText');
        if (txt) txt.textContent = i18n.t('downloadingProgress').replace('{done}', done).replace('{total}', total);
    }

    // ZIP-assembly phase (after all fetches): reuse the progress row for "Creating ZIP…".
    function _setZipCreating(percent) {
        var p = percent || 0;
        var row = document.getElementById('zipProgressRow');
        if (row) row.style.display = '';
        var fill = document.getElementById('zipProgressFill');
        if (fill) fill.style.width = p + '%';
        var txt = document.getElementById('zipProgressText');
        if (txt) txt.textContent = i18n.t('zipCreating').replace('{percent}', p);
    }

    function _showZipSummary(msg) {
        var bar = document.getElementById('selectActionBar');
        var row = document.getElementById('zipSummaryRow');
        if (row) { row.textContent = msg; row.style.display = ''; }
        if (bar) { bar.style.display = ''; bar.setAttribute('data-summary', '1'); }
    }

    function _zipTargetLang() {
        return (i18n.getLanguage && i18n.getLanguage()) || 'en';
    }

    function _findDbRowByNr(nr) {
        nr = String(nr);
        for (var i = 0; i < DB.length; i++) {
            if ((DB[i]['Nr.'] || '').toString().trim() === nr) return DB[i];
        }
        return null;
    }

    // Batch-fetch title + raw EN Drive URL + MP3 Drive URL for every selected nr up front.
    function _fetchZipMeta(nrs) {
        if (usingSqlite && db && db.queryMetaAsync) {
            var placeholders = nrs.map(function () { return '?'; }).join(',');
            var sql = "SELECT nr, original_file_name, script_en_url, dwnld_url FROM lectures WHERE nr IN (" + placeholders + ")";
            return db.queryMetaAsync(sql, nrs).then(function (rows) {
                var map = {};
                rows.forEach(function (r) {
                    map[String(r.nr)] = { title: r.original_file_name || '', enUrl: r.script_en_url || '', dwnldUrl: r.dwnld_url || '' };
                });
                return map;
            }).catch(function () { return {}; });
        }
        // In-memory fallback (no SQLite): read titles/URLs from the mapped DB array.
        var m = {};
        nrs.forEach(function (nr) {
            var row = _findDbRowByNr(nr);
            if (row) m[String(nr)] = {
                title: (row['Original file name'] || '').toString(),
                enUrl: (row['Script_EN_url'] || '').toString(),
                dwnldUrl: (row['Dwnld._url'] || '').toString()
            };
        });
        return Promise.resolve(m);
    }

    // Add one lecture's transcript to the zip.
    // Returns true (added), 'unavailable' (nothing offline / MP3 count cap
    // hit), or throws on abort. `zipCtx` carries cross-item ZIP state —
    // currently just the running MP3 count (see MP3_ZIP_MAX_COUNT).
    function _addOneToZip(zip, folder, nr, lang, meta, signal, zipCtx) {
        var title = (meta && meta.title ? meta.title : ('Nr_' + nr)).toString();
        var safeTitle = _sanitizeFilename(title);

        // MP3 pick: fetch the lecture's audio from Drive (binary), not a transcript.
        if (lang === 'mp3') {
            var mp3Id = _driveIdFromUrl(meta && meta.dwnldUrl);
            if (!mp3Id) return Promise.resolve('unavailable');
            // Safety net: the checkbox hard-block already prevents selecting
            // more than MP3_ZIP_MAX_COUNT MP3s, but re-check here in case that
            // block was ever bypassed (e.g. a future caller of downloadSelectedZip).
            if (zipCtx && zipCtx.mp3Count >= MP3_ZIP_MAX_COUNT) {
                zipCtx.mp3CapHit = true;
                return Promise.resolve('unavailable');
            }
            var mp3Key = (PPP.config && PPP.config.driveApiKey) || '';
            var mp3Url = 'https://www.googleapis.com/drive/v3/files/' + mp3Id + '?alt=media&key=' + encodeURIComponent(mp3Key);
            return fetch(mp3Url, { signal: signal }).then(function (rr) {
                if (rr.status === 200 || rr.status === 206) {
                    return rr.arrayBuffer().then(function (buf) {
                        if (zipCtx) zipCtx.mp3Count++;
                        zip.file(folder + '/Nr_' + nr + '_' + safeTitle + '.mp3', buf, { binary: true });
                        return true;
                    });
                }
                return 'unavailable';
            });
        }

        // Sentence-search two-tier highlight: only non-empty when this ZIP was
        // triggered from an "In Transcripts" search result (see performSentenceSearch).
        var matchedSentences = _sentenceMatchesByNr[String(nr)] || [];
        return fetch('transcripts/' + lang + '/' + encodeURIComponent(String(nr)) + '.html', { signal: signal })
            .then(function (r) { return r.ok ? r.text() : ''; })
            .then(function (html) {
                if (html && html.trim()) {
                    // Premium per-lecture HTML (same-origin) — wrap into a standalone doc.
                    var htmlOut = html;
                    if (matchedSentences.length && typeof DOMParser !== 'undefined') {
                        try {
                            var parsedDoc = new DOMParser().parseFromString(html, 'text/html');
                            _wrapMatchesInContainer(parsedDoc.body, matchedSentences, _sentenceWords);
                            htmlOut = parsedDoc.body.innerHTML;
                        } catch (ex) { /* fall back to the unmodified premium html */ }
                    }
                    var doc = _buildHtmlDoc({ nr: nr, lang: lang, title: title, html: htmlOut });
                    // nr in the filename prevents collisions when two lectures share a title.
                    zip.file(folder + '/Nr_' + nr + '_' + safeTitle + '_' + lang + '.html', doc);
                    return true;
                }
                // Premium missing (404 / empty). Raw fallback exists only in EN.
                if (lang === 'en') {
                    var id = _driveIdFromUrl(meta && meta.enUrl);
                    if (!id) return 'unavailable';
                    var key = (PPP.config && PPP.config.driveApiKey) || '';
                    var url = 'https://www.googleapis.com/drive/v3/files/' + id + '?alt=media&key=' + encodeURIComponent(key);
                    return fetch(url, { signal: signal }).then(function (rr) {
                        if (rr.status === 200) {
                            return rr.text().then(function (txt) {
                                // Wrap raw plain text into <p> paragraphs so the same
                                // DOM-based highlighter can mark sentences/words, then
                                // save as HTML (was .txt) so highlighting is visible.
                                var paragraphs = (txt || '').split(/\r?\n/).map(function (line) {
                                    return '<p>' + utils.escapeHtml(line) + '</p>';
                                }).join('\n');
                                var container = document.createElement('div');
                                container.innerHTML = paragraphs;
                                if (matchedSentences.length) {
                                    _wrapMatchesInContainer(container, matchedSentences, _sentenceWords);
                                }
                                var rawDoc = _buildHtmlDoc({ nr: nr, lang: 'en', title: title, html: container.innerHTML });
                                zip.file(folder + '/Nr_' + nr + '_' + safeTitle + '_EN_raw.html', rawDoc);
                                return true;
                            });
                        }
                        return 'unavailable';
                    });
                }
                return 'unavailable';
            });
    }

    function downloadSelectedZip(zipName) {
        // Offline guard: ZIP assembly fetches transcript bodies (and raw
        // fallbacks from the Drive API) over the network.
        if (!net.online) {
            ui.toast(i18n.t('requiresInternet'));
            return Promise.resolve();
        }
        if (typeof JSZip === 'undefined') {
            _showZipSummary(i18n.t('zipNothing'));
            return Promise.resolve();
        }
        var pairs = Array.from(selectedNrs);   // "<nr>|<lang>" keys
        if (pairs.length === 0) return Promise.resolve();

        // Codex fix #3: warn before very large selections (memory / slowness).
        if (pairs.length > 100) {
            if (!window.confirm(i18n.t('zipLargeWarn').replace('{n}', pairs.length))) return Promise.resolve();
        }

        // MP3 selection is already hard-capped at MP3_ZIP_MAX_COUNT by the
        // checkbox toggle (toggleSelectPair) — nothing further to confirm here.
        // The safety-net re-check lives in _addOneToZip via zipCtx below.

        var input = document.getElementById('zipNameInput');
        var name = (zipName != null ? zipName : (input ? input.value : '')) || _defaultZipName();
        var folder = _sanitizeFilename(name);

        // One batched meta lookup for every DISTINCT nr in the selection.
        var nrSet = {};
        pairs.forEach(function (p) { nrSet[p.split('|')[0]] = 1; });
        var nrs = Object.keys(nrSet);

        var zip = new JSZip();
        var abort = new AbortController();
        _zipAbort = abort;                     // Codex fix #1: capture the local controller
        var total = pairs.length, done = 0, included = 0, unavailable = 0;
        // Cross-item ZIP state: running MP3 count, enforced against
        // MP3_ZIP_MAX_COUNT inside _addOneToZip (safety net; the checkbox
        // hard-block is the primary gate — see toggleSelectPair).
        var zipCtx = { mp3Count: 0, mp3CapHit: false };

        _setZipDownloading(true);
        _setZipProgress(0, total);

        return _fetchZipMeta(nrs).then(function (metaByNr) {
            var idx = 0;
            var CONCURRENCY = 4;

            function worker() {
                if (abort.signal.aborted || idx >= pairs.length) return Promise.resolve();
                var parts = pairs[idx++].split('|');
                var myNr = parts[0], myLang = parts[1];
                return _addOneToZip(zip, folder, myNr, myLang, metaByNr[myNr] || {}, abort.signal, zipCtx)
                    .then(function (ok) {
                        if (ok === true) included++; else unavailable++;
                    })
                    .catch(function () {
                        // Aborted or per-item network error — count it and move on.
                        unavailable++;
                    })
                    .then(function () {
                        done++;
                        _setZipProgress(done, total);
                        return worker();
                    });
            }

            var runners = [];
            for (var k = 0; k < Math.min(CONCURRENCY, pairs.length); k++) runners.push(worker());
            return Promise.all(runners);
        }).then(function () {
            // Codex fix #1: a cancel or a newer download replaced us — never mutate
            // shared UI/global state that now belongs to a different run.
            if (_zipAbort !== abort) return;
            if (abort.signal.aborted) { _setZipDownloading(false); _zipAbort = null; return; }
            if (included === 0) {
                _setZipDownloading(false); _zipAbort = null;
                _showZipSummary(i18n.t('zipNothing'));
                return;
            }
            // Codex fix #2: stay busy THROUGH generateAsync; show "Creating ZIP… %".
            return zip.generateAsync({ type: 'blob' }, function (meta) {
                if (_zipAbort !== abort) return;              // superseded/cancelled: don't touch UI
                _setZipCreating(Math.round(meta.percent));
            }).then(function (blob) {
                if (_zipAbort !== abort) return;             // superseded during ZIP assembly
                _setZipDownloading(false);
                _zipAbort = null;
                _triggerBlobDownload(blob, folder + '.zip');
                track('zip-download', { included: included, unavailable: unavailable, pairs: total, mp3CapHit: zipCtx.mp3CapHit });
                var summaryMsg = i18n.t('zipSummary')
                    .replace('{included}', included)
                    .replace('{unavailable}', unavailable);
                // Safety-net cap was hit (should not normally happen — the
                // checkbox hard-block prevents it) — tell the user.
                if (zipCtx.mp3CapHit) {
                    summaryMsg += ' ' + i18n.t('mp3ZipMaxCount').replace('{max}', MP3_ZIP_MAX_COUNT);
                }
                _showZipSummary(summaryMsg);
                // Close the panel cleanly after the summary has been shown briefly.
                setTimeout(function () { if (_zipAbort == null) closeDownloadPanel(); }, 3500);
            });
        }).catch(function (err) {
            if (_zipAbort !== abort) return;   // guard shared state for a superseded run
            _setZipDownloading(false);
            _zipAbort = null;
            console.error('ZIP download failed:', err);
            _showZipSummary(i18n.t('zipNothing'));
        });
    }

    function cancelZipDownload() {
        if (_zipAbort) _zipAbort.abort();
        _setZipDownloading(false);
        _zipAbort = null;
    }

    // ===== SEARCH MODE TOGGLE =====

    /**
     * Set the #searchTerm placeholder according to the CURRENTLY ACTIVE
     * search mode. Centralized so async paths (background meta refresh,
     * onDataLoaded, language switch) can never clobber a placeholder the
     * user already switched away from by racing an unconditional
     * "searchPlaceholder among {count} links" assignment — that's exactly
     * what happened when a user pressed "In Text" while the meta DB/count
     * was still loading in the background.
     */
    function updateSearchModePlaceholder() {
        var searchInput = document.getElementById('searchTerm');
        if (!searchInput) return;
        if (searchMode === 'citations' || searchMode === 'citationsTop') {
            searchInput.placeholder = i18n.t('quotesSearchHint');
        } else if (searchMode === 'sentences') {
            searchInput.placeholder = i18n.t('searchPlaceholderSentences');
        } else {
            var count = totalLectures || DB.length || 0;
            if (!dataLoaded && !count) {
                // Still loading and no cached count — never show "among 0 links"
                searchInput.placeholder = i18n.t('searchPlaceholderLoading');
            } else {
                searchInput.placeholder = i18n.t('searchPlaceholder').replace('{count}', count.toLocaleString());
            }
        }
    }

    // Reflect the current single-active state onto all three button groups.
    // Called from setSearchMode and from every browse/view handler so the
    // highlight always matches what the app is actually showing.
    function _refreshButtonGroups() {
        // Group A: In Titles / In Text. Active only when NOT in a browse/nav
        // view (navView null) — so browsing (By 2026 etc.) greys them out and
        // only one thing looks selected at a time.
        var kw = document.querySelector('.keywords-search-btn');
        var tx = document.querySelector('.text-search-btn');
        if (kw) kw.classList.toggle('active', !navView && !transcriptView && textSearchMode === 'metadata');
        if (tx) tx.classList.toggle('active', !navView && !transcriptView && textSearchMode === 'sentences');
        // Group B: top nav row — exactly one active iff navView matches.
        document.querySelectorAll('.main-button-row .combo-btn').forEach(function (btn) {
            btn.classList.toggle('active', !!navView && btn.getAttribute('data-navview') === navView);
        });
        // Group C (By Date/Topic/Newest) is rebuilt inside the results header on
        // every render, reading transcriptView via getTranscriptView() — so no
        // direct DOM work is needed here.
    }

    function getTranscriptView() { return transcriptView; }

    function setSearchMode(mode) {
        if (_sentenceSearchBusy) { ui.toast(i18n.t('searchInProgress')); return; }
        closeAllPanels();
        setActiveCollection(null);
        var prevMode = searchMode;
        searchMode = mode || 'metadata';
        if (prevMode !== mode) {
            track('mode-switch', { from: prevMode, to: searchMode });
            // Invalidate any in-flight performSentenceSearch: its stillCurrent()
            // check re-reads searchMode, but bumping the token too makes the
            // race fix robust even if a future edit adds more async hops that
            // only check the token. See _sentenceSearchSeq above.
            _sentenceSearchSeq++;
        }
        // Group A is sticky on the two TEXT search modes only — verse views
        // (citations/citationsTop) do not blank out the In Titles/In Text pair.
        if (searchMode === 'metadata' || searchMode === 'sentences') {
            textSearchMode = searchMode;
        }
        _refreshButtonGroups();
        // Hide verse sources panel when switching away from citations mode
        var versePanel = document.getElementById('verseSourcesList');
        if (versePanel && mode !== 'citations') {
            versePanel.style.display = 'none';
        }
        var verseList = document.getElementById('verseList');
        if (verseList && mode !== 'citations') {
            verseList.style.display = 'none';
        }
        // "List Of Sources" button + "Last update" label belong to the lecture
        // (metadata) results view — hide them in sentence ("In Text") mode.
        var topLeftBtns = document.querySelector('.top-left-buttons');
        if (topLeftBtns) topLeftBtns.style.display = (mode === 'sentences') ? 'none' : '';
        // Clear results and search field when switching modes
        if (prevMode !== mode) {
            document.getElementById('searchTerm').value = '';
            document.getElementById('resultsInfo').innerHTML = '';
            document.getElementById('timer').textContent = '';
            document.getElementById('pagination').innerHTML = '';
            // The results area must switch FRAME immediately on the mode
            // button press — localized sentence-mode headers + distinct
            // header tone for "In Text", the normal lecture-table header
            // for "In Titles" — not just clear the row and leave the old
            // header sitting there until the next search.
            if (mode === 'sentences') {
                ui.renderEmptySentenceTable();
            } else if (mode === 'metadata') {
                ui.renderEmptyTable();
            } else {
                var tbody = document.getElementById('resultsTable').querySelector('tbody');
                if (tbody) tbody.innerHTML = '<tr><td colspan="11" class="empty-result-message" data-i18n="enterSearchTerms">' + i18n.t('enterSearchTerms') + '</td></tr>';
            }
            allResults = [];
            totalResults = 0;
            lastSearchTerm = '';
            // Mode switch wiped the table — drop the stored sentence results
            // too, so a later language switch restores the empty frame, not
            // stale rows from a previous "In Text" search.
            _sentenceLastRender = null;
            // Reset the transcript selection: clear picks, hide the button + panel.
            selectedNrs.clear();
            closeDownloadPanel();
            _showSelectToggle(false);
        }
        // Update search placeholder based on mode (centralized, see
        // updateSearchModePlaceholder() above setSearchMode).
        updateSearchModePlaceholder();
        if (mode === 'citations') {
            setComboDisplay(i18n.t('byCitedVersesDisplay'));
        } else if (mode === 'citationsTop') {
            setComboDisplay(i18n.t('mostCitedVersesDisplay'));
        } else {
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
        navView = 'byAdded'; transcriptView = null;
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
        navView = 'by2026'; transcriptView = null;
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
        navView = null; transcriptView = 'newest';
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
        navView = null; transcriptView = 'byDate';
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
        navView = 'favorites'; transcriptView = null;
        _refreshButtonGroups();

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
            // Toggle OFF — panel closes, no browse view is active anymore.
            div.style.display = 'none';
            if (resultsTable) resultsTable.style.display = '';
            navView = null;
            _refreshButtonGroups();
            return;
        }
        closeAllPanels();
        if (!dataLoaded) return;
        navView = 'topSearches'; transcriptView = null;
        _refreshButtonGroups();
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
            // Toggle OFF — By Topic no longer the active transcript view.
            div.style.display = 'none';
            if (resultsTable) resultsTable.style.display = '';
            transcriptView = null;
            _refreshButtonGroups();
            return;
        }
        closeAllPanels();
        document.getElementById('recommendationsList').style.display = 'none';
        if (!dataLoaded) return;
        navView = null; transcriptView = 'byTopic';
        _refreshButtonGroups();
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
            '<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;max-width:820px;margin:1.5em auto;padding:0 1em;line-height:1.55;color:#222;background:#fff}h1,h2,h3{color:#7a1f00}a{color:#c97a00}p{margin:0.6em 0}mark.tr-sentence{background:#fff3a0}mark.tr-word{background:#b6f5c0}</style>\n' +
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
        // Offline guard: the Drive download needs the network. Fall through to
        // the client-side HTML fallback when we have the content locally.
        if (driveId && !net.online && !ctx.html) {
            ui.toast(i18n.t('requiresInternet'));
            return;
        }
        if (driveId && net.online) {
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

        // Offline-first lookup order (installed IndexedDB library):
        //   1. IDB premium t:{lang}:{nr}
        //   2. duplicate-lecture fallback (meta DB → original nr → IDB retry)
        //   3. raw:en:{nr} from IDB (EN only) — rendered with a [Raw] marker
        //   4. network per-lecture HTML file (legacy path, online only)
        //   5. offline message
        var _storeUsable = !!(PPP.offlineStore && PPP.offlineStore.supported());
        var isRawContent = false;
        // True only once a network fetch has actually been ATTEMPTED and
        // REJECTED (transport-level failure). navigator.onLine (mirrored by
        // net.online) lies on some Android PWAs — reporting "offline" while a
        // connection exists — so the offline modals below key off this real
        // failure, never the flag alone (field bug 2026-07-24, Android LTE).
        var _netFetchFailed = false;

        function storeGet(key) {
            if (!_storeUsable) return Promise.resolve(null);
            return PPP.offlineStore.getText(key).catch(function () { return null; });
        }

        function fetchTranscriptFile(nr) {
            // ALWAYS attempt the fetch — do NOT short-circuit on net.online.
            // transcripts/ is a SW passthrough (see sw.js PASSTHROUGH_PREFIXES),
            // so a genuinely offline request rejects quickly; a rejection is
            // what marks the network as truly down, not the unreliable flag.
            // A resolved-but-!ok response (e.g. 404) means the server WAS
            // reached — that is a real miss, not an offline state.
            return fetch('transcripts/' + lang + '/' + encodeURIComponent(String(nr)) + '.html')
                .then(function (r) { return r.ok ? r.text() : ''; })
                .catch(function () { _netFetchFailed = true; return ''; });
        }

        // IDB + network lookup for one nr (premium content).
        function getPremium(nr) {
            return storeGet('t:' + lang + ':' + String(nr)).then(function (txt) {
                if (txt) return txt;
                return fetchTranscriptFile(nr);
            });
        }

        var firstFetch = getPremium(lectureNr).then(function (html) {
            if (html) return [{ html_content: html }];
            // Duplicate-lecture fallback (matches the prior SQLite logic via
            // meta DB) — retry IDB (then network) with the ORIGINAL nr.
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
                return getPremium(origRows[0].nr).then(function (h) {
                    return h ? [{ html_content: h }] : [];
                });
            });
        }).then(function (rows) {
            // Raw EN transcript from the offline library (raw-only lectures).
            if (rows.length === 0 && lang === 'en') {
                return storeGet('raw:en:' + String(lectureNr)).then(function (rawTxt) {
                    if (rawTxt) {
                        isRawContent = true;
                        return [{ html_content: rawTxt }];
                    }
                    return rows;
                });
            }
            return rows;
        });

        firstFetch.then(function (rows) {
            if (rows.length === 0) {
                if (_netFetchFailed) {
                    // Nothing in IDB and the network fetch actually FAILED
                    // (transport rejection) — this is a genuine offline state.
                    // Gating on the real failure (not net.online) means a
                    // device whose navigator.onLine lies "false" while online
                    // no longer gets the offline modal after a successful or
                    // 404 fetch (field bug 2026-07-24, Android LTE).
                    if (!_offlineInstalled) {
                        title.textContent = i18n.t('requiresInternet');
                        body.textContent = i18n.t('requiresInternet');
                        return;
                    }
                    // The library IS installed, but this lookup missed. Two
                    // distinct truths (field bug 2026-07-24, Android): when the
                    // requested LANGUAGE was never selected, guide the user to
                    // the offline settings; but when the language IS installed
                    // (EN is always the mandatory base) the lecture itself is
                    // simply newer than the installed pack set — the packs are
                    // built from a snapshot, while the meta DB (which renders
                    // the buttons) updates daily, so a freshly added lecture
                    // shows a button yet has no IDB record. Saying "language
                    // not downloaded" there is false and confusing.
                    var langsP = (PPP.downloader && PPP.downloader.getInstalledLangs)
                        ? PPP.downloader.getInstalledLangs().catch(function () { return []; })
                        : Promise.resolve([]);
                    return langsP.then(function (installedLangs) {
                        var langInstalled = (lang === 'en') || installedLangs.indexOf(lang) !== -1;
                        if (langInstalled) {
                            title.textContent = i18n.t('offlineLectureNotInLibraryTitle');
                            body.textContent = i18n.t('offlineLectureNotInLibrary');
                        } else {
                            title.textContent = i18n.t('offlineLangNotDownloadedTitle');
                            body.textContent = i18n.t('offlineLangNotDownloaded');
                        }
                    });
                }
                if (driveUrl) {
                    // HTML is not in the app, but a Drive source exists. The
                    // correct copy depends on the lecture's script status for
                    // this language (query the meta DB):
                    //   'Raw'  \u2192 a genuine auto (Raw) txt transcript: keep the
                    //            raw WARNING modal.
                    //   other  \u2192 a PREMIUM transcript that simply is not in the
                    //            app yet; driveUrl points at its premium docx.
                    //            Show the neutral "available on Drive" copy \u2014
                    //            NOT the raw-accuracy disclaimer (field bug
                    //            2026-07-24).
                    var openLabel = (i18n.t && i18n.t('openInGoogleDrive')) || 'Open in Google Drive';
                    var driveAnchor = '<p><a href="' + driveUrl +
                        '" target="_blank" rel="noopener" style="color:var(--saffron)">' +
                        utils.escapeHtml(openLabel) + ' \u2197</a></p>';
                    return db.queryMetaAsync(
                        "SELECT script_" + lang + " AS st FROM lectures WHERE nr = $nr LIMIT 1",
                        { $nr: String(lectureNr) }
                    ).catch(function () { return []; }).then(function (stRows) {
                        var st = (stRows[0] && stRows[0].st) || '';
                        var isRawStatus = (String(st).trim().toLowerCase() === 'raw');
                        var mTitle, mBody;
                        if (isRawStatus) {
                            mTitle = (i18n.t && i18n.t('rawTranscriptTitle')) || 'Raw transcript (txt)';
                            mBody = (i18n.t && i18n.t('rawTranscriptBody')) ||
                                'This is a Raw transcript, available only in txt format. Open it from Google Drive.';
                        } else {
                            mTitle = (i18n.t && i18n.t('transcriptOnDriveTitle')) || 'Transcript available on Google Drive';
                            mBody = (i18n.t && i18n.t('transcriptOnDriveBody')) ||
                                'This transcript is not yet available inside the app. Open it from Google Drive.';
                        }
                        title.textContent = mTitle;
                        body.innerHTML = '<p>' + mBody.split('\n').map(function (ln) { return utils.escapeHtml(ln); }).join('<br>') + '</p>' + driveAnchor;
                    });
                }
                title.textContent = 'Transcript not found';
                body.textContent = 'No ' + lang.toUpperCase() + ' transcript for lecture Nr.' + lectureNr;
                return;
            }

            // Get title and Drive URL from meta DB
            return db.queryMetaAsync(
                "SELECT original_file_name, script_en_url, script_lv_url, script_ru_url FROM lectures WHERE nr = $nr LIMIT 1",
                { $nr: String(lectureNr) }
            ).then(function (meta) {
                var row = meta[0] || {};
                var origName = row.original_file_name || ('Nr.' + lectureNr);
                var rawPrefix = isRawContent ? ('[' + i18n.t('rawLabel') + '] ') : '';
                title.textContent = rawPrefix + origName + (reference ? ' — ' + reference : '');
                var resolvedDriveUrl = driveUrl || row['script_' + lang + '_url'] || '';
                return { origName: origName, driveUrl: resolvedDriveUrl };
            }).catch(function () {
                var rawPrefix = isRawContent ? ('[' + i18n.t('rawLabel') + '] ') : '';
                title.textContent = rawPrefix + 'Nr.' + lectureNr + (reference ? ' — ' + reference : '');
                return { origName: 'Nr_' + lectureNr, driveUrl: driveUrl || '' };
            }).then(function (info) {
                // Insert HTML content
                var htmlContent = rows[0].html_content || '';
                // Raw content (IDB raw:en:{nr} or the online Drive raw-txt
                // path) ships with a baked-in ENGLISH-only disclaimer. Prepend
                // a LOCALIZED warning box (reusing the existing rawTranscriptBody
                // key, present in all 6 languages) so an LV/RU/… user actually
                // sees the caveat. Newlines → <br>, HTML-escaped exactly like
                // the driveUrl modal above (field bug 2026-07-24).
                if (isRawContent) {
                    var warnText = (i18n.t && i18n.t('rawTranscriptBody')) || '';
                    var warnHtml = warnText.split('\n').map(function (ln) { return utils.escapeHtml(ln); }).join('<br>');
                    htmlContent = '<div style="border-left:4px solid var(--saffron);background:rgba(255,153,51,0.08);padding:10px 14px;margin:0 0 14px;border-radius:4px;font-size:0.9em;line-height:1.5;">' +
                        warnHtml + '</div>' + htmlContent;
                }
                body.innerHTML = htmlContent;

                // Raw transcript: keep the Google Drive source as a discreet
                // secondary line above the content.
                if (isRawContent && info.driveUrl) {
                    var driveLine = document.createElement('p');
                    driveLine.style.cssText = 'font-size:0.85em;color:#888;margin:0 0 10px;';
                    var driveA = document.createElement('a');
                    driveA.href = info.driveUrl;
                    driveA.target = '_blank';
                    driveA.rel = 'noopener';
                    driveA.style.color = 'var(--saffron)';
                    driveA.textContent = i18n.t('openInGoogleDrive') + ' ↗';
                    driveA.onclick = function (e) {
                        if (!net.online) {
                            e.preventDefault();
                            ui.toast(i18n.t('requiresInternet'));
                        }
                    };
                    driveLine.appendChild(driveA);
                    body.insertBefore(driveLine, body.firstChild);
                }

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

    // ===== TWO-TIER SENTENCE-SEARCH HIGHLIGHT (ZIP export) =====
    // Wraps every matched sentence in <mark class="tr-sentence"> (yellow) and,
    // within that, every matched search word in <mark class="tr-word">
    // (light green). DOM-based (never touches HTML as a string, so tags are
    // never mangled) — reuses the same text-node-walker + Range.surroundContents
    // pattern as _highlightAndScroll() above, generalized to many ranges.
    // Length (in original code units of `run`) whose folded (diacritic-
    // stripped, lowercased) form has exactly `wLen` characters. Mirrors
    // ui.js's private helper of the same name — kept local here since app.js
    // and ui.js are separate IIFEs. Robust to combining marks folding away.
    function _foldedPrefixLen(run, wLen) {
        var acc = 0, i = 0;
        while (i < run.length && acc < wLen) {
            acc += utils.removeDiacritics(run[i].toLowerCase()).length;
            i++;
        }
        return i;
    }

    function _wrapMatchesInContainer(container, sentences, words) {
        if (!container) return;
        sentences = sentences || [];
        words = (words || []).filter(Boolean);

        function buildTextMap() {
            var walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null, false);
            var textNodes = [];
            var fullText = '';
            var n;
            while ((n = walker.nextNode())) {
                textNodes.push({ node: n, offset: fullText.length, len: n.textContent.length });
                fullText += n.textContent;
            }
            return { textNodes: textNodes, fullText: fullText };
        }

        // Wrap every {start,end} range (character offsets into the CURRENT
        // buildTextMap() snapshot) in <mark class="cls">. Ranges are processed
        // rightmost-first: Range.surroundContents() splits a text node into
        // (before | matched | after) and the ORIGINAL node object always keeps
        // the "before" fragment, so once the rightmost range in a node is
        // wrapped the remaining (lower-offset) ranges in that same node are
        // still valid offsets into the (now shorter) original node — safe to
        // process sequentially without rebuilding the walker each time.
        function wrapRanges(ranges, cls) {
            if (!ranges.length) return;
            var map = buildTextMap();
            var textNodes = map.textNodes;
            if (!textNodes.length) return;
            ranges = ranges.slice().sort(function (a, b) { return b.start - a.start; });
            ranges.forEach(function (rg) {
                for (var ti = 0; ti < textNodes.length; ti++) {
                    var tn = textNodes[ti];
                    var nodeStart = tn.offset, nodeEnd = tn.offset + tn.len;
                    if (nodeEnd <= rg.start || nodeStart >= rg.end) continue;
                    var wrapStart = Math.max(0, rg.start - nodeStart);
                    var wrapEnd = Math.min(tn.len, rg.end - nodeStart);
                    if (wrapStart >= wrapEnd) continue;
                    try {
                        var wr = document.createRange();
                        wr.setStart(tn.node, wrapStart);
                        wr.setEnd(tn.node, wrapEnd);
                        var m = document.createElement('mark');
                        m.className = cls;
                        wr.surroundContents(m);
                    } catch (ex) { /* range crosses an element boundary — skip this node */ }
                }
            });
        }

        // Pass 1: whole matched SENTENCES. The DB sentence text can differ from the
        // transcript in whitespace/punctuation spacing (e.g. DB "Gaurāṅga , we" vs
        // transcript "Gaurāṅga, we"), so an exact indexOf fails. Match the sentence's
        // alphanumeric tokens IN ORDER, allowing any non-alphanumeric run (spaces,
        // punctuation) between them — tolerant of those differences. Diacritics stay
        // literal (DB and transcript share the same IAST spelling).
        var sentRanges = [];
        var map1 = buildTextMap();
        var fullText1 = map1.fullText;
        sentences.forEach(function (sentText) {
            var tokens = (sentText || '').match(/[\p{L}\p{N}]+/gu);
            if (!tokens || !tokens.length) return;
            var pattern = tokens.map(function (t) {
                return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }).join('[^\\p{L}\\p{N}]*');
            var re;
            try { re = new RegExp(pattern, 'iu'); } catch (e) { return; }
            var m = re.exec(fullText1);
            if (m && m[0].length) sentRanges.push({ start: m.index, end: m.index + m[0].length });
        });
        wrapRanges(sentRanges, 'tr-sentence');

        // Pass 2: individual matched WORDS — diacritic- and case-insensitive,
        // word-start-PREFIX match (mirrors ui.highlightSentencePrefix). `words`
        // is already diacritic-folded + lowercased (see _sentenceWords). We
        // walk every word-run in the original (unfolded) text and highlight
        // only the folded-prefix portion, so "mahaprabh" highlights the
        // "Mahāprabh" inside "Mahāprabhu" without the trailing "u". May nest
        // inside a tr-sentence <mark> from pass 1 — that is intentional.
        var wordRanges = [];
        var map2 = buildTextMap();
        var wordRe = /[\p{L}\p{M}\p{N}]+/gu;
        var wm;
        while ((wm = wordRe.exec(map2.fullText))) {
            var run = wm[0];
            var foldedRun = utils.removeDiacritics(run.toLowerCase());
            var best = null;
            words.forEach(function (w) {
                if (w && foldedRun.indexOf(w) === 0 && (!best || w.length > best.length)) best = w;
            });
            if (best) {
                var plen = _foldedPrefixLen(run, best.length);
                wordRanges.push({ start: wm.index, end: wm.index + plen });
            }
            if (wordRe.lastIndex === wm.index) wordRe.lastIndex++; // guard zero-length matches
        }
        wrapRanges(wordRanges, 'tr-word');
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

    // ===== ADVANCED TRANSCRIPT (SENTENCE) SEARCH =====
    // Stored so the "Download Excel" button can re-run the query uncapped.
    var _sentenceParsed = null;
    var _sentenceTerm = '';
    // Matched-sentence text per lecture nr (from the last rendered page of
    // results) and the flat list of diacritic-folded search words — used by
    // the ZIP download to double-highlight (sentence + word) in exported
    // transcripts. Cleared/repopulated each time results are (re-)rendered.
    var _sentenceMatchesByNr = {};
    var _sentenceWords = [];
    // Last rendered sentence-search results ({rows, term, totals}) — kept so
    // a language switch in "In Text" mode can re-render the SAME results with
    // freshly localized headers/summary instead of wiping the table (the old
    // setLanguage() tail fell through to ui.renderEmptyTable() because
    // sentence rows never live in allResults). null = nothing to restore.
    var _sentenceLastRender = null;
    // Monotonic token for the CURRENT sentence search. Each performSentenceSearch
    // call bumps it and captures the value; after every async hop it re-checks
    // that its token is still the latest AND the app is still in 'sentences'
    // mode before it renders or persists — so a superseded search (user started
    // a newer query, or switched mode/language mid-flight) is dropped silently
    // instead of leaking stale rows into the current view / _sentenceLastRender.
    var _sentenceSearchSeq = 0;
    // UI lock: true while a performSentenceSearch() run is in flight. Primary
    // defense against the async race — mode switch / new search / language
    // change are refused (with a toast) while this is true, so the race the
    // _sentenceSearchSeq token protects against should never actually be
    // triggered by normal UI interaction. Always reset in both the success
    // and the catch tail of performSentenceSearch so it can never stick at
    // true after an error.
    var _sentenceSearchBusy = false;

    // Extract the flat, diacritic-folded, whole-word list a search matched on
    // (mirrors the word-splitting rule in search.js buildTranscriptSQL).
    function _extractSentenceSearchWords(parsed) {
        var seen = {};
        (parsed && parsed.orGroups || []).forEach(function (group) {
            group.forEach(function (term) {
                var normalized = utils.removeDiacritics((term || '').toLowerCase());
                normalized.split(/[^a-z0-9]+/).filter(Boolean).forEach(function (w) { seen[w] = 1; });
            });
        });
        return Object.keys(seen);
    }

    function performSentenceSearch(startTime) {
        // Capture this search's identity up front: a monotonic token, the exact
        // query term, and the mode it was launched in. Every async continuation
        // below verifies it is still the newest search AND still in 'sentences'
        // mode before touching the UI or the persisted last-render state.
        var mySeq = ++_sentenceSearchSeq;
        var myTerm = lastSearchTerm;
        function stillCurrent() {
            return _sentenceSearchSeq === mySeq && searchMode === 'sentences';
        }

        var parsed = search.parseSearchQuery(myTerm);
        var q = search.buildTranscriptSQL(parsed);
        if (!q) {
            // No free-text term — nothing to search on. Synchronous path, no
            // async hop, so the busy lock is never engaged here.
            document.getElementById('resultsInfo').innerHTML = '';
            document.getElementById('timer').textContent = '';
            _sentenceMatchesByNr = {};
            _sentenceWords = [];
            _sentenceLastRender = null;
            ui.renderSentenceResults([], myTerm, { total: 0, lectures: 0, shown: 0 }, _sentenceWords);
            return;
        }

        _sentenceSearchBusy = true;

        _sentenceParsed = parsed;
        _sentenceTerm = myTerm;

        ui.showLoading(i18n.t('searching') + ' 0/21…');
        ui.updateProgress(0);

        // Phase B: chunked search across all sentence shards (premium + raw).
        // One shard DB resident at a time; per-shard progress line; merged +
        // re-capped rows and summed totals come back in a single result.
        db.searchSentencesChunked(q.sql, q.countSql, q.params, function (done, total) {
            if (!stillCurrent()) return;
            ui.updateProgress(done / total);
            ui.showLoading(i18n.t('searching') + ' ' + done + '/' + total + '…');
        }).then(function (res) {
            // Final gate before ANY render / persist: a newer search or a
            // mode/language switch since we started means these rows are
            // stale — never leak them into the current view.
            if (!stillCurrent()) return;
            ui.hideLoading();
            var rows = (res && res.rows) || [];
            var n = (res && res.count) || 0;
            var lectures = (res && res.lectures) || 0;
            var elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
            document.getElementById('timer').textContent = i18n.t('elapsedTime') + ' ' + elapsed + ' ' + i18n.t('seconds');
            track('search', { query: myTerm, mode: 'sentences', results: n });
            // Build the nr -> matched-sentence-texts map + word list for the
            // ZIP export highlighter (downloadSelectedZip / _addOneToZip).
            _sentenceMatchesByNr = {};
            rows.forEach(function (r) {
                var key = String(r.nr);
                if (!_sentenceMatchesByNr[key]) _sentenceMatchesByNr[key] = [];
                _sentenceMatchesByNr[key].push(r.sentence || '');
            });
            _sentenceWords = _extractSentenceSearchWords(parsed);
            _sentenceLastRender = { rows: rows, term: myTerm, totals: { total: n, lectures: lectures, shown: rows.length } };
            ui.renderSentenceResults(rows, myTerm, _sentenceLastRender.totals, _sentenceWords);
        }).catch(function (err) {
            // Only surface an error for the still-current search — a superseded
            // run rejecting must not overwrite the live view.
            if (!stillCurrent()) return;
            ui.hideLoading();
            console.error('Sentence search error:', err);
            var infoEl = document.getElementById('resultsInfo');
            if (!navigator.onLine) {
                // P2: offline + sentence shards not installed (opted out, or an
                // older offline install that predates shards). The shard fetch
                // can't reach the network — show a clean "not available offline"
                // message instead of a raw error.
                infoEl.innerHTML = '<strong>' + utils.escapeHtml(i18n.t('offlineTextSearchUnavailable')) + '</strong>';
            } else {
                infoEl.innerHTML = '<strong>Error: ' + utils.escapeHtml(err.message) + '</strong>';
            }
        }).then(function () {
            // ALWAYS release the busy lock for THIS run (success or error), so
            // it can never stick at true. Only clear the flag if no newer
            // search has been issued since — an older run finishing after it
            // was superseded must not unlock UI actions on behalf of the
            // newer, still in-flight run (which owns the lock now).
            if (mySeq === _sentenceSearchSeq) _sentenceSearchBusy = false;
        });
    }

    // Re-run the stored sentence query with a very high limit and export to Excel.
    function exportSentencesExcel() {
        if (!_sentenceParsed) return;
        var q = search.buildTranscriptSQL(_sentenceParsed);
        if (!q) return;
        q.params.$limit = 100000;

        // Phase B: full (uncapped) export must also loop every shard — one
        // shard resident at a time — and merge, same as the on-screen search.
        db.searchSentencesChunked(q.sql, q.countSql, q.params).then(function (res) {
            var rows = (res && res.rows) || [];
            if (typeof XLSX === 'undefined') {
                console.error('XLSX library not available');
                return;
            }
            var data = rows.map(function (r) {
                return {
                    Timestamp: r.ts || '',
                    Sentence: r.sentence || '',
                    Tier: r.tier || '',
                    'Lecture nr': r.nr,
                    'Lecture name': r.name || '',
                    'Script_EN URL': r.url || ''
                };
            });
            var ws = XLSX.utils.json_to_sheet(data);
            // Make the "Script_EN URL" cell (last column, index 5) a clickable
            // hyperlink while keeping the visible text unchanged (SheetJS cell.l).
            data.forEach(function (r, rowIdx) {
                var u = r['Script_EN URL'];
                if (!u || !utils.isSafeUrl(u)) return;
                var addr = XLSX.utils.encode_cell({ r: rowIdx + 1, c: 5 });
                var cell = ws[addr];
                if (cell) cell.l = { Target: u, Tooltip: 'Open transcript' };
            });
            var wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Sentences');

            var safeQuery = (_sentenceTerm || 'search').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'search';
            var d = new Date();
            var dateStr = d.getFullYear() + '-' +
                ('0' + (d.getMonth() + 1)).slice(-2) + '-' +
                ('0' + d.getDate()).slice(-2);
            XLSX.writeFile(wb, 'transcript_search_' + safeQuery + '_' + dateStr + '.xlsx');
            track('export-excel', { query: _sentenceTerm, mode: 'sentences', rows: rows.length });
        }).catch(function (err) {
            console.error('Excel export error:', err);
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
        if (_sentenceSearchBusy) { ui.toast(i18n.t('searchInProgress')); return; }
        track('language', { lang: lang });
        i18n.setLanguage(lang);
        // A11Y: keep the document language in sync (screen readers, hyphenation).
        // Also covers initial load — init() calls setLanguage(savedLang).
        document.documentElement.lang = lang;
        document.querySelectorAll('.lang-btn').forEach(function (btn) {
            btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
        });
        document.querySelectorAll('[data-i18n]').forEach(function (el) {
            var key = el.getAttribute('data-i18n');
            var val = i18n.t(key);
            if (val !== key) el.textContent = val;
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) {
            var pkey = el.getAttribute('data-i18n-placeholder');
            var pval = i18n.t(pkey);
            if (pval !== pkey) el.placeholder = pval;
        });
        var luEl = document.getElementById('dbLastUpdate');
        if (luEl && luEl.getAttribute('data-last-update')) {
            luEl.textContent = (i18n.t('lastUpdate') || 'Last update') + ': ' + luEl.getAttribute('data-last-update');
        }
        document.querySelector('h1').textContent = i18n.t('pageTitle');
        // Centralized — this branch used to ignore 'sentences' mode entirely
        // (fell through to the metadata {count} placeholder), so switching
        // language while in "In Text" mode reverted the placeholder to the
        // wrong text. updateSearchModePlaceholder() handles all modes.
        updateSearchModePlaceholder();
        localStorage.setItem('preferredLanguage', lang);
        updateFavoritesCount();
        if (searchMode === 'sentences') {
            // "In Text" mode: re-render the LAST sentence results (headers +
            // summary line come out in the new language) instead of wiping
            // the table — sentence rows never live in allResults, so the
            // generic branch below used to blank them on language switch.
            if (_sentenceLastRender) {
                ui.renderSentenceResults(_sentenceLastRender.rows, _sentenceLastRender.term, _sentenceLastRender.totals, _sentenceWords);
            } else {
                ui.renderEmptySentenceTable();
            }
        } else if (allResults.length > 0) {
            displayResults();
        } else {
            ui.renderEmptyTable();
        }
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
        exportSentencesExcel: exportSentencesExcel,
        openTranscriptAtVerse: openTranscriptAtVerse,
        openHtmlTranscriptViewer: openHtmlTranscriptViewer,
        closeTranscriptModal: closeTranscriptModal,
        downloadTranscript: downloadTranscript,
        showFavorites: showFavorites,
        updateFavoritesCount: updateFavoritesCount,
        // Multi-select transcripts -> ZIP
        isSelectedPair: isSelectedPair,
        toggleSelectPair: toggleSelectPair,
        showSelectToggle: _showSelectToggle, // used by ui.js renderSentenceResults()
        getDbRowByNr: _findDbRowByNr, // used by ui.js renderSentenceResults() (Dwnld. lookup)
        getTranscriptView: getTranscriptView, // used by ui.js buildHeader() (By Date/Topic/Newest active state)
        openDownloadPanel: openDownloadPanel,
        closeDownloadPanel: closeDownloadPanel,
        clearSelection: clearSelection,
        downloadSelectedZip: downloadSelectedZip,
        cancelZipDownload: cancelZipDownload,
        // Internal — exposed only so Playwright can unit-test the two-tier
        // sentence/word ZIP-export highlighter without a full download round trip.
        _wrapMatchesInContainer: _wrapMatchesInContainer,
        // Internal (test only) — drive the background install directly so the
        // quota-exceeded UI path can be exercised deterministically (P12).
        startBackgroundInstall: startBackgroundInstall,
        // Internal (test only) — unit-test the MP3 ZIP count cap in
        // _addOneToZip / toggleSelectPair without fetching real audio.
        _addOneToZip: _addOneToZip,
        _getMp3ZipMaxCount: function () { return MP3_ZIP_MAX_COUNT; },
        // Internal (test only) — read the persisted last sentence render so a
        // test can prove a superseded search did NOT overwrite it (race fix).
        _getSentenceLastRenderForTest: function () { return _sentenceLastRender; },
        // Internal (test only) — read the sentence-search UI busy lock so a
        // test can confirm it engages while a search is in flight and always
        // releases afterwards (even on error).
        _isSentenceSearchBusyForTest: function () { return _sentenceSearchBusy; },
        copyShareLink: copyShareLink,
        buildShareUrl: buildShareUrl,
        toggleTheme: toggleTheme,
        startBackgroundInstall: startBackgroundInstall,
        // Exposed for Playwright: drives the first-install confirmation prompt
        // (language checkboxes) without the online-first offer-panel path.
        startFirstInstallFlow: startFirstInstallFlow,
        toggleOfflineInfoPanel: toggleOfflineInfoPanel,
        closeOfflineInfoPanel: closeOfflineInfoPanel,
        openGuide: function () {
            var lang = localStorage.getItem('preferredLanguage') || 'en';
            window.open('guide/' + lang + '/index.html', '_blank');
        },
        toggleFeaturesMenu: function (ev) {
            if (ev) ev.stopPropagation();
            var menu = document.getElementById('featuresMenu');
            if (!menu) return;

            // Currently open -> close.
            if (!menu.hidden) {
                closeFeaturesMenu();
                return;
            }

            var lang = i18n.getLanguage() || localStorage.getItem('preferredLanguage') || 'en';
            var data = window.PPP_GUIDE_MENU && window.PPP_GUIDE_MENU[lang];
            if (!data) {
                // No menu data available -> fall back to the full guide.
                this.openGuide();
                return;
            }

            var base = 'guide/' + lang + '/index.html';
            menu.innerHTML = '';

            // Centered modal panel.
            var panel = document.createElement('div');
            panel.className = 'features-modal';

            // Header: title + close button.
            var header = document.createElement('div');
            header.className = 'fm-header';
            var h2 = document.createElement('h2');
            h2.textContent = i18n.t('featuresBtn');
            var closeBtn = document.createElement('button');
            closeBtn.className = 'fm-close';
            closeBtn.type = 'button';
            closeBtn.setAttribute('aria-label', 'Close');
            closeBtn.textContent = '×';
            closeBtn.addEventListener('click', closeFeaturesMenu);
            header.appendChild(h2);
            header.appendChild(closeBtn);
            panel.appendChild(header);

            // "All functions" link at the top.
            var all = document.createElement('a');
            all.className = 'fm-all';
            all.href = base;
            all.target = '_blank';
            all.rel = 'noopener';
            all.textContent = i18n.t('allFunctions');
            panel.appendChild(all);

            // Groups A-I, each a heading with its function names beneath.
            var groups = data.groups || [];
            var items = data.items || [];
            groups.forEach(function (grp) {
                var heading = document.createElement('div');
                heading.className = 'fm-group';
                heading.textContent = grp.name;
                panel.appendChild(heading);

                items.filter(function (it) { return it.g === grp.l; })
                    .forEach(function (it) {
                        var a = document.createElement('a');
                        a.className = 'fm-item';
                        a.href = base + '#item-' + it.n;
                        a.target = '_blank';
                        a.rel = 'noopener';
                        a.textContent = it.t;
                        panel.appendChild(a);
                    });
            });

            menu.appendChild(panel);
            menu.hidden = false;
            // Defer wiring the backdrop-click handler so the current click that
            // opened the menu does not immediately close it.
            setTimeout(function () {
                menu.addEventListener('click', onFeaturesOverlayClick);
                document.addEventListener('keydown', onFeaturesKeydown);
            }, 0);
        }
    };

    // ---- Features menu helpers (module-private, single set of handlers) ----
    function closeFeaturesMenu() {
        var menu = document.getElementById('featuresMenu');
        if (menu) {
            menu.hidden = true;
            menu.innerHTML = '';
            menu.removeEventListener('click', onFeaturesOverlayClick);
        }
        document.removeEventListener('keydown', onFeaturesKeydown);
    }

    function onFeaturesOverlayClick(e) {
        // Close only when the backdrop itself is clicked, not the panel/links.
        if (e.target === e.currentTarget) closeFeaturesMenu();
    }

    function onFeaturesKeydown(e) {
        if (e.key === 'Escape' || e.key === 'Esc') {
            closeFeaturesMenu();
        }
    }
})();

// ===== Auto-init on DOM ready =====
document.addEventListener('DOMContentLoaded', function () {
    PPP.app.init();
});
