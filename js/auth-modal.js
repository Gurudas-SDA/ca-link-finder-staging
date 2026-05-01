/* ===========================================================================
   PPP Link Finder — Auth Modal
   "First favorite" prompt + sign-in/sign-up modal.
   Remembers user choice in localStorage (ppp_auth_choice).
   =========================================================================== */
window.PPP = window.PPP || {};

PPP.authModal = (function () {
    'use strict';

    var AUTH_CHOICE_KEY = 'ppp_auth_choice'; // 'local' | 'account'
    var _overlayEl = null;

    // ===== First-Favorite Prompt =====
    // Returns true if user has already made a choice
    function hasChoice() {
        return !!localStorage.getItem(AUTH_CHOICE_KEY);
    }

    function getChoice() {
        return localStorage.getItem(AUTH_CHOICE_KEY);
    }

    // Show the "first favorite" prompt.
    // onContinue: called after user picks either option
    function showFirstFavoritePrompt(onContinue) {
        if (hasChoice()) {
            if (onContinue) onContinue();
            return;
        }

        // Don't show if Firebase is not configured
        if (!PPP.auth || !PPP.auth.isConfigured()) {
            localStorage.setItem(AUTH_CHOICE_KEY, 'local');
            if (onContinue) onContinue();
            return;
        }

        var i18n = PPP.i18n;
        var t = function (k, fb) { return (i18n && i18n.t) ? i18n.t(k) : fb; };

        var overlay = document.createElement('div');
        overlay.className = 'auth-modal-overlay';
        overlay.onclick = function (e) { if (e.target === overlay) _close(overlay); };

        var modal = document.createElement('div');
        modal.className = 'auth-modal';
        modal.onclick = function (e) { e.stopPropagation(); };

        modal.innerHTML =
            '<div class="auth-modal-header">' +
                '<h3>' + t('favSyncTitle', 'Sync your favorites?') + '</h3>' +
                '<button class="auth-modal-close" onclick="PPP.authModal.close()">&times;</button>' +
            '</div>' +
            '<div class="auth-modal-body">' +
                '<p>' + t('favSyncDesc', 'Right now favorites are saved only on this device. Create an account to sync them across all your devices.') + '</p>' +
                '<div class="auth-modal-buttons">' +
                    '<button class="auth-btn-secondary" id="authBtnLocal">' +
                        t('continueWithout', 'Continue without account') +
                    '</button>' +
                    '<button class="auth-btn-primary" id="authBtnCreate">' +
                        t('createAccount', 'Create account') +
                    '</button>' +
                '</div>' +
            '</div>';

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        _overlayEl = overlay;

        // Buttons
        document.getElementById('authBtnLocal').onclick = function () {
            localStorage.setItem(AUTH_CHOICE_KEY, 'local');
            _close(overlay);
            if (onContinue) onContinue();
        };
        document.getElementById('authBtnCreate').onclick = function () {
            localStorage.setItem(AUTH_CHOICE_KEY, 'account');
            _close(overlay);
            show(); // open sign-in modal
            if (onContinue) onContinue();
        };
    }

    // ===== Sign-In Modal =====
    function show() {
        if (!PPP.auth || !PPP.auth.isConfigured()) return;

        var i18n = PPP.i18n;
        var t = function (k, fb) { return (i18n && i18n.t) ? i18n.t(k) : fb; };

        var overlay = document.createElement('div');
        overlay.className = 'auth-modal-overlay';
        overlay.onclick = function (e) { if (e.target === overlay) _close(overlay); };

        var modal = document.createElement('div');
        modal.className = 'auth-modal';
        modal.onclick = function (e) { e.stopPropagation(); };

        modal.innerHTML =
            '<div class="auth-modal-header">' +
                '<h3>' + t('signIn', 'Sign in') + '</h3>' +
                '<button class="auth-modal-close" onclick="PPP.authModal.close()">&times;</button>' +
            '</div>' +
            '<div class="auth-modal-body">' +
                '<button class="auth-google-btn" id="authGoogleBtn">' +
                    '<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>' +
                    ' ' + t('signInGoogle', 'Sign in with Google') +
                '</button>' +
                '<div class="auth-divider"><span>' + t('or', 'or') + '</span></div>' +
                '<div class="auth-email-section">' +
                    '<label>' + t('emailLabel', 'Email (magic link — no password needed)') + '</label>' +
                    '<div class="auth-email-row">' +
                        '<input type="email" id="authEmailInput" placeholder="name@example.com" />' +
                        '<button class="auth-btn-primary" id="authEmailBtn">' + t('sendLink', 'Send link') + '</button>' +
                    '</div>' +
                    '<div id="authEmailMsg" class="auth-email-msg"></div>' +
                '</div>' +
            '</div>';

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        _overlayEl = overlay;

        // Google button
        document.getElementById('authGoogleBtn').onclick = function () {
            PPP.auth.signInWithGoogle().then(function () {
                _close(overlay);
            }).catch(function (err) {
                if (err.code !== 'auth/popup-closed-by-user') {
                    console.error('[authModal] Google sign-in error:', err);
                }
            });
        };

        // Magic link
        document.getElementById('authEmailBtn').onclick = function () {
            var email = document.getElementById('authEmailInput').value.trim();
            var msg = document.getElementById('authEmailMsg');
            if (!email || email.indexOf('@') === -1) {
                msg.textContent = t('invalidEmail', 'Please enter a valid email');
                msg.className = 'auth-email-msg error';
                return;
            }
            PPP.auth.signInWithMagicLink(email).then(function () {
                msg.textContent = t('magicLinkSent', 'Check your email for the sign-in link!');
                msg.className = 'auth-email-msg success';
            }).catch(function (err) {
                msg.textContent = err.message;
                msg.className = 'auth-email-msg error';
            });
        };

        // Enter key on email input
        document.getElementById('authEmailInput').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') document.getElementById('authEmailBtn').click();
        });
    }

    function close() {
        if (_overlayEl) _close(_overlayEl);
    }

    function _close(overlay) {
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (_overlayEl === overlay) _overlayEl = null;
    }

    return {
        show: show,
        close: close,
        showFirstFavoritePrompt: showFirstFavoritePrompt,
        hasChoice: hasChoice,
        getChoice: getChoice
    };
})();
