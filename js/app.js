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
        // Dark mode toggle removed from the UI (Rājan decision, 2026-07-25).
        // Body always renders light; the .dark CSS rules are left dormant
        // (not deleted) so this stays reversible. No stored preference is
        // read or applied here anymore.
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

        // Keep the Favorites button's visibility (gated on count() > 0 — see
        // updateFavoritesCount) in sync with EVERY favorites mutation, not
        // just the ones made through the star-button UI's own call sites
        // (ui.js already calls updateFavoritesCount after its popup actions).
        // Without this, code that saves a favorite through any other path
        // (e.g. the backward-compat PPP.favorites.toggle()) leaves the button
        // hidden even though the save itself succeeded.
        if (PPP.favorites && PPP.favorites.subscribe) {
            PPP.favorites.subscribe(updateFavoritesCount);
        }

        var savedLang = localStorage.getItem('preferredLanguage') || 'en';
        setLanguage(savedLang);
        initOnboarding();

        // Close List of Sources dropdown(s) on any other button click
        document.addEventListener('click', function (e) {
            ['sourcesList', 'utilSourcesList'].forEach(function (id) {
                var sourcesList = document.getElementById(id);
                if (!sourcesList || sourcesList.style.display === 'none' || sourcesList.style.display === '') return;
                var btn = e.target.closest('button');
                if (!btn) return;
                if (btn.closest('.top-left-buttons')) return;
                if (btn.closest('.onb-intro-after')) return;
                if (sourcesList.contains(btn)) return;
                sourcesList.style.display = 'none';
            });
        }, true);

        // Close the language chooser (compact button dropdown) on outside click
        document.addEventListener('click', function (e) {
            var full = document.getElementById('langSwitcherFull');
            if (!full || !full.classList.contains('open')) return;
            if (e.target.closest('#langSwitcherFull') || e.target.closest('#langCompactBtn')) return;
            full.classList.remove('open');
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

        // Ensure the mode matching the chosen purpose is active on start
        // (quotes purpose starts in "In Text"; lectures/unset starts in "In Titles").
        setSearchMode(_currentPurpose() === 'quotes' ? 'sentences' : 'metadata');

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
            var ua = navigator.userAgent;
            var isAndroid = /android/i.test(ua);
            // "Add to Home Screen" is a PHONE/TABLET gesture. Before the audit
            // this branch treated every non-Android agent as iOS, so a Windows
            // or macOS desktop was shown iOS instructions it cannot follow —
            // and the banner also displaced the first button row there.
            // Desktop still gets a real offer through beforeinstallprompt
            // (showInstallBanner('native') above) when the browser supports it.
            var isIOS = /iphone|ipad|ipod/i.test(ua) ||
                (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1); // iPadOS 13+
            if (!isAndroid && !isIOS) return;
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
        // Timeout-hardened the same way as _startMandatoryInstallGate/
        // _requireTextSearchLibrary (Rājan 2026-07-26): a wedged IndexedDB
        // read here must degrade to the legacy online load, not hang the
        // app on "Loading the database…" forever.
        _raceTimeout(
            store.open().then(function () { return store.getState('localManifest'); }),
            4000,
            _OFFLINE_READ_TIMEOUT
        ).then(function (localManifest) {
            if (localManifest === _OFFLINE_READ_TIMEOUT) {
                console.warn('Offline store read timed out, using legacy load');
                loadDataLegacy();
                return;
            }
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
                PPP.downloader.getResumeState ? _raceTimeout(PPP.downloader.getResumeState(), 4000, null) : null,
                PPP.downloader.isCoreReady ? _raceTimeout(PPP.downloader.isCoreReady(), 4000, false) : false
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
                // ONLINE is the base experience for a RETURNING user (purpose
                // already chosen in an earlier session) whose device has no
                // local install yet — e.g. storage was cleared, or offline
                // isn't supported here. The offline download is then OPTIONAL,
                // offered via the small "Work offline" button once the online
                // DB is ready (see loadDataLegacy() -> onDataLoaded() ->
                // maybeShowOfflineWorkButton()).
                //
                // A brand-new user (onboarding gate still open, no purpose
                // chosen yet) must NOT silently start the online path here —
                // Rājan decision 2026-07-26: first use goes through the
                // mandatory install gate instead (setPurpose() ->
                // _startMandatoryInstallGate()), which calls loadDataLegacy()/
                // startFirstInstallFlow() itself once the choice is known.
                if (!_currentPurpose()) return;
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
            updateOnbIntro();

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
    // computed value even before a manifest is fetched this session. Also
    // caches the sentence-shards total (the "Offline text search" opt-in
    // pack set) for the mobile "In Text" size warning below — same pattern,
    // read from the SAME manifest fetch so no extra request is needed.
    function _cacheBaseMB(manifest) {
        try {
            var mb = Math.round(PPP.downloader.computeInstallBytes(manifest, []) / 1048576);
            if (mb > 0) localStorage.setItem('ppp_base_mb', String(mb));
        } catch (e) {}
        try {
            var shardBytes = 0;
            (manifest.sentenceShards || []).forEach(function (s) { if (s && s.size) shardBytes += s.size; });
            var shardMB = Math.round(shardBytes / 1048576);
            if (shardMB > 0) localStorage.setItem('ppp_shards_mb', String(shardMB));
        } catch (e) {}
    }
    function _baseMB() {
        try { var v = parseInt(localStorage.getItem('ppp_base_mb'), 10); if (v > 0) return v; } catch (e) {}
        return 151; // EN base fallback (core + prem-en + raw-en ≈ 150.8 MB)
    }
    // Measured (2026-07-26): a full "In Text" search transfers ~200.6 MB of
    // sentence shards. Fallback used until a manifest fetch has cached the
    // real total in ppp_shards_mb (see _cacheBaseMB above).
    function _shardsMB() {
        try { var v = parseInt(localStorage.getItem('ppp_shards_mb'), 10); if (v > 0) return v; } catch (e) {}
        return 200;
    }

    // Sentinel distinguishable from every real offlineStore.getState() value
    // (which includes `null` and `undefined` as legitimate "not set yet"
    // results) — see _raceTimeout below.
    var _OFFLINE_READ_TIMEOUT = {};

    /**
     * Race a promise against a timeout, resolving with `fallback` if the
     * real promise neither resolves NOR rejects within `ms`. Rājan field
     * report (2026-07-26): PPP.offlineStore.getState('shards') hung forever
     * (never resolved, never rejected) on a real device — private browsing
     * where IndexedDB exists but silently never answers, another tab
     * holding a blocking version-change transaction, or a wedged embedded
     * webview are all real, reachable conditions. A `.catch()` on the
     * original promise cannot help: a promise that never settles never
     * rejects either. Used at every offlineStore read that gates a visible
     * response to a user action (the onboarding mandatory-install gate, the
     * "In Text" search gate) so a stuck IndexedDB call degrades to a clear
     * fallback instead of leaving the click unanswered. If the real promise
     * eventually does settle after the timeout already fired, its result is
     * silently discarded — the caller already moved on.
     */
    function _raceTimeout(promise, ms, fallback) {
        return new Promise(function (resolve) {
            var settled = false;
            var timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                resolve(fallback);
            }, ms);
            promise.then(function (v) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(v);
            }, function () {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(fallback);
            });
        });
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
     * TEST/CI HOOK ONLY — not a real-user path. `ppp_install_shards` is never
     * set by any UI in js/ (grepped 2026-07-28: only tests/app.spec.js,
     * tests/pwa.spec.js and bench/ set it). It exists so Playwright can drive
     * startBackgroundInstall() with no explicit args (see the `auto` branch
     * at line ~508 and startBackgroundInstall's `sel == null` branch below)
     * and still choose whether that synthetic run includes shards.
     *
     * Real installs NEVER reach this function: every real entry point
     * (_startMandatoryInstallGate / the language-selector widget built with
     * shardsForced: true) passes includeShards explicitly as `true` — the
     * sentence-shard index is mandatory (Rājan decision 2026-07-26,
     * reaffirmed 2026-07-28: "Atteikties var tikai no valodām" — only the
     * extra languages are opt-in, shards never are). So this default-OFF
     * fallback has no user-facing effect and must NOT be "fixed" to true —
     * doing so would just change what the test hook itself does.
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
     *   shardsForced — the sentence shards are MANDATORY (Rājan decision
     *                 2026-07-26, reaffirmed 2026-07-28: "Atteikties var tikai
     *                 no valodām" — the shards are never opt-in, only the
     *                 extra languages are). Every caller of this selector
     *                 must pass shardsForced: true; no checkbox is rendered
     *                 and getIncludeShards() always returns true.
     * Returns { el, getLangs, getIncludeShards }. getLangs() reads the ticked
     * opt-in langs; getIncludeShards() always returns true (shards are
     * mandatory — see shardsForced above). The live size label recomputes
     * from BOTH the language selection and the shard state via
     * computeInstallBytes.
     */
    function _buildLangSelector(manifest, opts) {
        opts = opts || {};
        var langList = opts.langList || _optInLangsFromManifest(manifest);
        var pre = {};
        (opts.preselected || []).forEach(function (l) { pre[l] = true; });

        var wrap = document.createElement('div');
        wrap.className = 'offline-lang-select';
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
        function includeShards() { return !!opts.shardsForced; }
        function refreshSize() {
            var sel = selectedLangs();
            var bytes = PPP.downloader.computeInstallBytes(manifest, sel, includeShards());
            if (opts.sizeMode === 'delta') bytes -= PPP.downloader.computeInstallBytes(manifest, [], !!opts.shardsForced);
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

        if (opts.baseChecked) addRow('en', true);
        langList.forEach(function (l) { addRow(l, false); });
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
            // Prompt headline shows the mandatory base size — core + EN premium
            // + EN raw + the sentence shards (Rājan decision 2026-07-26: text
            // search requires the shards, so they are no longer opt-in). Ticking
            // LV/RU still grows it further.
            var sizeMB = Math.round(PPP.downloader.computeInstallBytes(manifest, [], true) / (1024 * 1024));
            // TEST HOOK: Playwright sets localStorage ppp_auto_install=1 so
            // headless runs exercise the REAL install flow without a click.
            var auto = false;
            try { auto = localStorage.getItem('ppp_auto_install') === '1'; } catch (e) {}
            if (auto) return beginInstall(manifest, _autoInstallLangs(manifest), true);
            showInstallPrompt(manifest, sizeMB);
        }).catch(function (err) {
            // A transient manifest failure used to skip the mandatory gate
            // entirely and open the online app (Codex, 2026-07-26). One flaky
            // request must not decide the product model — show the same error +
            // Try again screen as any other install failure.
            console.warn('Manifest fetch failed — install gate cannot start:', err);
            _showInstallStalled(null, true);
        });
    }

    function showInstallPrompt(manifest, sizeMB) {
        _cacheBaseMB(manifest);
        // Arm the click guard NOW, not at beginInstall(): while this prompt
        // waits for a decision the app is not usable, and the search box was
        // still live behind it, answering clicks with silence.
        _installStarted = false;
        document.addEventListener('click', _installGuardHandler, true);
        ui.showLoading(i18n.t('installPrompt').replace('{size}', sizeMB));
        ui.updateProgress(0);
        var bar = document.getElementById('progressBar');
        if (!bar) return;
        var old = document.getElementById('installOfflineBtn');
        if (old) old.remove();
        var oldSel = document.getElementById('installLangSelect');
        if (oldSel) oldSel.remove();

        // EN + sentence shards are now the MANDATORY base (text search needs
        // them — shardsForced skips the opt-in checkbox and always sizes/
        // installs them); LV/RU stay opt-in checkboxes, unchecked by default.
        var selector = _buildLangSelector(manifest, { baseChecked: true, sizeMode: 'total', shardsForced: true });
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
            selector.el.remove();
            btn.remove();
            beginInstall(manifest, langs, true);
        };
        bar.appendChild(btn);

        // NO escape hatch here. Rājan, 2026-07-26: "kā jebkura spēle — tai nav
        // daļējas lejupielādes". The only choice on this screen is whether to
        // add Latvian and/or Russian; everything else is downloaded on first
        // use regardless, and until it is there the app does not run. An
        // earlier build offered "Continue without text search" next to
        // Download — that was this session's own addition, not the decision,
        // and it let users into a half-app where 7,680 raw transcripts cannot
        // be opened.
    }

    // Capture-phase click interceptor active from the moment the mandatory
    // install prompt appears until the library is on the device: interactions
    // outside the loading area answer with a toast instead of half-working on
    // missing data. Before Download is pressed the toast says the library is
    // required; during the download it reports the percentage.
    //
    // It also covers the WAITING state, not just the download (Rājan
    // 2026-07-26, all-or-nothing). Until this was armed early, the search box
    // and Search button stayed live behind the prompt and answered a click
    // with nothing at all — the same silent no-op this whole design removes.
    var _installPct = 0;
    var _installStarted = false;
    function _installGuardHandler(e) {
        var bar = document.getElementById('progressBar');
        if (bar && bar.contains(e.target)) return;
        var el = e.target.closest ? e.target.closest('button, input, a, select') : null;
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        ui.toast(_installStarted
            ? i18n.t('stillDownloading').replace('{pct}', _installPct)
            : i18n.t('libraryRequiredFirst'));
    }

    // ---- Install continuity (single flight, auto-retry, wake lock) ---------
    // A phone download of ~139 MB is routinely interrupted: the screen sleeps,
    // the tab is backgrounded, the network flaps. These three helpers make the
    // install survive all of it — exactly ONE install runs at a time, it is
    // retried automatically the moment the device is online and visible, and
    // the screen is (best-effort) kept awake while it runs.
    var _installInFlight = false;
    var _installListenersOn = false;
    // Consecutive AUTOMATIC partial failures. A persistent per-item failure
    // (bad device state, quota edge, corrupted response) plus the auto-resume
    // listeners used to make a silent infinite loop: fail -> message rendered
    // -> visibility/online tick restarts the pool -> the message is wiped
    // before anyone can read it (field bug 2026-07-24, iPad 83%->79% cycle).
    // After MAX consecutive automatic failures the listeners are disarmed so
    // the message STAYS on screen; the manual Retry button (which resets the
    // counter) remains the way to continue.
    var _autoFailCount = 0;
    var AUTO_FAIL_MAX = 2;
    var _retryLangs = null;         // selection to resume with (null = default)
    var _retryShards = false;
    var _wakeLock = null;
    // What an automatic resume must run while an install ERROR SCREEN is up.
    // The gated paths (mandatory install, shards-only top-up) are not resumed
    // by startBackgroundInstall — each has its own flow — so the error screen
    // hands over the exact function its own Try again button would call. Set by
    // _showInstallStalled, consumed once by _installRetryTick.
    var _pendingResume = null;
    // True while the attempt in flight was started AUTOMATICALLY. Only such an
    // attempt may spend a unit of _autoFailCount, and only when it actually
    // FAILS. Charging the budget for the tick itself meant two tab switches
    // exhausted it and the listeners came off — precisely the regression the
    // error screen keeps them armed to avoid.
    var _autoAttemptPending = false;
    // Floor between VISIBILITY-driven resumes. Returning to the tab now costs
    // nothing budget-wise, so it needs its own brake: without one, flicking
    // between tabs would relaunch a failing install over and over. An 'online'
    // event is deliberately NOT rate-limited — "the network came back" is the
    // signal this whole mechanism exists to act on, and repeated REAL failures
    // still spend the budget and stop the loop.
    var _VISIBILITY_RESUME_MIN_MS = 30000;
    var _lastAutoResumeAt = 0;

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

    /**
     * @param {boolean} rateLimited true for the visibility-driven tick, which
     *        must not be able to relaunch a failing install on every tab switch.
     */
    function _installRetryTick(rateLimited) {
        // De-duplication: the guard is the single source of truth, so an
        // 'online' burst plus a visibilitychange can never start two pools.
        if (_installInFlight || !navigator.onLine) return;
        if (_pendingResume) {
            // An install error screen is on display. Resuming automatically is
            // the whole point on a flaky connection — a network blip must not
            // demote itself into "user has to notice and press a button".
            // Bounded by the SAME counter that stops the iPad wipe-the-message
            // loop, but the counter is charged where a failure HAPPENS, not
            // here: merely looking at the tab is not a failed install.
            if (_autoFailCount >= AUTO_FAIL_MAX) { _removeInstallListeners(); return; }
            var now = Date.now();
            if (rateLimited && (now - _lastAutoResumeAt) < _VISIBILITY_RESUME_MIN_MS) return;
            _lastAutoResumeAt = now;
            _autoAttemptPending = true;
            var fn = _pendingResume;
            _pendingResume = null;
            fn();
            return;
        }
        startBackgroundInstall(_retryLangs, _retryShards);
    }

    function _onlineRetryHandler() { _installRetryTick(false); }

    function _visibilityRetryHandler() {
        if (document.visibilityState !== 'visible') return;
        if (_installInFlight) {
            // Coming back to the foreground: the OS drops the screen wake lock
            // whenever the document is hidden, so re-request it.
            _acquireWakeLock();
            return;
        }
        _installRetryTick(true);    // rate-limited: a tab switch is not an event
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

    /**
     * Stop the AUTOMATIC resume for good (until a human presses Retry, which
     * refills the budget). Used where retrying by itself cannot possibly help
     * and would only wipe the message off the screen: a device with no storage
     * left repeats the exact same failing IndexedDB write. Spending the budget
     * — rather than only unhooking the listeners — also stops the error screen
     * from re-arming them behind our back (_showInstallStalled).
     */
    function _stopAutoResume() {
        _autoFailCount = AUTO_FAIL_MAX;
        _autoAttemptPending = false;
        _pendingResume = null;
        _removeInstallListeners();
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

    function _disarmInstallGuard() {
        document.removeEventListener('click', _installGuardHandler, true);
    }

    /**
     * Stall watchdog for the mandatory install.
     *
     * firstInstall() awaits store.getState('install') with no timeout, and a
     * wedged IndexedDB (private browsing, an embedded webview, another tab
     * holding a version-change transaction) neither resolves NOR rejects. The
     * install promise then never settles, so the .then/.catch that disarm the
     * click guard never run — and since the gate deliberately has no skip
     * button, the app is frozen for good. Codex audit + Sabhā, 2026-07-26;
     * all four reviewers reached this independently.
     *
     * A byte-level watchdog covers every wedge point at once, wherever it is:
     * if nothing at all has moved for _INSTALL_STALL_MS, settle with
     * {stalled:true} so the caller can show an error the user can act on.
     */
    var _INSTALL_STALL_MS = 45000;
    // How long a NEW attempt waits for the cancelled one to actually stop.
    // The abort kills the fetches at once, so the only thing that can still be
    // outstanding is an IndexedDB apply — which is exactly the wedge the
    // watchdog exists for, hence a bound rather than an unlimited wait: a
    // frozen store must not freeze the Try again button too.
    var _CANCEL_WAIT_MS = 5000;

    // The install that is running right now, whoever started it (mandatory
    // gate, shards-only top-up, background resume). Exactly one at a time.
    var _installJob = null;

    /**
     * Cancellation handle. A real AbortController when the browser has one —
     * then fetch() is killed mid-flight; otherwise a plain flag the downloader
     * polls between items, chunks and retries, so the pool still stops.
     */
    function _makeAbortHandle() {
        var handle = { aborted: false, signal: null, abort: null };
        var ctrl = null;
        try { if (typeof AbortController === 'function') ctrl = new AbortController(); } catch (e) { ctrl = null; }
        if (ctrl) {
            handle.signal = ctrl.signal;
            handle.abort = function () { handle.aborted = true; try { ctrl.abort(); } catch (e) {} };
        } else {
            var flag = { aborted: false };
            handle.signal = flag;
            handle.abort = function () { handle.aborted = true; flag.aborted = true; };
        }
        return handle;
    }

    /** Publish the running install so a later start can cancel AND await it. */
    function _registerInstallJob(handle, work) {
        var job = {
            handle: handle,
            done: Promise.resolve(work).then(function () {}, function () {})
        };
        _installJob = job;
        job.done.then(function () { if (_installJob === job) _installJob = null; });
        return job;
    }

    /**
     * Stop the install currently running and wait until it has REALLY stopped.
     *
     * The stall watchdog used to only drop its promise: the pool underneath
     * kept downloading, so "Try again" started a SECOND one. Two pools over the
     * same 342 MB doubled the data bill on exactly the weak connections that
     * stall, wrote `install` snapshots over each other, and threw away the
     * stuck download's result if it did finish — leaving the user staring at an
     * error screen with a complete library on the device (Fable review,
     * 2026-07-27). Cancelling for real and awaiting the stop is what makes the
     * retry a retry instead of a duplicate.
     */
    function _cancelInstallJob() {
        var job = _installJob;
        if (!job) return Promise.resolve();
        _installJob = null;
        try { job.handle.abort(); } catch (e) {}
        return new Promise(function (resolve) {
            var t = setTimeout(function () {
                console.warn('Previous install did not stop within ' + _CANCEL_WAIT_MS +
                    ' ms (wedged storage?) — continuing anyway; its downloads are aborted.');
                resolve();
            }, _CANCEL_WAIT_MS);
            job.done.then(function () { clearTimeout(t); resolve(); });
        });
    }

    function _withStallWatchdog(start, onTick) {
        // Single flight, enforced where it matters: never begin on top of work
        // that may still be downloading (see _cancelInstallJob).
        return _cancelInstallJob().then(function () {
            return new Promise(function (resolve, reject) {
                var timer = null, settled = false;
                var handle = _makeAbortHandle();
                function disarm() { if (timer) { clearTimeout(timer); timer = null; } }
                function arm() {
                    disarm();
                    timer = setTimeout(function () {
                        if (settled) return;
                        settled = true;
                        // Cancel for real — the promise this rejects is not the
                        // download, and dropping it never stopped anything.
                        try { handle.abort(); } catch (e) {}
                        reject({ stalled: true });
                    }, _INSTALL_STALL_MS);
                }
                arm();
                var work;
                try {
                    work = start(function (p) {
                        if (settled) return;
                        arm();              // progress: restart the clock
                        onTick(p);
                    }, handle.signal);
                } catch (e) {
                    work = Promise.reject(e);
                }
                // Registered even after a stall: `done` is how the next attempt
                // knows the cancelled pool has finished unwinding.
                _registerInstallJob(handle, work);
                Promise.resolve(work).then(function (v) {
                    if (settled) return;
                    settled = true; disarm(); resolve(v);
                }, function (e) {
                    if (settled) return;
                    settled = true; disarm(); reject(e);
                });
            });
        });
    }

    /** Install cannot proceed — say so and offer a real way forward. This is
     *  NOT a partial state: nothing is unlocked, the library is still required
     *  (Rājan all-or-nothing). It only replaces a silent freeze with a message
     *  and a button. */
    function _showInstallStalled(langs, includeShards, retryFn) {
        // Budget accounting lives HERE, where an attempt has demonstrably
        // failed — not at the tick that started it. An automatic attempt that
        // fails costs one unit; a manual one costs nothing (the human already
        // decided); simply returning to the tab costs nothing at all.
        if (_autoAttemptPending) { _autoAttemptPending = false; _autoFailCount++; }
        ui.showLoading(i18n.t('installStalled'));
        // Keep the click guard ARMED on this screen. Disarming it (the obvious
        // move, since the freeze we are fixing WAS a stuck guard) left the
        // search box live behind the error with no data behind it: pressing
        // Search did nothing at all — the same silence this whole night has been
        // spent removing. Found by driving a clean profile in a real browser;
        // the suite could not see it. The guard already lets everything inside
        // #progressBar through, and the Try again button lives there, so the one
        // action that should work still does.
        _installStarted = false;    // toast says "the library is required", not "x% done"
        document.addEventListener('click', _installGuardHandler, true);
        var bar = document.getElementById('progressBar');
        if (!bar) return;
        var old = document.getElementById('installStallRetryBtn');
        if (old) old.remove();
        var btn = document.createElement('button');
        btn.id = 'installStallRetryBtn';
        btn.type = 'button';
        btn.className = 'search-button';
        btn.style.marginTop = '8px';
        btn.textContent = i18n.t('installRetryBtn');

        // ONE way forward, used by both the button and the automatic resume —
        // so a connection coming back can never start something different (or
        // something extra) from what Try again would have started.
        function doRetry() {
            _pendingResume = null;
            var b = document.getElementById('installStallRetryBtn');
            if (b) b.remove();
            // retryFn wins when given: the shards-only path must resume THAT,
            // not restart a full 342 MB install.
            if (retryFn) { retryFn(); return; }
            // langs === null means we never got as far as the language prompt
            // (manifest fetch failed) — restart the whole gate rather than
            // guessing a selection on the user's behalf.
            if (!langs) { startFirstInstallFlow(); return; }
            PPP.downloader.fetchManifest().then(function (m) {
                if (m) beginInstall(m, langs, includeShards);
                else _showInstallStalled(langs, includeShards, retryFn);
            }).catch(function () { _showInstallStalled(langs, includeShards, retryFn); });
        }

        btn.onclick = function () {
            // A human pressed it: refill the automatic budget so the connection
            // gets its full allowance again after this attempt, and make sure
            // this attempt is not billed to the automatic one it replaces.
            _autoFailCount = 0;
            _autoAttemptPending = false;
            _lastAutoResumeAt = Date.now();   // space automatic tries from this one
            doRetry();
        };
        bar.appendChild(btn);

        // Keep the automatic resume alive ON the error screen. Removing the
        // 'online'/'visibilitychange' listeners here turned every network blip
        // into a manual click — the regression landed precisely on the bad
        // connections that produce this screen in the first place. The resume
        // runs through doRetry(), i.e. the same single-flight path as the
        // button, so it cannot become the second pool of A1.
        _pendingResume = doRetry;
        if (_autoFailCount < AUTO_FAIL_MAX) _ensureInstallListeners(langs, includeShards);
    }

    /**
     * Shards-only top-up for a device that already holds the library.
     *
     * Same gate discipline as the full install — click guard, stall watchdog,
     * error + Try again — but it downloads only what is missing (~191 MB instead
     * of 342 MB) and says so. Everyone who installed before the shards became
     * mandatory lands here exactly once.
     */
    function _startShardsOnlyInstall() {
        return PPP.downloader.fetchManifest().then(function (manifest) {
            var bytes = 0;
            (manifest.sentenceShards || []).forEach(function (s) { if (s && s.size) bytes += s.size; });
            var sizeMB = Math.round(bytes / (1024 * 1024));
            _installPct = 0;
            _installStarted = true;
            document.addEventListener('click', _installGuardHandler, true);
            ui.showLoading(i18n.t('installShardsPrompt').replace('{size}', String(sizeMB)));
            ui.updateProgress(0);
            _installInFlight = true;
            _acquireWakeLock();
            return _withStallWatchdog(function (onProgress, signal) {
                return PPP.downloader.addShards(onProgress, signal);
            }, function (p) {
                var frac = p.totalBytes ? p.loadedBytes / p.totalBytes : 0;
                _installPct = Math.round(frac * 100);
                ui.updateProgress(frac);
                ui.setLoadingText(i18n.t('installShardsPrompt').replace('{size}', String(sizeMB)) + ' ' +
                    Math.round(p.loadedBytes / (1024 * 1024)) + ' / ' + sizeMB + ' MB');
            }).then(function () {
                _disarmInstallGuard();
                _installInFlight = false;
                _pendingResume = null;
                _autoFailCount = 0;
                _autoAttemptPending = false;
                _removeInstallListeners();
                _releaseWakeLock();
                db.resetLibraryInstalledCache();
                return openFromIdb();
            }).catch(function (err) {
                if (err && err.aborted) return;   // superseded by a newer attempt
                _disarmInstallGuard();
                _installInFlight = false;
                _releaseWakeLock();
                console.error('Shards-only install failed:', err);
                // Same honest dead-end screen, but retry — manual OR automatic
                // on the next 'online'/visibility tick — resumes THIS path,
                // never a full 342 MB reinstall.
                _showInstallStalled(null, true, _startShardsOnlyInstall);
            });
        }).catch(function (err) {
            if (err && err.aborted) return;
            console.warn('Shards-only install could not start:', err);
            _showInstallStalled(null, true, _startShardsOnlyInstall);
        });
    }

    function beginInstall(manifest, langs, includeShards) {
        _installPct = 0;
        _installStarted = true;
        document.addEventListener('click', _installGuardHandler, true);
        ui.showLoading(i18n.t('downloadingAll'));
        ui.updateProgress(0);

        var totalMB = Math.round(PPP.downloader.computeInstallBytes(manifest, langs, includeShards) / (1024 * 1024));
        _installInFlight = true;
        _ensureInstallListeners(langs, includeShards);
        _acquireWakeLock();
        return _withStallWatchdog(function (onProgress, signal) {
            return PPP.downloader.firstInstall(onProgress, langs, includeShards, signal);
        }, function (p) {
            var frac = p.totalBytes ? p.loadedBytes / p.totalBytes : 0;
            _installPct = Math.round(frac * 100);
            ui.updateProgress(frac);
            ui.setLoadingText(i18n.t('downloadingAll') + ' ' +
                Math.round(p.loadedBytes / (1024 * 1024)) + ' / ' + totalMB + ' MB');
        }).then(function () {
            _disarmInstallGuard();
            _installInFlight = false;
            _offlinePartial = false;
            _pendingResume = null;
            _autoFailCount = 0;
            _autoAttemptPending = false;
            _removeInstallListeners();
            _releaseWakeLock();
            PPP.offlineStore.requestPersist();
            // The library just arrived — db.js memoizes "is it installed?" and
            // would otherwise keep answering `false` for the rest of the session,
            // sending a damaged shard quietly to the network instead of showing
            // the repair notice (Fable review, 2026-07-27).
            db.resetLibraryInstalledCache();
            return openFromIdb();
        }).catch(function (err) {
            // Cancelled because a newer attempt took over — it owns the screen
            // and the flags now.
            if (err && err.aborted) return;
            _disarmInstallGuard();
            _installInFlight = false;
            _releaseWakeLock();
            console.error('Offline install failed:', err);
            if (err && err.stalled) {
                // Nothing moved for 45 s — almost always wedged storage. The
                // download underneath has been ABORTED by the watchdog (not
                // merely abandoned), so the error screen can keep its automatic
                // resume armed: a connection coming back retries through the
                // same single-flight path as the button, never beside it.
                _showInstallStalled(langs, includeShards);
                return;
            }
            if (err && err.notEnoughStorage) {
                // The device cannot fit the download. Say so plainly and stop.
                // There is no "continue without it" any more (Rājan 2026-07-26,
                // all-or-nothing): a half-installed library is exactly the
                // state this design exists to prevent. Freeing space and
                // reloading resumes from where it stopped.
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
                    _stopAutoResume();
                    ui.toast(i18n.t('offlineStorageFull').replace('{left}', String(leftMB)));
                } else {
                    ui.toast(i18n.t('offlineInterrupted').replace('{left}', String(leftMB)) +
                        _installFailDetail(err));
                }
                return PPP.downloader.isCoreReady().then(function (ready) {
                    if (ready) return openFromIdb();
                    // Core not on the device yet. This used to drop into
                    // loadDataLegacy() — the THIRD way a failed install quietly
                    // turned the mandatory gate into an optional one (28468a2
                    // closed the other two, 1d). A partial install with no
                    // usable core is not a working app: "In Text" has no
                    // shards, transcripts have no records, and the user is
                    // silently handed the half-app the all-or-nothing design
                    // exists to prevent. Same honest screen as every other
                    // install failure — error + Try again, gate still closed.
                    _showInstallStalled(langs, includeShards);
                }, function () {
                    // Even the readiness probe failed — still no reason to open
                    // an app without data behind it.
                    _showInstallStalled(langs, includeShards);
                });
            }
            // A first install that failed outright. It used to drop into the
            // online app here — which quietly turned the mandatory gate into an
            // optional one, the exact opposite of the decision (Rājan
            // 2026-07-26). Progress is durable, so the retry resumes where it
            // stopped; until it succeeds the app stays gated, but never frozen
            // and never silent. The auto-resume listeners stay armed (budgeted
            // by AUTO_FAIL_MAX inside _installRetryTick) so a network blip
            // resumes by itself instead of demanding a click.
            _showInstallStalled(langs, includeShards);
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
        // Timeout-hardened (Rājan 2026-07-26): a wedged IndexedDB read must
        // not leave this panel's "add language" section blank forever —
        // fall back to "shards not installed", the same default an absent
        // store already uses.
        var shardsStatePromise = (PPP.offlineStore && PPP.offlineStore.getState)
            ? _raceTimeout(PPP.offlineStore.getState('shards'), 4000, false) : Promise.resolve(false);
        Promise.all([
            PPP.downloader.fetchManifest(),
            PPP.downloader.getInstalledLangs(),
            shardsStatePromise
        ]).then(function (res) {
            var manifest = res[0], installed = res[1], shardsInstalled = !!res[2];
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

            if (available.length > 0) {
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
            }

            // Library installed but the sentence shards (offline "In Text"
            // search) were opted out at install time — offer to add them
            // separately (this is what the mobile size-warning's "Install
            // library now" button lands on for exactly this device state).
            if (!shardsInstalled && manifest.sentenceShards && manifest.sentenceShards.length > 0) {
                _renderAddShardsUI(holder, manifest);
            }
        }).catch(function (e) { console.warn('Add-language UI failed:', e); });
    }

    /**
     * Offer to add the sentence shards to an already-installed library that
     * opted out of them (see _renderAddLanguageUI above). Appended into the
     * SAME holder as the language-add UI, so both can coexist.
     */
    function _renderAddShardsUI(holder, manifest) {
        var shardBytes = 0;
        (manifest.sentenceShards || []).forEach(function (s) { if (s && s.size) shardBytes += s.size; });
        var mb = Math.round(shardBytes / 1048576);

        var wrap = document.createElement('div');
        wrap.id = 'offlineAddShards';
        wrap.className = 'offline-lang-row offline-shard-row';

        var line = document.createElement('div');
        line.textContent = i18n.t('offlineShardsOffer').replace('{size}', String(mb));
        wrap.appendChild(line);

        var addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.id = 'offlineAddShardsBtn';
        addBtn.className = 'search-button';
        addBtn.textContent = i18n.t('offlineAddShardsBtn');
        addBtn.onclick = function () { _runAddShards(wrap); };
        wrap.appendChild(addBtn);

        holder.appendChild(wrap);
    }

    function _runAddShards(holder) {
        holder.innerHTML = '';
        var msg = document.createElement('span');
        msg.textContent = i18n.t('offlineDownloading')
            .replace('{loaded}', '0').replace('{total}', '?').replace('{pct}', '0');
        holder.appendChild(msg);
        PPP.downloader.addShards(function (p) {
            var mb = Math.round(p.loadedBytes / 1048576);
            var totalMB = Math.round(p.totalBytes / 1048576);
            var pct = p.totalBytes ? Math.round(p.loadedBytes / p.totalBytes * 100) : 0;
            msg.textContent = i18n.t('offlineDownloading')
                .replace('{loaded}', mb).replace('{total}', totalMB).replace('{pct}', pct);
        }).then(function () {
            holder.innerHTML = '';
            var done = document.createElement('span');
            done.textContent = i18n.t('offlineShardsAdded');
            holder.appendChild(done);
            var reloadBtn = document.createElement('button');
            reloadBtn.type = 'button';
            reloadBtn.className = 'search-button';
            reloadBtn.textContent = i18n.t('offlineReloadBtn');
            reloadBtn.onclick = function () { location.reload(); };
            holder.appendChild(reloadBtn);
        }).catch(function (err) {
            console.error('Add shards failed:', err);
            holder.innerHTML = '';
            var em = document.createElement('span');
            em.textContent = i18n.t('offlineOfferError');
            holder.appendChild(em);
        });
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

        // Selection is read at click time; defaults to EN-only, shards ON
        // (mandatory — Rājan 2026-07-28: only languages are opt-out) until
        // the manifest arrives and the checkboxes render.
        var getLangs = function () { return []; };
        var getIncludeShards = function () { return true; };
        // Set by the resume check below; both blocks are async, so the
        // from-scratch copy must never overwrite the resume copy.
        var hasResume = false;
        PPP.downloader.fetchManifest().then(function (manifest) {
            _cacheBaseMB(manifest);
            if (!document.body.contains(selHolder)) return;
            var selector = _buildLangSelector(manifest, { baseChecked: true, sizeMode: 'total', shardsForced: true });
            selHolder.innerHTML = '';
            selHolder.appendChild(selector.el);
            getLangs = selector.getLangs;
            getIncludeShards = selector.getIncludeShards;
            if (hasResume) { selHolder.style.display = 'none'; return; }
            var mb = Math.round(PPP.downloader.computeInstallBytes(manifest, [], true) / 1048576);
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
            // Selection: explicit arg wins. The `sel == null` branch below is
            // a TEST/CI HOOK ONLY (ppp_auto_install) — every real caller
            // (see grep 2026-07-28) passes langs/includeShards explicitly,
            // with includeShards always true (shards are mandatory, see
            // _autoInstallShards() comment above). No real user reaches the
            // `false` default at the bottom of this branch.
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
            // Cancellable and registered like every other install path, so a
            // gated install starting later stops this pool instead of running
            // beside it (A1 — two pools over the same 342 MB).
            var handle = _makeAbortHandle();
            var work = PPP.downloader.firstInstall(function (p) {
                var mb = Math.round(p.loadedBytes / 1048576);
                var pct = p.totalBytes ? Math.round(p.loadedBytes / p.totalBytes * 100) : 0;
                var m = document.getElementById('offlineProgressMsg');
                if (m) {
                    m.textContent = i18n.t('offlineDownloading')
                        .replace('{loaded}', mb).replace('{total}', totalMB).replace('{pct}', pct);
                }
            }, sel, incShards, handle.signal);
            _registerInstallJob(handle, work);
            return work.then(function () {
                if (handle.aborted) return;     // superseded by a newer attempt
                _installInFlight = false;
                _offlinePartial = false;
                _autoFailCount = 0;
                _pendingResume = null;
                _autoAttemptPending = false;
                _removeInstallListeners();
                _releaseWakeLock();
                PPP.offlineStore.requestPersist();
                db.resetLibraryInstalledCache();   // see beginInstall
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
            // Cancelled because another install path took over — that one owns
            // the flags and the UI now; touching them here would undo it.
            if (err && err.aborted) return;
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
                        _stopAutoResume();
                        errMsg.textContent = i18n.t('offlineStorageFull').replace('{left}', String(leftMB));
                    } else {
                        _autoFailCount++;
                        if (_autoFailCount >= AUTO_FAIL_MAX) {
                            // Same failure keeps repeating — stop the automatic
                            // loop so this message stays readable and the
                            // failing item's name reaches the user.
                            _removeInstallListeners();
                        }
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
                retryBtn.onclick = function () {
                    // A human pressed Retry — reset the automatic-failure
                    // budget and re-arm the resume listeners for this attempt.
                    _autoFailCount = 0;
                    _ensureInstallListeners(_retryLangs, _retryShards);
                    startBackgroundInstall(_retryLangs, _retryShards);
                };
                b.appendChild(retryBtn);
            }
        });
    }

    /**
     * Background delta check (installed state, online). Applies changed
     * packs/core files to IDB, then refreshes the running app in place.
     */
    /* ---- Resuming an interrupted delta without a page reload ---------------
     * checkForUpdates() is resumable as of 2026-07-28 (downloader.js): whatever
     * a killed migration already fetched stays on disk and the next attempt
     * pulls only the rest. But "the next attempt" used to mean the next PAGE
     * LOAD — the only caller is the boot path — so a migration that died when
     * the connection dropped sat there until the user happened to reopen the
     * app, which on the measured device meant the whole 236 MB again later.
     *
     * So a delta that ends in an error re-arms itself for the next 'online'
     * event. Bounded three ways, because an unbounded retry over a metered
     * connection is a worse bug than the one it fixes:
     *   - one attempt in flight at a time (an 'online' burst cannot start two
     *     download pools; that was P21's lesson on the install path),
     *   - the listener is one-shot and only re-armed by another failure,
     *   - and a hard cap on automatic attempts per session.
     * A successful (or simply uneventful) check disarms everything.
     */
    var _deltaCheckInFlight = false;
    var _updateGateInFlight = false;   // the consent gate below, one at a time
    var _deltaRetryHandler = null;
    var _deltaAutoRetries = 0;
    var DELTA_MAX_AUTO_RETRIES = 5;

    function _disarmDeltaRetry() {
        if (!_deltaRetryHandler) return;
        window.removeEventListener('online', _deltaRetryHandler);
        _deltaRetryHandler = null;
    }

    function _armDeltaRetry() {
        if (_deltaRetryHandler) return;
        if (_deltaAutoRetries >= DELTA_MAX_AUTO_RETRIES) return;
        _deltaRetryHandler = function () {
            _disarmDeltaRetry();
            _deltaAutoRetries++;
            backgroundUpdateCheck();
        };
        window.addEventListener('online', _deltaRetryHandler);
    }

    /* ---- The library does not update behind the user's back (2026-07-28) ---
     * Measured on a real S23 Ultra: an installed device moving to the next
     * corpus generation downloaded 240 MB with no warning, no progress and no
     * question. Rājan: "to pārvērst jautājumā — bibliotēka atjaunojas, 240 MB —
     * tagad vai Wi-Fi tīklā".
     *
     * So backgroundUpdateCheck() is now a GATE in front of the delta, not the
     * delta itself:
     *   1. getPendingUpdate() — a pure read (manifest + IDB), no /data/ bytes.
     *   2. Nothing to download (no library, deletions only, plan unavailable)
     *      -> behave exactly as before. A free update is not worth a question.
     *   3. Bytes to download -> ask, ONCE per generation, and keep serving the
     *      previous generation untouched until the answer comes. Nothing is
     *      deleted and nothing is fetched while the question is open: the delta
     *      never starts, so the atomic generation switch in downloader.js is
     *      not entered at all.
     *
     * FIRST INSTALL IS NOT AFFECTED. This gate sits only on the path taken by a
     * device that already holds a `localManifest` (getPendingUpdate returns
     * null otherwise). A first install is agreed to at install time and its
     * download stays mandatory — Rājan 2026-07-28: only languages are opt-out.
     */
    var UPDATE_CONSENT_KEY = 'updateConsent';
    // How long a "later" (with no way to detect Wi-Fi) stays silent before the
    // question is asked again. A deferral must not become a permanent one — the
    // device would sit on an old corpus forever — but re-asking on every boot
    // is exactly the nagging the deferral exists to prevent.
    var UPDATE_DEFER_RECHECK_MS = 24 * 60 * 60 * 1000;
    // How many times a consented generation may fail before the app stops
    // retrying it by itself and puts the choice back to the user (Codex
    // MEDIUM-2). Three covers a bad connection; a fourth means the download
    // is not going to work and silence would be the wrong answer.
    var UPDATE_MAX_CONSENTED_ATTEMPTS = 3;

    /**
     * What kind of connection is this, as far as the browser will actually say?
     *   'wifi'    — unmetered by declaration (wifi / ethernet).
     *   'metered' — cellular, or the user asked to save data.
     *   'unknown' — the browser does not say, and we do not guess.
     *
     * WHAT HAPPENS WHEN THE API IS NOT THERE. navigator.connection.type is
     * Android Chrome (and derivatives); Safari/iOS and desktop Firefox have no
     * NetworkInformation at all, and several browsers expose `effectiveType`
     * (a SPEED estimate: '4g', '3g'…) without `type`. effectiveType is
     * deliberately NOT read here: a fast cellular link reports '4g' and a slow
     * hotel Wi-Fi reports '2g', so treating it as a medium would tell the user
     * "we will wait for Wi-Fi" and then spend their mobile data — the precise
     * lie this whole change exists to remove. Unknown stays unknown, and the
     * UI says "later" instead of "on Wi-Fi" (see _renderUpdateConsentPrompt).
     */
    function _netClass() {
        var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (!c) return 'unknown';
        if (c.saveData === true) return 'metered';   // explicit user preference
        var t = c.type;
        if (typeof t !== 'string' || !t) return 'unknown';
        if (t === 'wifi' || t === 'ethernet') return 'wifi';
        if (t === 'cellular' || t === 'wimax') return 'metered';
        return 'unknown';   // 'none', 'bluetooth', 'other', 'unknown'
    }

    function _readUpdateConsent() {
        var store = PPP.offlineStore;
        if (!store || !store.getState) return Promise.resolve(null);
        return store.getState(UPDATE_CONSENT_KEY).catch(function () { return null; });
    }

    function _writeUpdateConsent(rec) {
        var store = PPP.offlineStore;
        if (!store || !store.setState) return Promise.resolve();
        return store.setState(UPDATE_CONSENT_KEY, rec).catch(function () {});
    }

    // The plan a deferral is waiting on, plus its listeners. Kept in memory
    // only: the DURABLE half is the consent record in IndexedDB, which is what
    // survives a reload and stops the question coming back.
    var _deferredUpdate = null;
    var _deferredListener = null;

    function _disarmDeferredUpdate() {
        if (!_deferredListener) return;
        window.removeEventListener('online', _deferredListener);
        var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (c && c.removeEventListener) c.removeEventListener('change', _deferredListener);
        _deferredListener = null;
        _deferredUpdate = null;
    }

    /**
     * Hold a deferred update and start it BY ITSELF the moment the connection
     * the user asked for appears. Listens to the two events that can change the
     * answer: NetworkInformation 'change' (the medium changed) and window
     * 'online' (the device reconnected — the medium may be different now).
     * When the class cannot be observed at all, nothing is armed: the promise
     * would be one we cannot keep. That deferral is time-based instead, and is
     * re-offered by the gate on a later boot (UPDATE_DEFER_RECHECK_MS).
     */
    function _armDeferredUpdate(plan) {
        // A newer generation supersedes whatever was being waited for: keeping
        // the old listener would start a download for a plan the server has
        // already moved past.
        if (_deferredUpdate && _deferredUpdate.generation !== plan.generation) _disarmDeferredUpdate();
        if (_deferredListener) return;
        _deferredUpdate = plan;
        _deferredListener = function () {
            if (_netClass() !== 'wifi') return;
            var p = _deferredUpdate;
            _disarmDeferredUpdate();
            // Record the promotion to a "yes" BEFORE starting, so an
            // interrupted auto-start resumes instead of asking again.
            _writeUpdateConsent({ gen: p.generation, decision: 'now', ts: Date.now() })
                .then(function () { _startConsentedUpdate(p); });
        };
        window.addEventListener('online', _deferredListener);
        var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (c && c.addEventListener) c.addEventListener('change', _deferredListener);
    }

    /**
     * The question itself, in the same non-blocking box the optional install
     * uses (#offlineProgress). NOT a modal on purpose: requirement 3 is that
     * the app keeps working on the previous, whole generation while the
     * question is open — a modal would make "keep using what you have" a lie.
     */
    function _renderUpdateConsentPrompt(plan) {
        var box = document.getElementById('offlineProgress');
        if (!box) return;
        var mb = Math.round(plan.bytes / 1048576);
        var metered = _netClass() === 'metered';
        // Asking again replaces any earlier deferral — the question on screen
        // is now the only live one.
        _disarmDeferredUpdate();
        box.style.display = 'flex';
        box.innerHTML = '';

        var msg = document.createElement('span');
        msg.id = 'libraryUpdatePromptMsg';
        msg.textContent = i18n.t('libraryUpdateAsk').replace('{size}', String(mb));
        box.appendChild(msg);

        var now = document.createElement('button');
        now.type = 'button';
        now.id = 'libraryUpdateNowBtn';
        now.className = 'search-button';
        now.textContent = i18n.t('libraryUpdateNowBtn');
        now.onclick = function () {
            _writeUpdateConsent({ gen: plan.generation, decision: 'now', ts: Date.now() })
                .then(function () { _startConsentedUpdate(plan); });
        };
        box.appendChild(now);

        var later = document.createElement('button');
        later.type = 'button';
        later.id = 'libraryUpdateLaterBtn';
        later.className = 'search-button';
        // Only promise Wi-Fi when the browser is telling us the medium AND it
        // is currently a metered one. Otherwise the honest word is "later".
        later.textContent = i18n.t(metered ? 'libraryUpdateWifiBtn' : 'libraryUpdateLaterBtn');
        later.onclick = function () {
            box.innerHTML = '';
            box.style.display = 'none';
            _writeUpdateConsent({
                gen: plan.generation,
                decision: 'later',
                ts: Date.now(),
                mode: metered ? 'wifi' : 'time'
            }).then(function () {
                if (metered) _armDeferredUpdate(plan);
            });
        };
        box.appendChild(later);
    }

    /**
     * Run the delta the user agreed to, with the progress they were promised,
     * in the same box the question was asked in. Non-blocking throughout — the
     * app stays usable, exactly as it is during a background install.
     */
    function _startConsentedUpdate(plan) {
        var box = document.getElementById('offlineProgress');
        var totalMB = Math.round(plan.bytes / 1048576);
        if (box) {
            box.style.display = 'flex';
            box.innerHTML = '';
            var msg = document.createElement('span');
            msg.id = 'libraryUpdateProgressMsg';
            msg.textContent = i18n.t('libraryUpdating')
                .replace('{loaded}', '0').replace('{total}', String(totalMB)).replace('{pct}', '0');
            box.appendChild(msg);
        }
        _runDeltaUpdate(function (p) {
            var m = document.getElementById('libraryUpdateProgressMsg');
            if (!m) return;
            // The delta's own total is authoritative: a resumed update has less
            // left to fetch than the plan originally quoted, and a bar that
            // stops at 60 % because it is measured against the old number is
            // its own bug report.
            var total = p.totalBytes || plan.bytes;
            m.textContent = i18n.t('libraryUpdating')
                .replace('{loaded}', String(Math.round(p.loadedBytes / 1048576)))
                .replace('{total}', String(Math.round(total / 1048576)))
                .replace('{pct}', String(total ? Math.round(p.loadedBytes / total * 100) : 0));
        }, function (res) {
            var b = document.getElementById('offlineProgress');
            if (b) { b.innerHTML = ''; b.style.display = 'none'; }
            if (!PPP.offlineStore || !PPP.offlineStore.deleteState) return;
            // `busy` is another tab holding the delta claim (Codex MEDIUM-1):
            // nothing happened here, so nothing is counted and nothing is
            // retired — the decision stands and the next check picks it up.
            if (res && res.busy) return;
            // A finished generation switch retires its decision: the record is
            // keyed to a generation that is now the installed one, and leaving
            // it behind would only be answering a question nobody is asking.
            if (!res || !res.error) {
                PPP.offlineStore.deleteState(UPDATE_CONSENT_KEY).catch(function () {});
                return;
            }
            // A FAILED delta keeps the decision so the automatic retry resumes
            // the download the user already said yes to — but only so many
            // times (Codex MEDIUM-2). A generation that fails permanently
            // (server-side corruption, a device out of room) otherwise retried
            // on every single load, forever, silently spending data on a
            // download that cannot finish and never asking again. Past the cap
            // the decision is dropped, which means the next check asks — the
            // user gets the choice back instead of an invisible loop.
            _readUpdateConsent().then(function (c) {
                if (!c || c.gen !== plan.generation || c.decision !== 'now') return;
                var attempts = (c.attempts || 0) + 1;
                if (attempts >= UPDATE_MAX_CONSENTED_ATTEMPTS) {
                    console.warn('Offline update failed ' + attempts +
                        ' times for this generation — asking again instead of retrying');
                    return PPP.offlineStore.deleteState(UPDATE_CONSENT_KEY).catch(function () {});
                }
                c.attempts = attempts;
                return _writeUpdateConsent(c);
            });
        });
    }

    /**
     * The gate. See the block comment above.
     */
    function backgroundUpdateCheck() {
        if (_deltaCheckInFlight || _updateGateInFlight) return;
        // Another TAB is already downloading a delta (Codex MEDIUM-1). Do not
        // even ask: the question would be about a download already under way,
        // and two "yes"es fetch the same bytes twice. checkForUpdates() refuses
        // independently of this — the check here only keeps a pointless
        // question off the screen.
        if (PPP.downloader.isDeltaRunningElsewhere && PPP.downloader.isDeltaRunningElsewhere()) return;
        if (!PPP.downloader.getPendingUpdate) { _runDeltaUpdate(); return; }
        _updateGateInFlight = true;
        PPP.downloader.getPendingUpdate().then(function (plan) {
            _updateGateInFlight = false;
            // The plan could not be made (manifest fetch failed, IDB unreadable).
            // Fail CLOSED: do not fall through to an unmetered download on a
            // number we do not have. The retry path re-runs the whole gate.
            if (plan && plan.error) { _armDeltaRetry(); return; }
            // Nothing to decide: not installed, or a generation that only
            // removes things. Same behaviour as before this gate existed.
            if (!plan || !plan.bytes) { _runDeltaUpdate(); return; }
            // A download already agreed to and part-done — asking again in the
            // middle would be worse than not asking at all.
            if (plan.resumed) { _startConsentedUpdate(plan); return; }
            _readUpdateConsent().then(function (c) {
                var sameGen = c && c.gen === plan.generation;
                if (sameGen && c.decision === 'now') { _startConsentedUpdate(plan); return; }
                if (sameGen && c.decision === 'later') {
                    if (c.mode === 'wifi') {
                        // Conditional deferral: start now if the condition is
                        // already true on this boot, otherwise wait for it.
                        if (_netClass() === 'wifi') {
                            _writeUpdateConsent({ gen: plan.generation, decision: 'now', ts: Date.now() })
                                .then(function () { _startConsentedUpdate(plan); });
                        } else {
                            _armDeferredUpdate(plan);
                        }
                        return;
                    }
                    // Time-based deferral (Wi-Fi undetectable): stay silent
                    // until the recheck window has passed, then ask again.
                    if (Date.now() - (c.ts || 0) < UPDATE_DEFER_RECHECK_MS) return;
                }
                _renderUpdateConsentPrompt(plan);
            });
        }, function (err) {
            _updateGateInFlight = false;
            console.warn('Update gate failed:', err);
            _armDeltaRetry();
        });
    }

    /**
     * The delta itself — everything backgroundUpdateCheck() used to do inline,
     * unchanged except for the optional progress/finish callbacks.
     */
    function _runDeltaUpdate(onProgress, onSettled) {
        if (_deltaCheckInFlight) {
            // Reported as a failure on purpose: the caller must take its
            // progress box down, and the consent record must NOT be retired —
            // this update has not happened yet.
            if (onSettled) onSettled({ error: new Error('a delta is already running') });
            return;
        }
        _deltaCheckInFlight = true;
        PPP.downloader.checkForUpdates(onProgress).then(function (res) {
            if (onSettled) onSettled(res);
            _deltaCheckInFlight = false;
            // checkForUpdates never rejects — a failed delta comes back as
            // { changedItems: 0, error }. That is the resume trigger.
            if (res && res.error) { _armDeltaRetry(); return; }
            _disarmDeltaRetry();
            if (!res || !res.changedItems) return;
            // A delta rewrote part of the library, which invalidates db.js's
            // memoized "is it installed?" answer along with the shard list.
            db.resetLibraryInstalledCache();
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
            // REMOVED 2026-07-27: the `coreChanged.sentences` branch that called
            // db.reloadSentencesFromStore(). `sentences` left CORE_KEYS
            // (downloader.js) because nothing ever opened that whole-file DB, so
            // the flag can no longer be set and the reload would have nothing to
            // reload. Sentence freshness rides entirely on the shards — see the
            // resetSentenceShards() call immediately below, which is the live path.
            // Shard set / shard versions can change in the same delta. The
            // chunked search memoizes them from manifest.json at first use, so
            // drop that cache whenever anything was applied — cost is one
            // small manifest re-fetch on the next sentence search.
            if (db.resetSentenceShards) db.resetSentenceShards();
        }, function (err) {
            // Defensive: checkForUpdates() is written never to reject, but a
            // throw here must not leave the in-flight latch stuck true and the
            // delta path dead for the rest of the session.
            if (onSettled) onSettled({ error: err });
            _deltaCheckInFlight = false;
            console.warn('Offline update check threw:', err);
            _armDeltaRetry();
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

        // "In Text" (sentence) search only runs from the offline sentence
        // shards now (Rājan decision 2026-07-26: online text search is no
        // longer offered at all — one full search used to transfer ~200 MB,
        // ~34 min on Fast-3G). When the shards aren't installed, explain and
        // offer the install instead of searching — see
        // _requireTextSearchLibrary below. Metadata/citations searches never
        // needed the shards and are not gated here.
        if (searchMode === 'sentences' && term) {
            // Engage the busy lock SYNCHRONOUSLY, before the gate's own async
            // IndexedDB read below — _requireTextSearchLibrary's
            // store.getState('shards').then(...) always defers to a microtask,
            // even when already resolved. Without this, a second call issued
            // in the very same tick (rapid double-dispatch, or a mode/language
            // switch attempted immediately after search()) would race past the
            // "if (_sentenceSearchBusy)" guard above because the flag hadn't
            // been set yet — see test 36f. performSentenceSearch below
            // re-asserts the same flag (harmless no-op); if the gate instead
            // blocks the search (shards not installed), release it again so
            // the UI is never left stuck "busy".
            _sentenceSearchBusy = true;
            _requireTextSearchLibrary(function () { _runSearch(term); }, function () { _sentenceSearchBusy = false; });
            return;
        }
        _runSearch(term);
    }

    function _runSearch(term) {
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

    // ---- "In Text" requires the installed library -------------------------
    // Rājan decision 2026-07-26: online text search is no longer offered at
    // all — one full "In Text" search used to transfer ~200 MB of sentence
    // shards (~34 min on Fast-3G). This supersedes the earlier mobile-only
    // warning dialog (mobileSearchWarn*, tests 51-53, removed): instead of a
    // dismissable warning, the search simply does not run online — it
    // explains that text search works from the downloaded library and
    // offers the EXISTING offline-install flow (#offlineInfoPanel /
    // renderOfflineInfoPanel) instead of a second/duplicate installer.

    /**
     * Gate before performSentenceSearch: run it only when the offline
     * sentence shards are installed (offlineStore state key 'shards', the
     * same one downloader.js persists at install time — see downloader.js
     * firstInstall/checkForUpdates). Otherwise render the install notice.
     *
     * Rājan field report (2026-07-26): store.getState('shards') can hang
     * indefinitely on a real device (private browsing, a blocking tab, a
     * wedged webview) — a plain .then()/.catch() leaves the click
     * unanswered forever because a promise that never settles never
     * rejects either. Raced against a short timeout (_raceTimeout) so ANY
     * outcome other than a definite "installed" — falsy, rejected, OR
     * timed out — shows the install notice within a few seconds. This also
     * fixes the OLD behaviour of quietly calling proceed() on a store
     * error/absence: since this feature shipped, proceed() runs a sentence
     * search with nothing left to search online, which used to no-op just
     * as silently as the hang itself.
     */
    function _requireTextSearchLibrary(proceed, onBlocked) {
        var store = PPP.offlineStore;
        if (!store || !store.getState) {
            if (onBlocked) onBlocked();
            _renderTextSearchInstallNotice();
            return;
        }
        _raceTimeout(store.getState('shards'), 4000, _OFFLINE_READ_TIMEOUT).then(function (installed) {
            if (installed === true) { proceed(); return; }
            if (onBlocked) onBlocked();
            _renderTextSearchInstallNotice();
        });
    }

    /**
     * Clean explanation in place of results (never a raw error) + a button
     * that opens the SAME offline-install panel used everywhere else. Does
     * not touch the results table itself — a later successful search
     * replaces #resultsInfo the normal way.
     */
    function _renderTextSearchInstallNotice() {
        var info = document.getElementById('resultsInfo');
        if (!info) return;
        var mb = _shardsMB();
        info.innerHTML = '';
        var msg = document.createElement('div');
        msg.className = 'quotes-require-install';
        msg.textContent = i18n.t('quotesRequireInstallBody').replace('{size}', String(mb));
        info.appendChild(msg);
        // _shardsMB() falls back to a figure baked in on 2026-07-26 whenever no
        // manifest fetch has cached the real one yet — which is the norm on the
        // path that reaches this notice (a returning device with nothing
        // installed never renders the install prompt). Quote the real number
        // as soon as the manifest lands, so this cannot drift as shards change.
        _getManifest().then(function (m) {
            if (!m) return;
            _cacheBaseMB(m);
            var real = _shardsMB();
            if (real !== mb && msg.isConnected) {
                msg.textContent = i18n.t('quotesRequireInstallBody').replace('{size}', String(real));
            }
        });
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'search-button';
        btn.textContent = i18n.t('quotesRequireInstallBtn');
        btn.onclick = function () {
            var panel = document.getElementById('offlineInfoPanel');
            if (!panel) return;
            renderOfflineInfoPanel();
            panel.style.display = 'flex';
        };
        info.appendChild(btn);
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

        // Pass navView so the "By Added" list can show the added date
        // under the title (the visible Date column is the LECTURE date,
        // not when it was added — that ambiguity was the root of Rājan's
        // "By Added looks wrong" report, 2026-07-31).
        ui.renderResults(allResults, lastSearchTerm, startIndex, endIndex, matchHints, navView === 'byAdded');
        ui.renderPagination(totalResults, currentPage, pageSize, changePage);

        _showSelectToggle(totalResults > 0);
        _updateSelectBar();
        _updateTipStrip();
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

    /** Premium transcript HTML for the ZIP: installed library first, network
     *  second. A store read that fails or comes back empty is not an error —
     *  it just means "not in the library", so fall through to the network. */
    function _zipPremiumHtml(nr, lang, signal) {
        var key = 't:' + lang + ':' + String(nr);
        var fromStore = (PPP.offlineStore && PPP.offlineStore.supported())
            ? PPP.offlineStore.getText(key).catch(function () { return null; })
            : Promise.resolve(null);
        return fromStore.then(function (txt) {
            if (txt && txt.trim()) return txt;
            return fetch('transcripts/' + lang + '/' + encodeURIComponent(String(nr)) + '.html', { signal: signal })
                .then(function (r) { return r.ok ? r.text() : ''; })
                .catch(function (e) {
                    if (e && e.name === 'AbortError') throw e;
                    return '';                      // offline and not installed
                });
        });
    }

    /** Raw EN transcript text for the ZIP: installed library first, Drive
     *  second. Returns '' when neither has it. */
    function _zipRawText(nr, driveId, signal) {
        var fromStore = (PPP.offlineStore && PPP.offlineStore.supported())
            ? PPP.offlineStore.getText('raw:en:' + String(nr)).catch(function () { return null; })
            : Promise.resolve(null);
        return fromStore.then(function (txt) {
            if (txt && txt.trim()) return txt;
            if (!driveId) return '';
            var key = (PPP.config && PPP.config.driveApiKey) || '';
            var url = 'https://www.googleapis.com/drive/v3/files/' + driveId +
                '?alt=media&key=' + encodeURIComponent(key);
            return fetch(url, { signal: signal }).then(function (rr) {
                return rr.status === 200 ? rr.text() : '';
            }).catch(function (e) {
                if (e && e.name === 'AbortError') throw e;
                return '';
            });
        });
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
        // The installed library FIRST. ZIP was written before the offline
        // library existed and still asked the network for premium HTML and
        // Google Drive for raw text — both of which are already on the device
        // (Rājan spotted this, 2026-07-26). So ZIP did not work offline at all,
        // and online it re-downloaded what the user had already paid for. Same
        // two keys the transcript viewer uses; the network stays as the fallback
        // for a lecture the library does not contain.
        return _zipPremiumHtml(nr, lang, signal)
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
                // Premium missing (not in the library, 404 / empty). Raw fallback
                // exists only in EN — library first, Drive second.
                if (lang === 'en') {
                    return _zipRawText(nr, _driveIdFromUrl(meta && meta.enUrl), signal).then(function (txt) {
                        if (!txt || !txt.trim()) return 'unavailable';
                        // A raw record from the library is already HTML paragraphs
                        // (build_raw_en_transcripts.py); the Drive copy is plain
                        // text. Wrap only the plain-text case so the same
                        // DOM-based highlighter can mark sentences/words either way.
                        var body = /<p[\s>]/i.test(txt)
                            ? txt
                            : txt.split(/\r?\n/).map(function (line) {
                                return '<p>' + utils.escapeHtml(line) + '</p>';
                            }).join('\n');
                        var container = document.createElement('div');
                        container.innerHTML = body;
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

    function downloadSelectedZip(zipName) {
        // Offline guard — but only where it is still true. Transcript bodies now
        // come from the installed library first (_zipPremiumHtml / _zipRawText),
        // so a device with the library can build a transcript ZIP with no
        // network at all. This guard used to reject that outright, which meant
        // the "read from the library" change did nothing for offline users —
        // exactly what its commit message claimed it fixed (Fable review,
        // 2026-07-27). MP3s are the genuine exception: audio is not in the
        // library and only Drive has it.
        if (!net.online) {
            var hasLibrary = !!(PPP.offlineStore && PPP.offlineStore.supported() && _offlineInstalled);
            var mp3Only = Array.from(selectedNrs).every(function (k) { return k.split('|')[1] === 'mp3'; });
            if (!hasLibrary || mp3Only) {
                ui.toast(i18n.t('requiresInternet'));
                return Promise.resolve();
            }
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

    // ===== FILTERS PANEL (Years + Countries) =====
    //
    // Replaces the old "By 2026" quick button. The button toggles a panel of
    // year + country checkboxes; "Apply" writes readable filter tokens
    // (`year:2024,2025; country:RUS,LVA`) into the search field and runs the
    // normal metadata search (parsed by search.js). The panel is rebuilt from
    // live data on every open and always starts with nothing checked — no
    // filter state survives a reload (deliberate: a hidden sticky filter is a
    // classic "why are results missing?" trap).
    var _filterOptions = null;   // cached {years, countries} derived from data

    function _buildFilterOptions(rows) {
        var cfg = (window.PPP && PPP.config) || {};
        var years = {}, countries = {}, langs = {}, sources = {};
        rows.forEach(function (r) {
            var ym = String(r.date || '').match(/^(\d{4})/);
            if (ym) years[ym[1]] = true;
            var code = cfg.normalizeCountry ? cfg.normalizeCountry(r.country) : null;
            if (code) countries[code] = true;
            var lv = cfg.isFilterableLang ? cfg.isFilterableLang(r.lang) : null;
            if (lv) langs[lv] = true;
            var sv = String(r.source || '').trim();
            if (sv) sources[sv] = true;
        });
        return {
            years: Object.keys(years).sort(function (a, b) { return b - a; }),   // newest first
            // Alphabetical by 3-letter code, with "Online" pinned to the end
            // (Rājan: it is not a place, so it reads as the tail option).
            countries: Object.keys(countries).sort(function (a, b) {
                if (a === 'Online') return 1;
                if (b === 'Online') return -1;
                return a.toUpperCase() < b.toUpperCase() ? -1 : 1;
            }),
            langs: Object.keys(langs).sort(),
            sources: Object.keys(sources).sort(function (a, b) {
                return a.toLowerCase() < b.toLowerCase() ? -1 : 1;
            })
        };
    }

    function _getFilterOptions() {
        if (_filterOptions) return Promise.resolve(_filterOptions);
        if (usingSqlite) {
            return db.queryMetaAsync("SELECT date, country, lang, source FROM lectures WHERE nr != ''")
                .then(function (rows) { _filterOptions = _buildFilterOptions(rows); return _filterOptions; });
        }
        var mem = (DB || []).map(function (r) {
            return {
                date: r['Date'] || r.date,
                country: r['Country'] || r.country,
                lang: r['Lang.'] || r.lang,
                source: r['Source'] || r.source
            };
        });
        _filterOptions = _buildFilterOptions(mem);
        return Promise.resolve(_filterOptions);
    }

    // One checkbox row. `cls` is the facet class the Apply reader queries.
    function _fltItem(cls, value, label, extra) {
        var esc = utils.escapeHtml;
        return '<label class="flt-item' + (extra ? ' flt-extra' : '') + '"' + (extra ? ' hidden' : '') + '>' +
            '<input type="checkbox" class="' + cls + '" value="' + esc(value) + '">' +
            '<span>' + esc(label) + '</span></label>';
    }

    // Amazon-style collapsible category: the first option is always visible,
    // the rest sit behind "See more (N)" / "See less". Every option stays in
    // the DOM (only `hidden`), so Apply reads a stable checkbox set whether a
    // section is open or closed.
    function _fltSection(id, title, options) {
        if (!options.length) return '';
        var esc = utils.escapeHtml;
        var items = options.map(function (o, i) {
            return _fltItem(o.cls, o.value, o.label, i > 0);
        }).join('');
        var hiddenCount = options.length - 1;
        var more = hiddenCount > 0
            ? '<button type="button" class="flt-more" aria-expanded="false" ' +
                'onclick="PPP.app.toggleFilterSection(\'' + id + '\', event)">' +
                '<span class="flt-more-label">' + esc(i18n.t('filtersShowMore')) + ' (' + hiddenCount + ')</span>' +
                '<span class="flt-chev" aria-hidden="true">▾</span>' +
              '</button>'
            : '';
        return '<div class="flt-sec" data-sec="' + id + '">' +
            '<div class="flt-title">' + esc(title) + '</div>' +
            '<div class="flt-grid flt-' + id + '">' + items + '</div>' +
            more + '</div>';
    }

    function toggleFilterSection(id, evt) {
        if (evt) evt.stopPropagation();
        var panel = document.getElementById('filtersPanel');
        if (!panel) return;
        var sec = panel.querySelector('.flt-sec[data-sec="' + id + '"]');
        if (!sec) return;
        var extras = sec.querySelectorAll('.flt-extra');
        var btn = sec.querySelector('.flt-more');
        var wasOpen = !!(btn && btn.getAttribute('aria-expanded') === 'true');
        Array.prototype.forEach.call(extras, function (el) { el.hidden = wasOpen; });
        sec.classList.toggle('flt-open', !wasOpen);
        if (!btn) return;
        btn.setAttribute('aria-expanded', wasOpen ? 'false' : 'true');
        var label = btn.querySelector('.flt-more-label');
        if (label) {
            label.textContent = wasOpen
                ? i18n.t('filtersShowMore') + ' (' + extras.length + ')'
                : i18n.t('filtersShowLess');
        }
        var chev = btn.querySelector('.flt-chev');
        if (chev) chev.textContent = wasOpen ? '▾' : '▴';
    }

    function _renderFiltersPanel(panel, opts) {
        var esc = utils.escapeHtml;
        var lang = i18n.getLanguage() || 'en';
        var cfg = PPP.config;
        // The transcript-sentence DB carries date but NOT country/type/lang/
        // source/links/length, so in "In Text" mode only Years is offered.
        var sentenceMode = (searchMode === 'sentences');

        var sections = '';
        if (!sentenceMode) {
            // Country — "LVA — Latvija" in the active UI language (Rājan,
            // 2026-07-31); sorted by code with "Online" last.
            sections += _fltSection('countries', i18n.t('filtersCountries'),
                opts.countries.map(function (code) {
                    return { cls: 'flt-country', value: code, label: code + ' — ' + cfg.countryName(code, lang) };
                }));
            // Language — only "... only" / "a; b" cells (see config.isFilterableLang).
            // The token carries '+' instead of "; " so it survives the field's
            // ';' AND-split.
            sections += _fltSection('langs', i18n.t('filtersLangs'),
                opts.langs.map(function (v) {
                    return { cls: 'flt-lang', value: cfg.encodeLangToken(v), label: v };
                }));
        }
        sections += _fltSection('years', i18n.t('filtersYears'),
            opts.years.map(function (y) { return { cls: 'flt-year', value: y, label: y }; }));
        if (!sentenceMode) {
            sections += _fltSection('types', i18n.t('filtersTypes'),
                cfg.TYPE_ORDER.map(function (value) {
                    // TYPE_ORDER holds the exact DB `Type` strings (Rājan,
                    // 2026-07-31) — no i18n label for these, shown as-is.
                    return { cls: 'flt-type', value: value, label: value };
                }));
            sections += _fltSection('sources', i18n.t('filtersSources'),
                opts.sources.map(function (s) { return { cls: 'flt-source', value: s, label: s }; }));
            sections += _fltSection('links', i18n.t('filtersLinks'),
                cfg.LINKS_ORDER.map(function (p) { return { cls: 'flt-link', value: p, label: p }; }));
            sections += _fltSection('lengths', i18n.t('filtersLength'),
                cfg.LENGTH_RANGES.map(function (r) {
                    return { cls: 'flt-length', value: r.key, label: cfg.lengthRangeLabel(r.key, i18n.t('filtersLengthUnit')) };
                }));
        }

        panel.innerHTML =
            '<div class="flt-cols">' + sections + '</div>' +
            '<div class="flt-actions">' +
                '<button type="button" class="flt-apply" onclick="PPP.app.applyFilters()">' + esc(i18n.t('filtersApply')) + '</button>' +
                '<button type="button" class="flt-clear" onclick="PPP.app.clearFilters()">' + esc(i18n.t('filtersClear')) + '</button>' +
            '</div>';
    }

    function toggleFilters(evt) {
        if (evt) evt.stopPropagation();
        var panel = document.getElementById('filtersPanel');
        if (!panel) return;
        if (!panel.hidden) { closeFilters(); return; }
        if (!dataLoaded) return;
        _getFilterOptions().then(function (opts) {
            _renderFiltersPanel(panel, opts);
            panel.hidden = false;
            var btn = document.querySelector('.main-button-row .combo-btn-1');
            if (btn) btn.classList.add('active');
            document.addEventListener('click', _filtersOutside, true);
            document.addEventListener('keydown', _filtersEsc, true);
        });
    }

    function closeFilters() {
        var panel = document.getElementById('filtersPanel');
        if (panel) panel.hidden = true;
        var btn = document.querySelector('.main-button-row .combo-btn-1');
        if (btn) btn.classList.remove('active');
        document.removeEventListener('click', _filtersOutside, true);
        document.removeEventListener('keydown', _filtersEsc, true);
    }

    function _filtersOutside(e) {
        var panel = document.getElementById('filtersPanel');
        var btn = document.querySelector('.main-button-row .combo-btn-1');
        if (!panel || panel.hidden) return;
        if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
        closeFilters();
    }
    function _filtersEsc(e) { if (e.key === 'Escape' || e.key === 'Esc') closeFilters(); }

    // Shared by applyFilters() and clearFilters(): split the search field on
    // ';' and drop any segment that IS a year:/country:/type: filter token,
    // keeping only free text the user typed (or other tokens like lang:/
    // has:/subject: that these two functions don't own). One parser so both
    // callers can never drift apart on what counts as "a filter token".
    var _FILTER_TOKEN_RE = /^(year|country|type|lang|source|links|length):/i;
    function _keepNonFilterTokens(value) {
        return (value || '').split(';').map(function (s) { return s.trim(); }).filter(Boolean)
            .filter(function (seg) { return !_FILTER_TOKEN_RE.test(seg); });
    }

    function applyFilters() {
        var panel = document.getElementById('filtersPanel');
        if (!panel) return;
        function picked(cls) {
            return Array.prototype.map.call(panel.querySelectorAll(cls + ':checked'), function (c) { return c.value; });
        }
        var years = picked('.flt-year');
        var countries = picked('.flt-country');
        var types = picked('.flt-type');
        var langs = picked('.flt-lang');
        var sources = picked('.flt-source');
        var links = picked('.flt-link');
        var lengths = picked('.flt-length');
        var input = document.getElementById('searchTerm');
        var sentenceMode = (searchMode === 'sentences');

        // Keep any free-text the user already typed; drop only the OLD filter
        // tokens so re-applying replaces (not stacks) year/country/type.
        var kept = _keepNonFilterTokens(input.value);

        var tokens = kept.slice();
        if (years.length) tokens.push('year:' + years.join(','));
        // Country and type apply to lecture metadata only (the sentence DB has
        // neither column), so neither is ever emitted in "In Text" mode.
        if (countries.length && !sentenceMode) tokens.push('country:' + countries.join(','));
        if (types.length && !sentenceMode) tokens.push('type:' + types.join(','));
        if (langs.length && !sentenceMode) tokens.push('lang:' + langs.join(','));
        if (sources.length && !sentenceMode) tokens.push('source:' + sources.join(','));
        if (links.length && !sentenceMode) tokens.push('links:' + links.join(','));
        if (lengths.length && !sentenceMode) tokens.push('length:' + lengths.join(','));
        closeFilters();

        if (sentenceMode) {
            // "In Text": a year narrows a TEXT search — it needs a word to run.
            if (kept.length === 0) { ui.toast(i18n.t('enterSearchTerms')); return; }
            input.value = tokens.join('; ');
            doSearch();
            return;
        }
        // Titles/verse modes → normalize to the metadata search. setSearchMode
        // clears the field on a real mode change, so set the value AFTER it.
        if (searchMode !== 'metadata') setSearchMode('metadata');
        input.value = tokens.join('; ');
        if (tokens.length) doSearch();
    }

    function clearFilters() {
        var panel = document.getElementById('filtersPanel');
        if (!panel) return;
        Array.prototype.forEach.call(panel.querySelectorAll('input[type="checkbox"]'), function (c) { c.checked = false; });

        var input = document.getElementById('searchTerm');
        if (!input) return;

        if (input.classList.contains('combo-display')) {
            // A combo-display label (By Added Date, By Topic, ...) sitting in
            // the field is not a real search term — don't token-parse it,
            // just drop it the same way switching search mode away from a
            // combo view already does (clearComboDisplay(), defined above).
            clearComboDisplay();
        } else {
            input.value = _keepNonFilterTokens(input.value).join('; ');
        }

        if (input.value.trim()) {
            doSearch();
            return;
        }
        // Nothing left to search — reset the result view instead of leaving
        // a stale count/table contradicting the now-empty filter state
        // (Rājan report, 2026-07-25: unticked every checkbox, but the field
        // still showed a leftover filter token and the results still read
        // "0 files found").
        lastSearchTerm = '';
        allResults = [];
        totalResults = 0;
        currentPage = 1;
        matchHints = new Map();
        navView = null;
        transcriptView = null;
        _refreshButtonGroups();
        displayResults();
    }

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
        // "Last update" label is metadata-specific (DB refresh timestamp for
        // the lecture list) — hide it in sentence ("In Text") mode.
        var dbLastUpdate = document.getElementById('dbLastUpdate');
        if (dbLastUpdate) {
            if (mode === 'sentences') dbLastUpdate.style.display = 'none';
            else if (dbLastUpdate.getAttribute('data-last-update')) dbLastUpdate.style.display = '';
        }
        // Clear results and search field when switching modes.
        // Also force the clear for the two plain-text buttons (In Titles /
        // In Text) even when prevMode === mode: a browse view (e.g. Top
        // Searches) can be showing its own results/count/download button
        // while searchMode itself never changed, and clearComboDisplay()
        // below already always empties the field regardless of this guard —
        // leaving the OLD results/count visible under an empty field
        // (Rājan principle, 2026-07-31: clicking In Titles/In Text must
        // land on a fully clean page, not just an empty search box).
        if (prevMode !== mode || mode === 'metadata' || mode === 'sentences') {
            document.getElementById('searchTerm').value = '';
            document.getElementById('resultsInfo').innerHTML = '';
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
                // NOTE: rows already arrive in SQL "added DESC" order — do NOT
                // re-sort by utils.compareDates (lecture date), that silently
                // undoes the added-date ordering and old lectures added
                // recently can jump above newer additions (Rājan report,
                // 2026-07-31).
                var uiRows = rows.map(mapSqlRowToUI);
                lastSearchTerm = i18n.t('latest20Files');
                allResults = uiRows;
                totalResults = uiRows.length;
                currentPage = 1;
                matchHints = new Map();
                document.getElementById('searchTerm').value = i18n.t('latest20Files');
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

        // NOTE: use top20 directly — it is already sorted by Added DESC.
        // Re-filtering DB and re-sorting by utils.compareDates (lecture date)
        // was the same bug as the SQLite branch above: it silently discarded
        // the added-date order (Rājan report, 2026-07-31).
        lastSearchTerm = 'latest_files:' + Array.from(nrSet).join(',');
        allResults = top20;
        totalResults = allResults.length;
        currentPage = 1;
        matchHints = new Map();
        document.getElementById('searchTerm').value = i18n.t('latest20Files');
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
                // OK here (unlike showLatestFiles above): SQL already orders by
                // `date DESC` and compareDates also sorts by lecture date, so
                // this resort is redundant but not a bug — both agree.
                uiRows.sort(utils.compareDates);
                lastSearchTerm = '2026';
                allResults = uiRows;
                totalResults = uiRows.length;
                currentPage = 1;
                matchHints = new Map();
                document.getElementById('searchTerm').value = '2026';
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
            // Favorites is only offered once the user has actually saved one \u2014
            // an empty star button on a first visit is just noise (onboarding spec).
            btn.classList.toggle('has-fav', c > 0);
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
        // Toggle state is tracked via navView (set synchronously below), NOT
        // div.style.display: the panel's content — and its display:'block' —
        // is only applied once the async DB query resolves (renderRecommendationsHTML).
        // A second call arriving before that promise settles used to read
        // div.style.display as still '' and re-enter the "open" branch instead
        // of closing, leaving #resultsTable stuck hidden (flaky under load —
        // Rājan/Codex report, 2026-07-26, test 50l).
        if (navView === 'topSearches') {
            // Toggle OFF — panel closes, no browse view is active anymore.
            div.style.display = 'none';
            if (resultsTable) resultsTable.style.display = '';
            navView = null;
            _refreshButtonGroups();
            // Repaint the table + its count line (displayResults(), same as
            // showLatestFiles()/showAllTranscriptsByDate()/
            // showLatestTranscripts() already do) — #resultsInfo was cleared
            // below when this panel opened, and without this it stayed
            // cleared even though the table is visible again.
            displayResults();
            return;
        }
        closeAllPanels();
        if (!dataLoaded) return;
        navView = 'topSearches'; transcriptView = null;
        _refreshButtonGroups();
        if (resultsTable) resultsTable.style.display = 'none';
        // The count line describes the (now hidden) table, not this
        // recommendations panel — clear it instead of leaving a stale
        // "N files found" floating above unrelated content (Rājan report,
        // 2026-07-25: it kept the previous search's count).
        var recResultsInfo = document.getElementById('resultsInfo');
        if (recResultsInfo) recResultsInfo.innerHTML = '';
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
        // See showRecommendations() above: toggle state must be read from
        // transcriptView (set synchronously), not div.style.display, which
        // is only applied once the async DB query resolves.
        if (transcriptView === 'byTopic') {
            // Toggle OFF — By Topic no longer the active transcript view.
            div.style.display = 'none';
            if (resultsTable) resultsTable.style.display = '';
            transcriptView = null;
            _refreshButtonGroups();
            // Repaint table + count line — see showRecommendations() above
            // for why (same stale-count report, 2026-07-25).
            displayResults();
            return;
        }
        closeAllPanels();
        document.getElementById('recommendationsList').style.display = 'none';
        if (!dataLoaded) return;
        navView = null; transcriptView = 'byTopic';
        _refreshButtonGroups();
        if (resultsTable) resultsTable.style.display = 'none';
        // Clear the stale count line — see showRecommendations() above.
        var topicsResultsInfo = document.getElementById('resultsInfo');
        if (topicsResultsInfo) topicsResultsInfo.innerHTML = '';

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

    // targetId: 'sourcesList' (onboarding intro screen — the only place this
    // button is reachable, per Rājan decision 2026-07-25; the former
    // .top-left-buttons 'utilSourcesList' copy in the results view was
    // removed because it visually collided with #tipStrip). Defaults to
    // 'sourcesList' when called with no argument.
    function showSources(targetId) {
        var div = document.getElementById(targetId || 'sourcesList');
        if (!div) return;
        if (div.style.display !== 'none' && div.style.display !== '') { div.style.display = 'none'; return; }

        // interactive=false renders the plain list used on the onboarding
        // screen: applySourceFilter() runs a search, and there is no loaded DB
        // to search there — a click would land on nothing.
        function renderSourcesHTML(sources, interactive) {
            var esc = utils.escapeHtml;
            var enc = utils.encodeForAttr;
            var html = '<h3>' + i18n.t('sources') + '</h3><ul>';
            Object.keys(sources).sort().forEach(function (name) {
                html += interactive === false
                    ? '<li>' + esc(name) + '</li>'
                    : '<li onclick="PPP.app.applySourceFilter(decodeURIComponent(\'' + enc(name) + '\'))">' + esc(name) + '</li>';
            });
            html += '</ul>';
            div.innerHTML = html;
            div.style.display = 'block';
        }

        // First visit: the meta DB is not loaded yet (mandatory install gate),
        // and this button lives on that very screen. It used to `return`
        // silently on !dataLoaded, so for every new user it did nothing at all.
        // Fall back to the manifest catalog, and if even that is unavailable
        // say so — never fail silently. (Audit 2026-07-26.)
        if (!dataLoaded) {
            _getCatalog().then(function (cat) {
                if (cat && cat.sources && Object.keys(cat.sources).length) {
                    renderSourcesHTML(cat.sources, false);
                } else {
                    div.innerHTML = '<h3>' + utils.escapeHtml(i18n.t('sources')) + '</h3><p>' +
                        utils.escapeHtml(i18n.t('sourcesUnavailable')) + '</p>';
                    div.style.display = 'block';
                }
            });
            return;
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
        return String(s || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').slice(0, 120) || 'transcript';
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

    function openHtmlTranscriptViewer(lectureNr, lang, blockIndex, reference, driveUrl, highlightText) {
        track('transcript-open', { nr: String(lectureNr), lang: lang, block: blockIndex || 0 });
        // "In Text" deep-open: jump to (and highlight) the matched sentence.
        // Uses the same _pendingHighlight → _highlightAndScroll path as shared
        // deep links. First ~60 chars are enough to locate it; a miss (e.g.
        // punctuation drift, or opening a different-language transcript that
        // lacks the EN sentence) degrades silently to opening at the top.
        if (highlightText) {
            var _hlSent = String(highlightText).trim();
            // Two-tier in the transcript, same as the results row: the matched
            // sentence gets the yellow band, the searched words inside it turn
            // green. _sentenceWords holds the current In-Text search words.
            if (_hlSent) _pendingHighlight = { sentence: _hlSent, words: (_sentenceWords || []).slice() };
        }
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
                if (_netFetchFailed || !net.online) {
                    // Nothing in IDB and we are offline by either signal:
                    // the network fetch actually FAILED (transport rejection),
                    // OR navigator.onLine says offline. Both arms are needed:
                    // a device whose navigator.onLine lies "false" while
                    // online opens the transcript via the (successful) fetch
                    // and never reaches this branch; but a genuinely offline
                    // device can receive a CACHED 404 response (fetch resolves,
                    // no transport failure), and without the !net.online arm it
                    // would fall through to the Drive-link modal whose link is
                    // dead offline (field bugs 2026-07-24, Android).
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

                if (deepHl && deepHl.sentence) {
                    // In-Text deep-open: two-tier highlight (yellow sentence +
                    // green words) with the same drift-tolerant matcher as the
                    // ZIP export, then scroll the matched sentence into view.
                    setTimeout(function () {
                        _wrapMatchesInContainer(body, [deepHl.sentence], deepHl.words || []);
                        _scrollModalToMark(body.querySelector('mark.tr-sentence'));
                    }, 150);
                } else if (deepHl) {
                    // Shared deep link (start/len) — find text, highlight, scroll.
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

    // Scroll the modal so `mark` sits ~60px below the top (or center it if the
    // modal is not the scroll container). Shared by the In-Text two-tier open.
    function _scrollModalToMark(mark) {
        if (!mark) return;
        setTimeout(function () {
            var modalBody = document.getElementById('transcriptModalBody');
            if (modalBody && modalBody.contains(mark)) {
                var mr = mark.getBoundingClientRect();
                var br = modalBody.getBoundingClientRect();
                modalBody.scrollTop = Math.max(0, mr.top - br.top + modalBody.scrollTop - 60);
            } else {
                mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }, 300);
    }

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
        // "Mahāprabh" inside "Mahāprabhu" without the trailing "u".
        //
        // ONLY inside a matched sentence: a searched word that appears elsewhere
        // in the transcript (outside the matched sentences) is NOT highlighted —
        // green words scattered across the whole lecture were confusing (Rājan,
        // 2026-07-25). Pass 1 wraps text in <mark> without changing any text
        // content, so the char offsets from `sentRanges` (built on map1) stay
        // valid in map2's identical fullText.
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
                var ws = wm.index, we = wm.index + plen;
                var insideSentence = sentRanges.some(function (sr) {
                    return ws >= sr.start && we <= sr.end;
                });
                if (insideSentence) wordRanges.push({ start: ws, end: we });
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
    // AbortController for the CURRENTLY in-flight performSentenceSearch run
    // (null when idle). Cancel button wiring calls .abort() on this; the
    // shard loop in db.searchSentencesChunked notices and stops, the busy
    // lock still gets released in performSentenceSearch's own finally-style
    // tail (single source of truth — cancel never clears the flag itself).
    var _sentenceSearchAbort = null;

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
            // No free-text term to search on — buildTranscriptSQL returns null
            // when the query has no [a-z0-9] word at all, which includes EVERY
            // query typed in Cyrillic and a bare "year:2024".
            //
            // The old comment here said the busy lock is never engaged on this
            // path. That stopped being true when doSearch started setting it
            // SYNCHRONOUSLY (to close a race with the view/language switches),
            // so returning without clearing it left search, mode switching and
            // language switching dead until a reload — hit by the first query a
            // Russian-speaking user types. Fable review, 2026-07-27.
            _sentenceSearchBusy = false;
            _sentenceSearchAbort = null;
            _setSearchButtonBusy(false);
            document.getElementById('resultsInfo').innerHTML = '';
            _sentenceMatchesByNr = {};
            _sentenceWords = [];
            _sentenceLastRender = null;
            ui.renderSentenceResults([], myTerm, { total: 0, lectures: 0, shown: 0 }, _sentenceWords);
            return;
        }

        _sentenceSearchBusy = true;
        _sentenceSearchAbort = new AbortController();
        _setSearchButtonBusy(true);

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
        }, _sentenceSearchAbort.signal).then(function (res) {
            // Final gate before ANY render / persist: a newer search or a
            // mode/language switch since we started means these rows are
            // stale — never leak them into the current view.
            if (!stillCurrent()) return;
            ui.hideLoading();
            var rows = (res && res.rows) || [];
            var n = (res && res.count) || 0;
            var lectures = (res && res.lectures) || 0;
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
            _updateTipStrip();
        }).catch(function (err) {
            // Only surface an error for the still-current search — a superseded
            // run rejecting must not overwrite the live view.
            if (!stillCurrent()) return;
            ui.hideLoading();
            if (err && err.name === 'AbortError') {
                // User-initiated cancel (Cancel button) — not a real error.
                // Leave whatever results/summary were on screen before this
                // search started untouched (nothing was rendered for this
                // run), just stop the spinner. No error text, no toast.
                return;
            }
            console.error('Sentence search error:', err);
            var infoEl = document.getElementById('resultsInfo');
            if (err && err.libraryUpdating) {
                // A delta is rewriting the sentence shards right now. Nothing is
                // damaged and nothing needs repairing — the honest answer is
                // that the library is mid-update and search works again in a
                // moment. Checked BEFORE shardRepairNeeded so an update can
                // never be reported to the user as damage.
                var upd = document.createElement('div');
                upd.className = 'quotes-require-install';
                upd.textContent = i18n.t('libraryUpdatingSearch');
                infoEl.innerHTML = '';
                infoEl.appendChild(upd);
                return;
            }
            if (err && err.shardRepairNeeded) {
                // A piece of the INSTALLED library is missing or damaged. It is
                // no longer silently re-fetched (that made "all-or-nothing" a
                // fiction and spent metered data behind the user's back) — say
                // it plainly and offer a repair of that one shard, a few MB,
                // never a 342 MB reinstall.
                _renderShardRepairNotice(err.shardId);
                return;
            }
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
            // ALWAYS release the busy lock for THIS run (success, error or
            // cancel), so it can never stick at true. Only clear the flag if
            // no newer search has been issued since — an older run finishing
            // after it was superseded must not unlock UI actions on behalf of
            // the newer, still in-flight run (which owns the lock now).
            if (mySeq === _sentenceSearchSeq) {
                _sentenceSearchBusy = false;
                _sentenceSearchAbort = null;
                _setSearchButtonBusy(false);
            }
        });
    }

    /**
     * "Part of the library is damaged" + Repair. Shown instead of the silent
     * network re-fetch that used to happen at db.js _getShardGz (Fable
     * 2026-07-27). Offline, the repair cannot run yet — say so; the same button
     * works at the next online moment. The rest of the app keeps working: one
     * damaged shard must not take everything down.
     */
    function _renderShardRepairNotice(shardId) {
        var info = document.getElementById('resultsInfo');
        if (!info) return;
        info.innerHTML = '';
        var msg = document.createElement('div');
        msg.className = 'quotes-require-install';
        msg.textContent = navigator.onLine
            ? i18n.t('libraryPartDamaged')
            : i18n.t('libraryPartDamagedOffline');
        info.appendChild(msg);
        if (!navigator.onLine) return;
        // No shardId: the localManifest record itself is unreadable, so there is
        // no single shard to re-download and repairShard() could only fail. A
        // button that can never work is the dead end this whole pass is
        // removing, so it is not offered.
        if (!shardId) return;
        var btn = document.createElement('button');
        btn.id = 'shardRepairBtn';
        btn.type = 'button';
        btn.className = 'search-button';
        btn.textContent = i18n.t('libraryRepairBtn');
        btn.onclick = function () {
            btn.disabled = true;
            btn.textContent = i18n.t('libraryRepairing');
            db.repairShard(shardId).then(function () {
                ui.toast(i18n.t('libraryRepaired'));
                doSearch();                     // the search the user actually wanted
            }).catch(function (e) {
                console.error('Shard repair failed:', e);
                btn.disabled = false;
                btn.textContent = i18n.t('libraryRepairBtn');
                ui.toast(i18n.t('libraryRepairFailed'));
            });
        };
        info.appendChild(btn);
    }

    /** Cancel the in-flight "In Text" (sentence) search, if any — aborts the
     *  underlying shard fetch loop (db.searchSentencesChunked) and lets
     *  performSentenceSearch's own cleanup tail release the busy lock and
     *  restore the Search button. A no-op if nothing is running. */
    function cancelSentenceSearch() {
        if (_sentenceSearchAbort) _sentenceSearchAbort.abort();
    }

    /** Search button click dispatcher: while a sentence search is in flight
     *  the same visible button doubles as Cancel (Rājan request — the user
     *  had no way to stop a 15-20s+ "In Text" search). Direct calls to
     *  PPP.app.search() (tests, keyboard Enter, filters) are untouched and
     *  keep the existing busy-lock-refuses-with-a-toast behavior (test 36f) —
     *  this dispatcher only changes what CLICKING THE BUTTON does. */
    function searchOrCancel() {
        if (_sentenceSearchBusy && searchMode === 'sentences') {
            cancelSentenceSearch();
            return;
        }
        doSearch();
    }

    /** Swap the search button between its normal "Search" label/behavior and
     *  a "Cancel" label while a sentence search is in flight. Purely visual —
     *  searchOrCancel() (wired to the button's onclick) decides the actual
     *  behavior from _sentenceSearchBusy/searchMode, not from this class. */
    function _setSearchButtonBusy(isBusy) {
        var btn = document.querySelector('.search-row .search-button');
        if (!btn) return;
        btn.classList.toggle('is-cancel', !!isBusy);
        btn.textContent = i18n.t(isBusy ? 'cancelSearch' : 'searchButton');
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
            // The export runs the SAME chunked search, so a delta in flight
            // rejects it too. Console-only here meant the Excel button just did
            // nothing at all — the same silence the on-screen message removes.
            if (err && err.libraryUpdating) ui.toast(i18n.t('libraryUpdatingSearch'));
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
        // Picking a recommendation item leaves the Top Searches browse view
        // (navView stayed 'topSearches' otherwise, since performSearch() never
        // touches it) — a second Top Searches click then read the stale value
        // and toggled OFF instead of reopening the list, while the In Titles
        // button lit up instead (Rājan report, 2026-07-31). Reset it exactly
        // like _runSearch() does for a typed search.
        navView = null; transcriptView = null;
        _refreshButtonGroups();
        performSearch();
    }

    // ===== ONBOARDING GATE (purpose picker) =====
    // localStorage.ppp_purpose is either unset (first run — gate active) or
    // 'lectures' | 'quotes' (chosen — gate stays closed forever, until the
    // user clears storage). See CLAUDE.md "Onboarding gate" for the full spec.
    function _currentPurpose() {
        try {
            var p = localStorage.getItem('ppp_purpose');
            return (p === 'lectures' || p === 'quotes') ? p : null;
        } catch (e) { return null; }
    }

    function _onbShowStage(stage) {
        document.querySelectorAll('.onb-stage').forEach(function (s) {
            s.hidden = s.getAttribute('data-onb-stage') !== stage;
        });
    }

    function _hideOnboarding() {
        var overlay = document.getElementById('onboardingOverlay');
        if (overlay) overlay.hidden = true;
        document.body.classList.remove('onboarding-active');
    }

    /** The close (X) control on the start screen exists ONLY for a returning
     *  user who re-opened it via the Home button: on a first visit the purpose
     *  choice is mandatory (Rājan), so there is deliberately no way out. */
    function _updateOnbCloseBtn() {
        var btn = document.getElementById('onbCloseBtn');
        if (btn) btn.hidden = !_currentPurpose();
    }

    /** Home button (utility row, always visible): re-open the start screen
     *  WITHOUT clearing ppp_purpose. From there the user can switch mode
     *  (setPurpose, as before), open "List Of Sources", or close and land back
     *  exactly where they were. */
    function showHome() {
        document.body.classList.add('onboarding-active');
        var overlay = document.getElementById('onboardingOverlay');
        if (overlay) overlay.hidden = false;
        // Language is already chosen for anyone who can reach this button, so
        // go straight to the intro/purpose stage rather than asking again.
        _onbShowStage(_currentPurpose() ? 'intro' : 'lang');
        _updateOnbCloseBtn();
        updateOnbIntro();
        track('home-open', {});
        try { window.scrollTo(0, 0); } catch (e) {}
    }

    /** Close the start screen and return to the working UI. No-op while no
     *  purpose has been chosen yet (first visit — the gate is absolute). */
    function closeHome() {
        if (!_currentPurpose()) return;
        _hideOnboarding();
    }

    /** Called once from init(): shows the gate on first run, or applies the
     *  already-chosen view immediately (no flash of the wrong UI). */
    function initOnboarding() {
        var purpose = _currentPurpose();
        if (!purpose) {
            document.body.classList.add('onboarding-active');
            var overlay = document.getElementById('onboardingOverlay');
            if (overlay) overlay.hidden = false;
            _onbShowStage('lang');
        } else {
            _hideOnboarding();
            _applyPurposeView(purpose);
        }
        _updateOnbCloseBtn();
        // Escape is the keyboard twin of the X — same guard, so it cannot be
        // used to skip the first-visit gate.
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            var overlay = document.getElementById('onboardingOverlay');
            if (overlay && !overlay.hidden) closeHome();
        });
        updateOnbIntro();
    }

    /** Onboarding stage (a): pick a language, reuse setLanguage(), advance. */
    function onbPickLanguage(lang) {
        setLanguage(lang);
        _onbShowStage('intro');
        updateOnbIntro();
    }

    /**
     * Catalog figures (lecture count, source list) for the ONBOARDING screen.
     *
     * That screen is shown BEFORE the meta DB is loaded: loadData() returns
     * early while no purpose is chosen (Rājan's mandatory install gate), so
     * totalLectures is 0 and dataLoaded is false for every genuinely new user —
     * the exact audience the intro sentence and "List Of Sources" address.
     * manifest.json is small (~20 KB) and already part of this screen's work,
     * so both figures ride along in its "catalog" block
     * (scripts/build_offline_packs.py read_catalog()).
     *
     * Never rejects: an older manifest without the block, or no network at all,
     * resolves to null and each caller keeps its previous behaviour.
     */
    var _manifestPromise = null;
    function _getManifest() {
        if (!_manifestPromise) {
            _manifestPromise = fetch(PPP.dataUrl('data/manifest.json'))
                .then(function (r) { return r.ok ? r.json() : null; })
                .catch(function () { return null; });
        }
        return _manifestPromise;
    }
    function _getCatalog() {
        return _getManifest().then(function (m) { return (m && m.catalog) || null; });
    }

    /** Live "{count} recordings" text in the onboarding intro sentence — kept
     *  in sync with totalLectures (cached value first, real value once the
     *  meta DB resolves — see _loadMetaIntoApp). Before the meta DB exists at
     *  all (first visit) the count comes from the manifest catalog; until that
     *  resolves the sentence renders WITHOUT a number rather than with "0". */
    function updateOnbIntro() {
        var el = document.getElementById('onbIntroText');
        if (!el) return;
        function render(count) {
            var tpl = i18n.t('onbIntro');
            el.textContent = count > 0
                ? tpl.replace('{count}', count.toLocaleString())
                // No figure yet: drop the placeholder and the space around it
                // instead of asserting "0 recordings", which is simply false.
                : tpl.replace(/\s*\{count\}\s*/, ' ');
        }
        if (totalLectures > 0) { render(totalLectures); return; }
        render(0);
        _getCatalog().then(function (cat) {
            // Guard against a late meta DB having already filled the real value.
            if (totalLectures > 0) { render(totalLectures); return; }
            if (cat && cat.lectures) { render(cat.lectures); }
        });
    }

    /** Onboarding stage (b): purpose chosen — close the gate, enter that view,
     *  then kick off the mandatory first-use install gate (see
     *  _startMandatoryInstallGate). */
    function setPurpose(purpose) {
        try { localStorage.setItem('ppp_purpose', purpose); } catch (e) {}
        track('onboarding-purpose', { purpose: purpose });
        _hideOnboarding();
        _applyPurposeView(purpose);
        setSearchMode(purpose === 'quotes' ? 'sentences' : 'metadata');
        _updateTipStrip();
        _startMandatoryInstallGate();
    }

    /**
     * First-use mandatory install (Rājan decision 2026-07-26): every user
     * downloads the full EN dataset (core + EN premium + EN raw + the
     * sentence shards "In Text" search needs) on first use; LV/RU stay
     * optional. loadData() (called unconditionally from init(), before the
     * purpose is even known) defers its own online-load fallback while the
     * onboarding gate is open — this function is what actually decides what
     * happens once the user's purpose choice makes that decision possible.
     * Skipped for: a returning device that already has the full library
     * (just opens it), a resumed/interrupted install (the normal boot logic
     * already knows how to open a partial library and keep downloading in
     * the background), and a browser that cannot do offline at all (the
     * existing offlineUnsupported path — proceeds online, "In Text" explains
     * itself later via _requireTextSearchLibrary).
     */
    function _startMandatoryInstallGate() {
        var store = PPP.offlineStore;
        if (!store || !store.supported() || !PPP.downloader) {
            loadDataLegacy();
            maybeShowOfflineWorkButton();
            return;
        }
        // Rājan field report (2026-07-26): a stuck IndexedDB read here left
        // the onboarding purpose choice with NO install step at all — the
        // user landed nowhere, forever, with nothing on screen to explain
        // why. Raced against a short timeout (_raceTimeout) so a hung
        // store.open()/getState() degrades to "treat as not installed yet"
        // (the same as a genuinely fresh device) instead of hanging the
        // gate closed. getResumeState() is a SEPARATE offlineStore/
        // downloader read and gets its own timeout for the same reason —
        // its own default (no resume found) already means "run the normal
        // first-install flow", so timing it out is safe.
        var stateRead = store.open().then(function () {
            return store.getState('localManifest');
        }).then(function (localManifest) {
            return store.getState('shards').then(function (shardsInstalled) {
                return { localManifest: localManifest, shardsInstalled: shardsInstalled };
            });
        });
        _raceTimeout(stateRead, 4000, null).then(function (state) {
            if (state && state.localManifest && state.shardsInstalled) {
                return openFromIdb().then(function () {
                    if (navigator.onLine) backgroundUpdateCheck();
                });
            }
            // Library present, only the sentence shards missing. This is the
            // normal state of EVERY user who installed before tonight: shards
            // used to be an opt-in checkbox, unchecked by default. Sending them
            // through startFirstInstallFlow() would re-download all 342 MB,
            // including the ~150 MB already sitting in their IndexedDB, because
            // the install state is cleared once an install completes and
            // _buildWorkList therefore sees nothing as done. Add just the shards
            // instead (Fable review, 2026-07-27).
            if (state && state.localManifest && !state.shardsInstalled) {
                return _startShardsOnlyInstall();
            }
            return _raceTimeout(PPP.downloader.getResumeState(), 4000, null).then(function (resume) {
                if (resume) {
                    // An install is already under way (e.g. a reload during
                    // the mandatory install below, or one begun in an
                    // earlier session) — loadData() already knows how to
                    // open a partial library and continue downloading the
                    // rest in the background.
                    return loadData();
                }
                // True first use (or an unreadable/timed-out state, treated
                // the same way) — the mandatory install prompt/flow.
                return startFirstInstallFlow();
            });
        }).catch(function (err) {
            console.warn('Mandatory install gate failed, falling back to online load:', err);
            loadDataLegacy();
        });
    }

    /** Show/hide the .lectures-only / .quotes-only controls (CSS-driven) and
     *  flip the switch-view button label to the OTHER view. */
    function _applyPurposeView(purpose) {
        document.body.classList.remove('view-lectures', 'view-quotes');
        document.body.classList.add(purpose === 'quotes' ? 'view-quotes' : 'view-lectures');
        document.body.classList.add('purpose-set');
        var switchBtn = document.getElementById('viewSwitchBtn');
        if (switchBtn) {
            var key = purpose === 'quotes' ? 'switchToLectures' : 'switchToQuotes';
            switchBtn.setAttribute('data-i18n', key);
            switchBtn.textContent = i18n.t(key);
        }
    }

    /** Utility-row toggle between the two views. Rājan decision: keep whatever
     *  the user typed, but clear the results (setSearchMode below does both —
     *  clears the field too — so the typed term is saved and restored after). */
    function switchView() {
        var next = _currentPurpose() === 'quotes' ? 'lectures' : 'quotes';
        try { localStorage.setItem('ppp_purpose', next); } catch (e) {}
        track('view-switch', { to: next });
        var input = document.getElementById('searchTerm');
        var term = input ? input.value : '';
        // A combo-display label (By Topic, By Verse, ...) left in the field
        // is not something the user typed — restoring it after setSearchMode
        // clears it would leave it sitting there as if typed, but ENABLED
        // (Rājan report, 2026-07-25). Same display-label lookup used by the
        // language-switch fix (setLanguage, below).
        var isDisplayLabel = !!term && SEARCH_VALUE_DISPLAY_KEYS.some(function (k) { return i18n.t(k) === term; });
        _applyPurposeView(next);
        setSearchMode(next === 'quotes' ? 'sentences' : 'metadata');
        if (input && !isDisplayLabel) input.value = term;
        _updateTipStrip();
    }

    /** Compact language button (utility row) — opens/closes the existing
     *  6-button language switcher (hidden by default once a purpose is set). */
    function toggleLangChooser(evt) {
        if (evt) evt.stopPropagation();
        var full = document.getElementById('langSwitcherFull');
        if (!full) return;
        var willOpen = !full.classList.contains('open');
        full.classList.toggle('open', willOpen);
        if (!willOpen) return;
        // #langSwitcherFull lives inside .hero, which needs overflow:hidden
        // for its decorative background — that clipped this dropdown when it
        // was position:absolute (Rājan report, 2026-07-25). It is now
        // position:fixed (css/styles.css), so anchor it here to the compact
        // button's live viewport position, clamped so it never runs off
        // either edge.
        var btn = document.getElementById('langCompactBtn');
        if (!btn) return;
        var br = btn.getBoundingClientRect();
        // Measure first (panel is display:flex via .open already applied above).
        var pw = full.offsetWidth;
        var ph = full.offsetHeight;
        var left = br.right - pw;
        var maxLeft = window.innerWidth - pw - 8;
        if (left > maxLeft) left = maxLeft;
        if (left < 8) left = 8;

        // Prefer opening below the button, but flip ABOVE it when there isn't
        // enough room before the results table starts — at narrow (mobile)
        // widths the utility row sits close above the results header, so the
        // dropdown used to paint straight over it (Rājan report, 2026-07-25).
        var resultsEl = document.getElementById('resultsTable');
        var lowerBound = window.innerHeight - 8;
        if (resultsEl) lowerBound = Math.min(lowerBound, resultsEl.getBoundingClientRect().top - 8);
        var top = br.bottom + 6;
        if (top + ph > lowerBound) {
            var aboveTop = br.top - 6 - ph;
            top = aboveTop >= 8 ? aboveTop : Math.max(8, lowerBound - ph);
        }
        full.style.top = top + 'px';
        full.style.left = left + 'px';
    }

    // ===== "DID YOU KNOW?" TIP STRIPS =====
    // Each entry is shown at most once ever (localStorage.ppp_seen_tips), one
    // at a time, only in its matching view, only once its trigger condition
    // holds. Add more tips later by appending to this array — no special
    // casing elsewhere.
    var TIP_DEFS = [
        {
            id: 'zip', purpose: 'lectures', textKey: 'tipZip', btnKey: 'tipZipBtn',
            applies: function () { return searchMode === 'metadata' && totalResults > 0; },
            action: function () {
                var cb = document.querySelector('#resultsTable input.select-checkbox:not(:checked)');
                if (cb) cb.click();
                openDownloadPanel();
            }
        },
        {
            id: 'jump', purpose: 'quotes', textKey: 'tipJump', btnKey: 'tipJumpBtn',
            applies: function () { return searchMode === 'sentences' && !!_sentenceLastRender && _sentenceLastRender.totals.total > 0; },
            action: function () {
                var a = document.querySelector('#resultsTable a.script-chip[data-sentence]');
                if (a) a.click();
            }
        }
    ];

    function _seenTips() {
        try { return JSON.parse(localStorage.getItem('ppp_seen_tips') || '[]'); } catch (e) { return []; }
    }
    function _markTipSeen(id) {
        var seen = _seenTips();
        if (seen.indexOf(id) === -1) {
            seen.push(id);
            try { localStorage.setItem('ppp_seen_tips', JSON.stringify(seen)); } catch (e) {}
        }
    }

    function _updateTipStrip() {
        var strip = document.getElementById('tipStrip');
        if (!strip) return;
        var purpose = _currentPurpose();
        var seen = _seenTips();
        var tip = null;
        for (var i = 0; i < TIP_DEFS.length; i++) {
            var t = TIP_DEFS[i];
            if (t.purpose === purpose && seen.indexOf(t.id) === -1 && t.applies()) { tip = t; break; }
        }
        if (!tip) { strip.hidden = true; strip.innerHTML = ''; return; }
        var esc = utils.escapeHtml;
        strip.innerHTML =
            '<span class="teach-tag">' + esc(i18n.t('tipTag')) + '</span>' +
            '<p>' + esc(i18n.t(tip.textKey)) + '</p>' +
            '<button type="button" class="teach-btn">' + esc(i18n.t(tip.btnKey)) + '</button>' +
            '<button type="button" class="teach-x" aria-label="Close">&times;</button>';
        strip.hidden = false;
        var actionBtn = strip.querySelector('.teach-btn');
        if (actionBtn) actionBtn.onclick = function () { _markTipSeen(tip.id); tip.action(); _updateTipStrip(); };
        var xBtn = strip.querySelector('.teach-x');
        if (xBtn) xBtn.onclick = function () { _markTipSeen(tip.id); _updateTipStrip(); };
    }

    function applyLangFilter(lang) {
        document.getElementById('searchTerm').value = 'lang:' + lang;
        lastSearchTerm = 'lang:' + lang;
        currentPage = 1;
        document.getElementById('recommendationsList').style.display = 'none';
        var _rt = document.getElementById('resultsTable'); if (_rt) _rt.style.display = '';
        // Same stale-navView fix as applySubjectFilter() above — see comment there.
        navView = null; transcriptView = null;
        _refreshButtonGroups();
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
    // Keys whose translated value gets written directly into #searchTerm's
    // VALUE (not just the placeholder) by combo/nav buttons — see
    // setComboDisplay() and the handful of direct assignments above (By
    // Topic, By Added, Verses, 2026, Favorites, ...). setLanguage() below
    // must re-translate the field's value if it still holds one of these
    // display labels in the outgoing language (Rājan report, 2026-07-25:
    // switching LV -> RU after "By Topic" left the field showing the old
    // Latvian label while everything else relocalized).
    var SEARCH_VALUE_DISPLAY_KEYS = [
        'byCitedVersesDisplay', 'mostCitedVersesDisplay', 'latest20Files',
        'addedDateDisplay', 'entries2026Display', 'latest20Transcripts',
        'newestTranscriptsDisplay', 'allTranscriptsByDate', 'transcriptsByDateDisplay',
        'favorites', 'favoritesBtn', 'recommendations', 'transcriptsByTopicDisplay'
    ];
    function setLanguage(lang) {
        if (_sentenceSearchBusy) { ui.toast(i18n.t('searchInProgress')); return; }
        track('language', { lang: lang });
        // Snapshot BEFORE switching: if the search field's current value is
        // exactly one of the known display labels in the OLD language, we'll
        // re-translate it below. Anything the user typed themselves won't
        // match any of these and is left untouched.
        var searchInputEl = document.getElementById('searchTerm');
        var _pendingDisplayKey = null;
        if (searchInputEl) {
            var oldLang = i18n.getLanguage();
            var oldDict = (i18n.getTranslations() || {})[oldLang] || {};
            var curVal = searchInputEl.value;
            for (var _dk = 0; _dk < SEARCH_VALUE_DISPLAY_KEYS.length; _dk++) {
                if (oldDict[SEARCH_VALUE_DISPLAY_KEYS[_dk]] === curVal) {
                    _pendingDisplayKey = SEARCH_VALUE_DISPLAY_KEYS[_dk];
                    break;
                }
            }
        }
        i18n.setLanguage(lang);
        if (_pendingDisplayKey && searchInputEl) {
            searchInputEl.value = i18n.t(_pendingDisplayKey);
        }
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
        // A handful of onboarding strings carry inline <code> markup (search
        // examples) — those use innerHTML via a separate attribute so the
        // generic textContent loop above never HTML-escapes them.
        document.querySelectorAll('[data-i18n-html]').forEach(function (el) {
            var hkey = el.getAttribute('data-i18n-html');
            var hval = i18n.t(hkey);
            if (hval !== hkey) el.innerHTML = hval;
        });
        var langCompact = document.getElementById('langCompactBtn');
        if (langCompact) langCompact.textContent = lang.toUpperCase();
        // Close the compact dropdown as soon as a language is picked — without
        // this the panel stayed open (Rājan report, 2026-07-25) and gave no
        // closure signal, so the switch looked like it hadn't worked.
        var langSwitcher = document.getElementById('langSwitcherFull');
        if (langSwitcher) langSwitcher.classList.remove('open');
        // The generic data-i18n loop above just wrote the RAW "{count}" template
        // into #onbIntroText (onbIntro has a placeholder) — fix it up now.
        updateOnbIntro();
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
        // The banner sits between .hero and .search-section, and the latter is
        // pulled up 44px to float over the hero. Without cancelling that pull
        // the search card climbs over the BANNER, which (z-index 20) then eats
        // the clicks on the first button row. See styles.css
        // body.install-banner-visible. Audit 2026-07-26.
        document.body.classList.add('install-banner-visible');
    }

    function _hideInstallBanner() {
        document.getElementById('installBanner').style.display = 'none';
        document.body.classList.remove('install-banner-visible');
    }

    function installApp() {
        if (deferredPrompt) {
            track('pwa-install');
            deferredPrompt.prompt();
            deferredPrompt.userChoice.then(function () {
                deferredPrompt = null;
                _hideInstallBanner();
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
        _hideInstallBanner();
        localStorage.setItem('installDismissed', '1');
    }

    // ===== PUBLIC API =====
    return {
        init: init,
        search: doSearch,
        searchOrCancel: searchOrCancel,
        cancelSentenceSearch: cancelSentenceSearch,
        setLanguage: setLanguage,
        showLatestFiles: showLatestFiles,
        showBy2026: showBy2026,
        toggleFilters: toggleFilters,
        toggleFilterSection: toggleFilterSection,
        applyFilters: applyFilters,
        clearFilters: clearFilters,
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
        // Onboarding gate (purpose picker) + the two-view toggle + tip strips
        onbPickLanguage: onbPickLanguage,
        setPurpose: setPurpose,
        showHome: showHome,
        closeHome: closeHome,
        switchView: switchView,
        toggleLangChooser: toggleLangChooser,
        // Internal (test only) — read/reset gate state without clicking through it.
        _currentPurposeForTest: _currentPurpose,
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
        // Internal (test only) — seed the current In-Text search words so the
        // transcript deep-open two-tier (green tr-word) can be exercised without
        // running a full 21-shard sentence search.
        _setSentenceWordsForTest: function (w) { _sentenceWords = (w || []).slice(); },
        // Internal (test only) — drive the delta-update refresh directly so the
        // per-core-key reload branches can be exercised with a stubbed
        // checkForUpdates instead of a real remote manifest change (P14c).
        _backgroundUpdateCheckForTest: backgroundUpdateCheck,
        // Read-only view of the sentence-search busy lock. A stuck lock is
        // invisible from the DOM (F5 was shipped because of that), and asserting
        // on button labels alone would not have caught it.
        _sentenceSearchBusyForTest: function () { return _sentenceSearchBusy; },
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
