/* ===========================================================================
   PPP Link Finder — Collections (localStorage-backed)
   YouTube-style "Save to..." with multiple folders/collections.
   Backward compatible — migrates old ppp_favorites on first load.
   =========================================================================== */
window.PPP = window.PPP || {};

PPP.favorites = (function () {
    'use strict';

    var STORAGE_KEY = 'ppp_collections';
    var OLD_KEY = 'ppp_favorites';
    var _collections = []; // [{id, name, created, lectures: [nr,...]}]
    var _nextId = 1;

    // ===== Persistence =====
    function _load() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                var data = JSON.parse(raw);
                _collections = data.collections || [];
                _nextId = data.nextId || 1;
            }
        } catch (e) { /* ignore corrupt data */ }

        // Migrate old favorites
        if (_collections.length === 0) {
            try {
                var oldRaw = localStorage.getItem(OLD_KEY);
                if (oldRaw) {
                    var oldNrs = JSON.parse(oldRaw);
                    if (oldNrs.length > 0) {
                        _collections.push({
                            id: _nextId++,
                            name: 'Favorites',
                            created: new Date().toISOString(),
                            lectures: oldNrs.map(String)
                        });
                        _save();
                        localStorage.removeItem(OLD_KEY);
                    }
                }
            } catch (e) { /* ignore */ }
        }
    }

    function _save() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            collections: _collections,
            nextId: _nextId
        }));
    }

    // ===== Collection CRUD =====
    function createCollection(name) {
        var col = {
            id: _nextId++,
            name: name.trim(),
            created: new Date().toISOString(),
            lectures: []
        };
        _collections.push(col);
        _save();
        return col;
    }

    function deleteCollection(id) {
        _collections = _collections.filter(function (c) { return c.id !== id; });
        _save();
    }

    function renameCollection(id, newName) {
        var col = _getById(id);
        if (col) { col.name = newName.trim(); _save(); }
    }

    function getCollections() {
        return _collections.map(function (c) {
            return { id: c.id, name: c.name, created: c.created, count: c.lectures.length };
        });
    }

    function _getById(id) {
        for (var i = 0; i < _collections.length; i++) {
            if (_collections[i].id === id) return _collections[i];
        }
        return null;
    }

    // ===== Lecture <-> Collection =====
    function addToCollection(id, nr) {
        var col = _getById(id);
        nr = String(nr);
        if (col && col.lectures.indexOf(nr) === -1) {
            col.lectures.push(nr);
            _save();
        }
    }

    function removeFromCollection(id, nr) {
        var col = _getById(id);
        nr = String(nr);
        if (col) {
            col.lectures = col.lectures.filter(function (n) { return n !== nr; });
            _save();
        }
    }

    function isInCollection(id, nr) {
        var col = _getById(id);
        return col ? col.lectures.indexOf(String(nr)) !== -1 : false;
    }

    function getCollectionLectures(id) {
        var col = _getById(id);
        return col ? col.lectures.slice() : [];
    }

    // ===== Backward-compatible API =====
    // isFavorite = is in ANY collection
    function isFavorite(nr) {
        nr = String(nr);
        for (var i = 0; i < _collections.length; i++) {
            if (_collections[i].lectures.indexOf(nr) !== -1) return true;
        }
        return false;
    }

    // getAll = all unique nrs across all collections
    function getAll() {
        var set = {};
        _collections.forEach(function (c) {
            c.lectures.forEach(function (nr) { set[nr] = true; });
        });
        return Object.keys(set);
    }

    // count = total unique saved lectures
    function count() { return getAll().length; }

    // toggle = simple toggle for default/first collection (backward compat)
    function toggle(nr) {
        nr = String(nr);
        if (_collections.length === 0) {
            createCollection('Favorites');
        }
        var col = _collections[0];
        var idx = col.lectures.indexOf(nr);
        if (idx !== -1) {
            col.lectures.splice(idx, 1);
        } else {
            col.lectures.push(nr);
        }
        _save();
        return col.lectures.indexOf(nr) !== -1;
    }

    // Get collections that contain a specific lecture
    function getCollectionsForLecture(nr) {
        nr = String(nr);
        return _collections.filter(function (c) {
            return c.lectures.indexOf(nr) !== -1;
        }).map(function (c) {
            return { id: c.id, name: c.name };
        });
    }

    _load();

    return {
        // Backward-compatible
        toggle: toggle,
        isFavorite: isFavorite,
        getAll: getAll,
        count: count,
        // Collections API
        createCollection: createCollection,
        deleteCollection: deleteCollection,
        renameCollection: renameCollection,
        getCollections: getCollections,
        addToCollection: addToCollection,
        removeFromCollection: removeFromCollection,
        isInCollection: isInCollection,
        getCollectionLectures: getCollectionLectures,
        getCollectionsForLecture: getCollectionsForLecture
    };
})();
