/**
 * Storage function of URLRedirector.
 */

/* Low level load */
function _load(keys, callback, area) {
    // 在Service Worker中使用chrome.storage而不是browser.storage
    const storageArea = area || chrome.storage.local;
    storageArea.get(keys, function (item) {
        if (chrome.runtime.lastError) {
            console.error("[URLRedirector] Storage error:", chrome.runtime.lastError);
        }
        if (callback) {
            callback(item);
        }
    });
}

/* Low level save */
function _save(obj, callback, area) {
    // 在Service Worker中使用chrome.storage而不是browser.storage
    const storageArea = area || chrome.storage.local;
    storageArea.set(obj, function () {
        if (chrome.runtime.lastError) {
            console.error("[URLRedirector] Storage error:", chrome.runtime.lastError);
        }
        if (callback) {
            callback();
        }
    });
}

function load(keys, callback) {
    console.log('[URLRedirector] Loading storage with keys:', keys);
    
    // Load storage.local and check if sync is enable, then try to load
    // storage.sync, if failed fail back to storage.local
    _load(
        keys,
        function (item) {
            console.log('[URLRedirector] Initial load result:', item);
            if (item && item.storage) {
                console.log('[URLRedirector] Found storage, sync enabled:', item.storage.sync);
                if (item.storage.sync && chrome.storage.sync) {
                    console.log('[URLRedirector] Trying to load from sync storage');
                    _load(
                        keys,
                        function (itemSync) {
                            console.log('[URLRedirector] Sync load result:', itemSync);
                            if (
                                itemSync == undefined ||
                                itemSync == null ||
                                itemSync.storage == undefined ||
                                itemSync.storage == null
                            ) {
                                console.log('[URLRedirector] No sync storage, using local');
                                callback(item);
                            } else {
                                console.log('[URLRedirector] Using sync storage');
                                callback(itemSync);
                            }
                        },
                        chrome.storage.sync
                    );
                } else {
                    console.log('[URLRedirector] Using local storage');
                    callback(item);
                }
            } else {
                console.log('[URLRedirector] No local storage found');
                /* The first time to load storage, try to load storage.sync */
                if (chrome.storage.sync) {
                    console.log('[URLRedirector] Trying sync storage for first load');
                    _load(
                        keys,
                        function (item) {
                            console.log('[URLRedirector] First load from sync result:', item);
                            callback(item);
                        },
                        chrome.storage.sync
                    );
                } else {
                    console.log('[URLRedirector] No sync storage, using empty result');
                    callback(item);
                }
            }
        },
        chrome.storage.local
    );
}

function save(obj, callback) {
    console.log('[URLRedirector] Saving storage:', obj);
    if (obj.storage.sync && chrome.storage.sync) {
        console.log('[URLRedirector] Saving to sync storage');
        _save(
            obj,
            function () {
                console.log('[URLRedirector] Sync save complete, saving to local');
                _save(obj, callback, chrome.storage.local);
            },
            chrome.storage.sync
        );
    } else {
        console.log('[URLRedirector] Saving to local storage');
        _save(obj, callback, chrome.storage.local);
    }
}
