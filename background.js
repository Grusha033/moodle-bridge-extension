const DEFAULT_SETTINGS = {
  bridgeUrl: "https://moodle-agent-bridge.onrender.com"
};

const PUBLIC_REPO = "Grusha033/moodle-bridge-extension";
const REMOTE_MANIFEST_URL = `https://raw.githubusercontent.com/${PUBLIC_REPO}/main/manifest.json`;
const DOWNLOAD_ZIP_URL = `https://github.com/${PUBLIC_REPO}/archive/refs/heads/main.zip`;
const REPO_URL = `https://github.com/${PUBLIC_REPO}`;

function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

async function checkForUpdate() {
  const currentVersion = chrome.runtime.getManifest().version;
  try {
    const resp = await fetch(`${REMOTE_MANIFEST_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) {
      return { ok: false, currentVersion, hasUpdate: false, error: `HTTP ${resp.status}` };
    }
    const remote = await resp.json();
    const latestVersion = String(remote.version || currentVersion);
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
    if (hasUpdate) {
      chrome.action.setBadgeText({ text: "UPD" });
      chrome.action.setBadgeBackgroundColor({ color: "#db2777" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
    const info = {
      ok: true,
      currentVersion,
      latestVersion,
      hasUpdate,
      downloadUrl: DOWNLOAD_ZIP_URL,
      repoUrl: REPO_URL,
      checkedAt: Date.now()
    };
    await chrome.storage.local.set({ updateInfo: info });
    return info;
  } catch (err) {
    return { ok: false, currentVersion, hasUpdate: false, error: String(err) };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  checkForUpdate();
});
chrome.runtime.onStartup.addListener(() => {
  checkForUpdate();
});

function normalizeLoose(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[?.!;: ]+$/g, "");
}

function stripOptionPrefix(s) {
  return String(s || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:\d+|[a-zа-яіїєґ])\s*[.)]\s*/i, "")
    .trim();
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    bridgeUrl: (stored.bridgeUrl || DEFAULT_SETTINGS.bridgeUrl).replace(/\/+$/, "")
  };
}

async function getLocalKb() {
  const { localKb } = await chrome.storage.local.get({ localKb: {} });
  return localKb && typeof localKb === "object" ? localKb : {};
}

async function saveLocalKb(kb) {
  await chrome.storage.local.set({ localKb: kb, kbUpdatedAt: Date.now() });
}

function mergeKbMaps(baseKb, incomingKb) {
  const merged = { ...baseKb };
  if (!incomingKb || typeof incomingKb !== "object") return merged;

  const entries = Array.isArray(incomingKb)
    ? incomingKb.map((it) => [normalizeLoose(it.qtext), it])
    : Object.entries(incomingKb);

  for (const [rawKey, entry] of entries) {
    if (!entry || typeof entry !== "object") continue;
    const key = normalizeLoose(entry.qtext || rawKey);
    if (!key) continue;
    const prev = merged[key];
    const prevTs = Number(prev?.updatedAt || 0);
    const nextTs = Number(entry.updatedAt || 0);
    if (!prev || nextTs >= prevTs) {
      merged[key] = {
        qtext: entry.qtext || prev?.qtext || "",
        type: entry.type || prev?.type || "unknown",
        correctTexts: Array.isArray(entry.correctTexts) ? entry.correctTexts : [],
        textAnswer: entry.textAnswer || null,
        matchAnswers: entry.matchAnswers || null,
        updatedAt: nextTs || Date.now() / 1000
      };
    }
  }
  return merged;
}

async function tryFetchBridge(bridgeUrl, path, method = "GET", body = undefined) {
  try {
    const init = {
      method,
      headers: { "Content-Type": "application/json" }
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const resp = await fetch(`${bridgeUrl}${path}`, init);
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

async function syncKb({ push = false } = {}) {
  const { bridgeUrl } = await getSettings();
  let kb = await getLocalKb();
  let cloudLoaded = false;
  let cloudPushed = false;
  let mongoConnected = false;

  // Ask bridge to force-refresh from MongoDB Atlas
  const syncRes = await tryFetchBridge(bridgeUrl, "/api/kb/sync", "POST", {});
  if (syncRes.ok && syncRes.data && syncRes.data.ok) {
    mongoConnected = Boolean(syncRes.data.mongoConnected);
    cloudLoaded = mongoConnected;
    if (Array.isArray(syncRes.data.items)) {
      kb = mergeKbMaps(kb, syncRes.data.items);
    }
    // If browser has any locally cached items not yet in MongoDB, push them up
    if (push && Object.keys(kb).length > 0) {
      const pushRes = await tryFetchBridge(bridgeUrl, "/api/kb/learn", "POST", {
        items: Object.values(kb)
      });
      cloudPushed = Boolean(pushRes.ok && pushRes.data && pushRes.data.mongoSaved);
    }
    await saveLocalKb(kb);
  }

  return {
    ok: true,
    kb,
    kbTotal: Object.keys(kb).length,
    cloudLoaded,
    cloudPushed,
    mongoConnected,
    bridgeOnline: Boolean(syncRes.ok)
  };
}

async function learnItems(items) {
  const { bridgeUrl } = await getSettings();
  let kb = await getLocalKb();

  let added = 0;
  let updated = 0;
  const now = Date.now() / 1000;
  const normalizedItems = [];

  for (const item of items || []) {
    const qtext = String(item.qtext || "").trim();
    const key = normalizeLoose(qtext);
    if (!key) continue;

    const correctTexts = (item.correctTexts || [])
      .map((t) => stripOptionPrefix(t))
      .filter((t) => normalizeLoose(t));
    const textAnswer = String(item.textAnswer || "").trim() || null;
    const matchAnswers = item.matchAnswers || null;
    if (correctTexts.length === 0 && !textAnswer && !matchAnswers) continue;

    if (kb[key]) updated += 1;
    else added += 1;

    const entry = {
      qtext,
      type: item.type || "unknown",
      correctTexts,
      textAnswer,
      matchAnswers,
      updatedAt: now
    };
    kb[key] = entry;
    normalizedItems.push(entry);
  }

  await saveLocalKb(kb);

  // Send to bridge -> MongoDB Atlas
  const bridgeRes = await tryFetchBridge(bridgeUrl, "/api/kb/learn", "POST", {
    items: normalizedItems
  });

  const mongoSaved = Boolean(bridgeRes.ok && bridgeRes.data && bridgeRes.data.mongoSaved);
  const srvAdded = bridgeRes.ok && bridgeRes.data ? Number(bridgeRes.data.added || 0) : added;
  const srvUpdated = bridgeRes.ok && bridgeRes.data ? Number(bridgeRes.data.updated || 0) : updated;
  const kbTotal = (bridgeRes.ok && bridgeRes.data && bridgeRes.data.kbTotal) || Object.keys(kb).length;
  const details =
    bridgeRes.ok && bridgeRes.data && Array.isArray(bridgeRes.data.details)
      ? bridgeRes.data.details
      : normalizedItems.map((it) => ({
          qtext: it.qtext,
          answerText: (it.correctTexts && it.correctTexts.join("; ")) || it.textAnswer || "",
          status: "saved"
        }));

  const summary = {
    ok: true,
    added: srvAdded,
    updated: srvUpdated,
    kbTotal,
    bridgeOnline: Boolean(bridgeRes.ok),
    cloudPushed: mongoSaved,
    cloudError: bridgeRes.data?.mongoError || null,
    details,
    timestamp: Date.now()
  };

  await chrome.storage.local.set({ lastImport: summary });
  return summary;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;

  if (message.type === "BRIDGE_FETCH") {
    (async () => {
      const { bridgeUrl } = await getSettings();
      const res = await tryFetchBridge(bridgeUrl, message.path, message.method || "GET", message.body);
      sendResponse(res);
    })();
    return true;
  }

  if (message.type === "KB_SYNC") {
    syncKb({ push: Boolean(message.push) })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "KB_LEARN") {
    learnItems(message.items)
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "KB_GET_LOCAL") {
    getLocalKb()
      .then((kb) => sendResponse({ ok: true, kb, kbTotal: Object.keys(kb).length }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message.type === "CHECK_UPDATE") {
    checkForUpdate()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  return false;
});
