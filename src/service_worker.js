/**
 * Manifest V3 service worker for URLRedirector.
 * - Replaces webRequest blocking with declarativeNetRequest dynamic rules
 * - Keeps existing storage schema and online rules download flow
 */

// Alias so existing helpers using `browser` keep working
const browser = chrome;

// Reuse models and storage helpers (no jQuery/common in worker)
importScripts('model.js', 'storage.js');

let state = {
  storage: null,
  downloading: false,
  debug: true // 默认开启调试模式以便诊断问题
};

function log(...args) {
  if (state.debug) {
    console.log('[URLRedirector]', ...args);
  }
}

function sendMessage(method, args) {
  log('Sending message:', method, args);
  browser.runtime.sendMessage({ method, args }).catch(error => {
    log('Message sending failed:', error);
  });
}

// Convert a Rule into a DNR rule (returns null when unsupported)
function convertRuleToDnr(rule, id, priority) {
  console.log('[URLRedirector] Converting rule to DNR format:', rule);
  
  if (!rule || !rule.enable) {
    console.log('[URLRedirector] Rule is null or disabled');
    return null;
  }
  
  if (!rule.origin || !rule.target) {
    console.log('[URLRedirector] Rule missing origin or target');
    return null;
  }

  // DNR does not support encode/decode/base64 transforms in substitutions.
  if (rule.process) {
    console.log('[URLRedirector] Rule has process attribute, not supported in DNR');
    return null;
  }

  // Basic sanity check for regex
  let originRegex;
  try { 
    originRegex = new RegExp(rule.origin);
  } catch (e) { 
    console.log('[URLRedirector] Invalid regex in rule origin');
    return null; 
  }

  // 分析规则类型
  const hasCaptureGroups = /\(.*?\)/.test(rule.origin) && rule.target.includes('$');
  console.log('[URLRedirector] Rule analysis - hasCaptureGroups:', hasCaptureGroups);

  let dnrRule;
  
  if (!hasCaptureGroups) {
    // 没有捕获组的简单替换规则
    console.log('[URLRedirector] Using simple replacement approach');
    
    // 检查是否是前缀替换（如将 http://old-domain/ 替换为 http://new-domain/）
    if (rule.target.includes('$')) {
      // 如果目标包含$符号但origin不包含捕获组，这是一个错误配置
      console.log('[URLRedirector] Target contains $ but origin has no capture groups');
      return null;
    }
    
    // 对于前缀替换，我们需要确保捕获URL的其余部分
    // 例如，将 http://hadoop-prod-05:8042/* 重定向到 http://ops-bigdata-yarn-log-05.kemai.cn/*
    const condition = { 
      regexFilter: "(" + rule.origin + ")(.*)"
    };
    
    const action = { 
      type: 'redirect', 
      redirect: { 
        regexSubstitution: rule.target + "\\2"
      } 
    };
    
    dnrRule = {
      id,
      priority: priority || 1,
      action,
      condition,
    };
  } else {
    // 有捕获组的复杂替换规则
    console.log('[URLRedirector] Using regex with capture groups approach');
    
    // Replace $1 -> \1 in substitution for DNR
    let regexSubstitution = rule.target;
    
    // 检查目标URL是否包含$符号（捕获组引用）
    if (rule.target.includes('$')) {
      regexSubstitution = rule.target.replace(/\$(\d+)/g, '\\$1');
    }
    
    console.log('[URLRedirector] Converted substitution from', rule.target, 'to', regexSubstitution);

    const condition = { regexFilter: rule.origin };
    console.log('[URLRedirector] Rule condition:', condition);

    // Resource types (if any) — pass through known names
    if (Array.isArray(rule.types) && rule.types.length > 0) {
      condition.resourceTypes = rule.types.slice();
      console.log('[URLRedirector] Added resource types:', condition.resourceTypes);
    }

    // HTTP methods (best effort; supported in recent Chrome)
    if (Array.isArray(rule.methods) && rule.methods.length > 0) {
      try {
        condition.requestMethods = rule.methods.map(m => String(m).toLowerCase());
        console.log('[URLRedirector] Added request methods:', condition.requestMethods);
      } catch (_) { 
        console.log('[URLRedirector] Failed to add request methods');
        /* ignore if unsupported */ 
      }
    }

    dnrRule = {
      id,
      priority: priority || 1,
      action: { type: 'redirect', redirect: { regexSubstitution } },
      condition,
    };
  }
  
  // NOTE: Excluding by regex is not universally supported by DNR across versions.
  // To avoid accidental over-redirection, skip rules that require excludes.
  if (rule.exclude) {
    console.log('[URLRedirector] Rule has exclude pattern, not supported in DNR');
    return null;
  }

  // Add default resource types if none specified
  if (!dnrRule.condition.resourceTypes || dnrRule.condition.resourceTypes.length === 0) {
    dnrRule.condition.resourceTypes = ["main_frame"];
    console.log('[URLRedirector] Added default resource type: main_frame');
  }
  
  console.log('[URLRedirector] Final DNR rule:', dnrRule);
  return dnrRule;
}

