/* ===========================================================================
   PPP Link Finder — Firebase Authentication
   Google Sign-In + Email Magic Link.
   Syncs localStorage favorites to Firestore on login.
   =========================================================================== */
window.PPP = window.PPP || {};

PPP.auth = (function () {
    'use strict';

    var _user = null;           // Firebase User object or null
    var _ready = false;         // true after first onAuthStateChanged fires
    var _listeners = [];        // callbacks: fn(user)
    var _firebaseApp = null;
    var _auth = null;

    // ===== Firebase Init =====
    function _initFirebase() {
        if (_firebaseApp) return;
        var cfg = PPP.firebaseConfig;
        if (!cfg || cfg.apiKey === 'YOUR_API_KEY') {
            console.warn('[auth] Firebase not configured — running in local-only mode');
            _ready = true;
            return;
        }
        try {
            _firebaseApp = firebase.initializeApp(cfg);
            _auth = firebase.auth();
            _auth.onAuthStateChanged(_onAuthChanged);
        } catch (e) {
            console.error('[auth] Firebase init failed:', e);
            _ready = true;
        }
    }

    // ===== Auth State =====
    function _onAuthChanged(user) {
        var wasLoggedIn = !!_user;
        _user = user || null;
        _ready = true;

        if (_user && !wasLoggedIn) {
            // Just logged in — merge localStorage → Firestore
            if (PPP.favorites && PPP.favorites._onLogin) {
                PPP.favorites._onLogin(_user.uid);
            }
        }
        if (!_user && wasLoggedIn) {
            // Just logged out
            if (PPP.favorites && PPP.favorites._onLogout) {
                PPP.favorites._onLogout();
            }
        }

        _updateUI();
        _listeners.forEach(function (fn) { try { fn(_user); } catch (e) {} });
    }

    // ===== Public Auth Methods =====
    function signInWithGoogle() {
        if (!_auth) return Promise.reject(new Error('Firebase not configured'));
        var provider = new firebase.auth.GoogleAuthProvider();
        return _auth.signInWithPopup(provider);
    }

    function signInWithMagicLink(email) {
        if (!_auth) return Promise.reject(new Error('Firebase not configured'));
        var url = window.location.href.split('?')[0].split('#')[0];
        var settings = {
            url: url + '?finishSignIn=1',
            handleCodeInApp: true
        };
        return _auth.sendSignInLinkToEmail(email, settings).then(function () {
            localStorage.setItem('ppp_magic_link_email', email);
        });
    }

    function _completeMagicLinkSignIn() {
        if (!_auth) return;
        if (!firebase.auth().isSignInWithEmailLink(window.location.href)) return;
        var email = localStorage.getItem('ppp_magic_link_email');
        if (!email) {
            email = prompt('Lūdzu ievadiet savu e-pastu apstiprināšanai / Please enter your email to confirm:');
        }
        if (!email) return;
        _auth.signInWithEmailLink(email, window.location.href).then(function () {
            localStorage.removeItem('ppp_magic_link_email');
            // Clean URL
            var clean = window.location.href.split('?')[0];
            window.history.replaceState(null, '', clean);
        }).catch(function (err) {
            console.error('[auth] Magic link sign-in failed:', err);
        });
    }

    function signOut() {
        if (!_auth) return Promise.resolve();
        return _auth.signOut();
    }

    function getCurrentUser() {
        return _user;
    }

    function isReady() {
        return _ready;
    }

    function isConfigured() {
        var cfg = PPP.firebaseConfig;
        return cfg && cfg.apiKey && cfg.apiKey !== 'YOUR_API_KEY';
    }

    function onAuthChange(fn) {
        _listeners.push(fn);
        if (_ready) fn(_user);
    }

    // ===== UI Updates =====
    function _updateUI() {
        var accountBtn = document.getElementById('accountBtn');
        var accountLabel = document.getElementById('accountLabel');
        if (!accountBtn) return;

        if (_user) {
            var name = _user.displayName || _user.email || 'User';
            accountLabel.textContent = name;
            accountBtn.title = name + ' — click to sign out';
            accountBtn.className = 'account-btn signed-in';
        } else {
            var i18n = PPP.i18n;
            accountLabel.textContent = (i18n && i18n.t) ? i18n.t('createAccount') : 'Sign in';
            accountBtn.title = '';
            accountBtn.className = 'account-btn';
        }

        // Sync status indicator
        var syncEl = document.getElementById('syncStatus');
        if (syncEl) {
            syncEl.style.display = _user ? 'inline-block' : 'none';
        }
    }

    // ===== Account Button Handler =====
    function handleAccountClick() {
        if (_user) {
            // Signed in — confirm sign out
            if (confirm('Sign out?\n' + (_user.displayName || _user.email || ''))) {
                signOut();
            }
        } else {
            // Not signed in — show auth modal
            if (PPP.authModal) PPP.authModal.show();
        }
    }

    // ===== Init =====
    function init() {
        _initFirebase();
        // Complete magic link sign-in if returning from email
        if (window.location.href.indexOf('finishSignIn=1') !== -1) {
            _completeMagicLinkSignIn();
        }
    }

    return {
        init: init,
        signInWithGoogle: signInWithGoogle,
        signInWithMagicLink: signInWithMagicLink,
        signOut: signOut,
        getCurrentUser: getCurrentUser,
        isReady: isReady,
        isConfigured: isConfigured,
        onAuthChange: onAuthChange,
        handleAccountClick: handleAccountClick
    };
})();
