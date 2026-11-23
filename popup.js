const DEFAULT_URL = "https://moodle-agent-bridge.onrender.com";

const bridgeUrlInput = document.getElementById("bridgeUrl");
const serverStateEl = document.getElementById("serverState");
const mongoStateEl = document.getElementById("mongoState");
const noticeEl = document.getElementById("notice");
const logBoxEl = document.getElementById("logBox");
const logSummaryEl = document.getElementById("logSummary");
const logListEl = document.getElementById("logList");

const saveBtn = document.getElementById("saveBtn");
const syncBtn = document.getElementById("syncBtn");
const pushDbBtn = document.getElementById("pushDbBtn");
const resendBtn = document.getElementById("resendBtn");
const toggleBtn = document.getElementById("toggleBtn");
const updateBannerEl = document.getElementById("updateBanner");
const downloadUpdateBtn = document.getElementById("downloadUpdateBtn");
const versionLabelEl = document.getElementById("versionLabel");
const updateStateEl = document.getElementById("updateState");

let pendingDownloadUrl = "";

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sendMsg(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false });
      }
    });
  });
}

function renderLastImport(lastImport) {
  if (!lastImport || !Array.isArray(lastImport.details) || lastImport.details.length === 0) {
    logBoxEl.style.display = "none";
    return;
  }
  logBoxEl.style.display = "block";
  logSummaryEl.textContent = `+${lastImport.added || 0} / ОБН ${lastImport.updated || 0}`;
  logListEl.innerHTML = lastImport.details
    .map((item) => {
      const isNew = item.status === "added";
      const badge = isNew
        ? '<span class="badge badge-new">NEW</span>'
        : '<span class="badge badge-upd">UPD</span>';
      const q = (item.qtext || "").slice(0, 75);
      const a = (item.answerText || "").slice(0, 75);
      return `<div class="log-item">${badge}${escapeHtml(q)}<span class="log-ans">${escapeHtml(a)}</span></div>`;
    })
    .join("");
}

async function refreshStatus(note = "") {
  const [health, local, stored] = await Promise.all([
    sendMsg({ type: "BRIDGE_FETCH", path: "/api/health", method: "GET" }),
    sendMsg({ type: "KB_GET_LOCAL" }),
    chrome.storage.local.get({ lastImport: null })
  ]);

  if (health && health.ok && health.data && health.data.ok) {
    serverStateEl.textContent = "ONLINE";
    serverStateEl.className = "stat-val ok";
    if (health.data.mongoConnected) {
      mongoStateEl.textContent = `${health.data.kbTotal} ВОПР.`;
      mongoStateEl.className = "stat-val ok";
    } else {
      mongoStateEl.textContent = "OFFLINE";
      mongoStateEl.className = "stat-val err";
    }
  } else {
    serverStateEl.textContent = "OFFLINE";
    serverStateEl.className = "stat-val err";
    const cached = local && local.ok ? local.kbTotal : 0;
    mongoStateEl.textContent = `КЕШ ${cached}`;
    mongoStateEl.className = "stat-val";
  }

  if (note) {
    noticeEl.textContent = note;
  }

  renderLastImport(stored.lastImport);
}

async function sendToActiveTab(type) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return { ok: false, error: "Нет активной вкладки" };
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, { type }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: "Откройте страницу теста Moodle" });
      } else {
        resolve(res || { ok: false });
      }
    });
  });
}

chrome.storage.local.get({ bridgeUrl: DEFAULT_URL }, ({ bridgeUrl }) => {
  bridgeUrlInput.value = bridgeUrl || DEFAULT_URL;
  versionLabelEl.textContent = `v${chrome.runtime.getManifest().version}`;
  refreshStatus("Готово к работе");
  sendMsg({ type: "CHECK_UPDATE" }).then((u) => {
    if (u && u.ok) {
      if (u.hasUpdate) {
        pendingDownloadUrl = u.downloadUrl;
        updateBannerEl.style.display = "block";
        downloadUpdateBtn.textContent = `ОБНОВЛЕНИЕ v${u.latestVersion} - СКАЧАТЬ`;
        updateStateEl.textContent = `ДОСТУПНА v${u.latestVersion}`;
      } else {
        updateBannerEl.style.display = "none";
        updateStateEl.textContent = "АКТУАЛЬНАЯ ВЕРСИЯ";
      }
    } else {
      updateStateEl.textContent = "НЕТ СВЯЗИ С GITHUB";
    }
  });
});

downloadUpdateBtn.addEventListener("click", () => {
  if (pendingDownloadUrl) {
    chrome.tabs.create({ url: pendingDownloadUrl });
  }
});

saveBtn.addEventListener("click", async () => {
  const val = (bridgeUrlInput.value || DEFAULT_URL).trim().replace(/\/+$/, "");
  await chrome.storage.local.set({ bridgeUrl: val });
  await refreshStatus("Адрес сохранён");
});

syncBtn.addEventListener("click", async () => {
  noticeEl.textContent = "Синхронизация с MongoDB...";
  const res = await sendMsg({ type: "KB_SYNC", push: true });
  if (res && res.ok && res.bridgeOnline) {
    await refreshStatus(res.mongoConnected ? `Синхронизировано: ${res.kbTotal} вопр.` : "MongoDB недоступна");
  } else {
    await refreshStatus("Сервер не запущен");
  }
});

pushDbBtn.addEventListener("click", async () => {
  noticeEl.textContent = "Сбор ответов и отправка в БД...";
  const res = await sendToActiveTab("MAB_PUSH_DB");
  if (res && res.ok) {
    if (res.hidden) {
      await refreshStatus("На этой странице ответы скрыты");
    } else if (res.cloudPushed) {
      await refreshStatus(`В БД: новых +${res.added || 0}, обновлено ${res.updated || 0}`);
    } else {
      await refreshStatus(`Сохранено в кеш (${res.saved}), сервер оффлайн`);
    }
  } else {
    await refreshStatus(res?.error || "Откройте review.php (просмотр теста)");
  }
});

resendBtn.addEventListener("click", () => sendToActiveTab("MAB_RESEND"));
toggleBtn.addEventListener("click", () => sendToActiveTab("MAB_TOGGLE"));