// Build dynamic DNR rules from current storage
function buildDynamicRulesFromStorage(storage) {
  const rules = [];
  if (!storage || !storage.enable) {
    console.log('[URLRedirector] Storage not available or disabled');
    return rules;
  }

  let nextId = 1;

  // Custom rules first with higher priority
  if (Array.isArray(storage.customRules)) {
    console.log('[URLRedirector] Processing', storage.customRules.length, 'custom rules');
    for (const r of storage.customRules) {
      const dnr = convertRuleToDnr(r, nextId++, 200); // High priority
      if (dnr) {
        console.log('[URLRedirector] Added custom rule:', dnr);
        rules.push(dnr);
      } else {
        console.log('[URLRedirector] Skipped custom rule:', r);
      }
    }
  }

  // Then online rules
  if (Array.isArray(storage.onlineURLs)) {
    console.log('[URLRedirector] Processing', storage.onlineURLs.length, 'online rule sets');
    for (const online of storage.onlineURLs) {
      if (!online || !online.enable || !Array.isArray(online.rules)) {
        console.log('[URLRedirector] Skipping disabled or invalid online rule set');
        continue;
      }
      
      console.log('[URLRedirector] Processing online rule set with', online.rules.length, 'rules');
      for (const r of online.rules) {
        const dnr = convertRuleToDnr(r, nextId++, 100);
        if (dnr) {
          console.log('[URLRedirector] Added online rule:', dnr);
          rules.push(dnr);
        } else {
          console.log('[URLRedirector] Skipped online rule:', r);
        }
      }
    }
  }

  return rules;
}

async function applyDnrRules() {
  try {
    const existing = await browser.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing.map(r => r.id);

    if (!state.storage || !state.storage.enable) {
      console.log('[URLRedirector] Extension disabled or no storage, removing all rules');
      if (removeRuleIds.length > 0) {
        await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
      }
      return;
    }

    const addRules = buildDynamicRulesFromStorage(state.storage);
    
    console.log('[URLRedirector] Applying rules:', addRules);
    await browser.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
    console.log('[URLRedirector] Applied DNR rules:', addRules.length);
  } catch (e) {
    console.error('[URLRedirector] Failed to apply DNR rules', e);
  }
}

function reload(result) {
  console.log('[URLRedirector] Reload called with result:', result);
  
  const s = new Storage();
  let isNew = true;
  if (result && result.storage) {
    console.log('[URLRedirector] Found storage in result, loading...');
    s.fromObject(result.storage);
    isNew = false;
  }
  
  state.storage = s;
  console.log('[URLRedirector] Storage loaded:', s);
  
  // If first run, persist defaults so options/popup won't warn
  if (isNew) {
    console.log('[URLRedirector] New storage, saving defaults...');
    try { save({ storage: state.storage }); } catch (e) {
      console.error('[URLRedirector] Failed to save defaults:', e);
    }
  }
  
  resetDownloadTimer();
  // Rebuild rules whenever storage reloads
  console.log('[URLRedirector] Applying DNR rules...');
  applyDnrRules();
}

// Initial load
console.log('[URLRedirector] Starting initial load...');
load('storage', function(result) {
  console.log('[URLRedirector] Initial load callback with result:', result);
  reload(result);
});

// Update on storage changes
browser.storage.onChanged.addListener((changes, area) => {
  console.log('[URLRedirector] Storage changed:', changes, area);
  if (area === 'local') {
    console.log('[URLRedirector] Loading storage due to local change...');
    load('storage', function(result) {
      console.log('[URLRedirector] Load callback after storage change:', result);
      reload(result);
    });
  }
});

// Download helpers using fetch (no jQuery in worker)
async function fetchText(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

async function downloadOnlineURLs() {
  if (!state.storage || !Array.isArray(state.storage.onlineURLs) || state.storage.onlineURLs.length === 0) {
    // Nothing to do; notify UI to clear downloading state
    sendMessage('downloaded');
    return;
  }
  if (state.downloading) {
    // Already downloading; notify UI to keep consistent
    sendMessage('downloaded');
    return;
  }
  state.downloading = true;

  const queue = [];
  for (const entry of state.storage.onlineURLs) {
    if (entry && entry.auto && entry.enable && entry.url) queue.push(entry.url);
  }
  if (queue.length === 0) {
    sendMessage('downloaded');
    state.downloading = false;
    return;
  }

  const downloadErrors = [];
  const parseErrors = [];

  await Promise.all(queue.map(async (url) => {
    try {
      const text = await fetchText(url);
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {
        // Some servers might return application/json already parsed by fetch in future, keep safe
        json = null;
      }
      if (!json) throw new Error('Invalid JSON');

      // Normalize legacy gooreplacer format (< 1.0) into our format
      if (!json.version || json.version < '1.0') {
        const rules = [];
        for (const key in json.rules) {
          const rule = json.rules[key];
          rules.push({
            origin: key,
            target: rule.dstURL,
            enable: rule.enable === undefined ? true : rule.enable,
            kind: rule.kind,
          });
        }
        json.rules = rules;
      }
      json.url = url;
      json.enable = true;
      json.downloadAt = new Date();

      // Replace the matching onlineURL in storage
      for (let i = 0; i < state.storage.onlineURLs.length; i++) {
        if (state.storage.onlineURLs[i].url === url) {
          const rep = new OnlineURL();
          rep.fromObject(json);
          state.storage.onlineURLs[i] = rep;
          break;
        }
      }
    } catch (e) {
      // Distinguish between download and parse by message
      if (String(e && e.message).toLowerCase().includes('json')) parseErrors.push(url);
      else downloadErrors.push(url);
    }
  }));

  state.downloading = false;
  sendMessage('downloaded');
  if (downloadErrors.length > 0) sendMessage('downloadError', downloadErrors);
  if (parseErrors.length > 0) sendMessage('parseError', parseErrors);

  state.storage.updatedAt = new Date().toISOString();
  save({ storage: state.storage }, () => {
    // Saving triggers storage.onChanged -> reload -> applyDnrRules
  });
}

// Alarms for periodic update
if (browser.alarms) {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === 'download') downloadOnlineURLs();
  });
}

function resetDownloadTimer() {
  let interval = 900; // seconds; default 15 min
  if (state.storage && state.storage.updateInterval) {
    interval = parseInt(state.storage.updateInterval, 10) || 900;
  }
  if (browser.alarms) {
    browser.alarms.create('download', { periodInMinutes: Math.max(1, Math.ceil(interval / 60)) });
  }
}

// Messages from UI
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (message && message.method === 'download') {
      (async () => {
        try {
          await loadAsync('storage');
          await downloadOnlineURLs();
        } finally {
          // Respond to keep the service worker alive until finished
          try { sendResponse(true); } catch (_) {}
        }
      })();
      return true; // keep the message channel open
    }
    if (message && message.method === 'isDownloading') {
      sendResponse(!!state.downloading);
      return true;
    }
  } catch (e) {
    console.error(e);
  }
});

// Apply rules on activation and startup
browser.runtime.onInstalled.addListener(() => {
  log('Extension installed');
  applyDnrRules();
});

browser.runtime.onStartup.addListener(() => {
  log('Extension started');
  applyDnrRules();
});

function loadAsync(keys) {
  return new Promise((resolve) => {
    try {
      load(keys, (item) => { reload(item); resolve(); });
    } catch (_) { resolve(); }
  });
}
