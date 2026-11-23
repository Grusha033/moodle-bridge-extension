const DEFAULT_URL = "https://moodle-agent-bridge.onrender.com";

const bridgeUrlInput = document.getElementById("bridgeUrl");
const serverStateEl = document.getElementById("serverState");
const mongoStateEl = document.getElementById("mongoState");
const noticeEl = document.getElementById("notice");
const logBoxEl = document.getElementById("logBox");
const logSummaryEl = document.getElementById("logSummary");
const logListEl = document.getElementById("logList");
const settingsBoxEl = document.getElementById("settingsBox");

const saveBtn = document.getElementById("saveBtn");
const syncBtn = document.getElementById("syncBtn");
const pushDbBtn = document.getElementById("pushDbBtn");
const resendBtn = document.getElementById("resendBtn");
const toggleBtn = document.getElementById("toggleBtn");
const settingsToggleBtn = document.getElementById("settingsToggleBtn");
const openExtBtn = document.getElementById("openExtBtn");
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
    serverStateEl.textContent = "ОНЛАЙН";
    serverStateEl.className = "stat-val ok";
    if (health.data.mongoConnected) {
      mongoStateEl.textContent = `${health.data.kbTotal} ВОПР.`;
      mongoStateEl.className = "stat-val ok";
    } else {
      mongoStateEl.textContent = "ОФФЛАЙН";
      mongoStateEl.className = "stat-val err";
    }
  } else {
    serverStateEl.textContent = "ОФФЛАЙН";
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
  refreshStatus("Откройте тест Moodle — ответы загрузятся автоматически");
  sendMsg({ type: "CHECK_UPDATE" }).then((u) => {
    if (u && u.ok) {
      if (u.hasUpdate) {
        pendingDownloadUrl = u.downloadUrl;
        updateBannerEl.style.display = "block";
        downloadUpdateBtn.textContent = `СКАЧАТЬ ОБНОВЛЕНИЕ v${u.latestVersion}`;
        updateStateEl.textContent = `ДОСТУПНА v${u.latestVersion}`;
      } else {
        updateBannerEl.style.display = "none";
        updateStateEl.textContent = "ПОСЛЕДНЯЯ ВЕРСИЯ";
      }
    } else {
      updateStateEl.textContent = "GITHUB НЕДОСТУПЕН";
    }
  });
});

settingsToggleBtn.addEventListener("click", () => {
  const open = settingsBoxEl.style.display !== "none";
  settingsBoxEl.style.display = open ? "none" : "block";
  settingsToggleBtn.textContent = open ? "Настройки" : "Скрыть";
});

openExtBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/" });
});

downloadUpdateBtn.addEventListener("click", () => {
  if (pendingDownloadUrl) {
    chrome.tabs.create({ url: pendingDownloadUrl });
  }
});

saveBtn.addEventListener("click", async () => {
  const val = (bridgeUrlInput.value || DEFAULT_URL).trim().replace(/\/+$/, "");
  await chrome.storage.local.set({ bridgeUrl: val });
  await refreshStatus("Адрес сервера сохранён");
});

syncBtn.addEventListener("click", async () => {
  noticeEl.textContent = "Синхронизация с базой...";
  const res = await sendMsg({ type: "KB_SYNC", push: true });
  if (res && res.ok && res.bridgeOnline) {
    await refreshStatus(res.mongoConnected ? `База обновлена: ${res.kbTotal} вопр.` : "База недоступна");
  } else {
    await refreshStatus("Сервер просыпается — попробуйте через 10 сек");
  }
});

pushDbBtn.addEventListener("click", async () => {
  noticeEl.textContent = "Собираю правильные ответы и отправляю в базу...";
  const res = await sendToActiveTab("MAB_PUSH_DB");
  if (res && res.ok) {
    if (res.hidden) {
      await refreshStatus("На этой странице преподаватель скрыл ответы");
    } else if (res.cloudPushed) {
      await refreshStatus(`Готово! Новых: +${res.added || 0}, обновлено: ${res.updated || 0}`);
    } else {
      await refreshStatus(`Сохранено в кеш (${res.saved}), сервер недоступен`);
    }
  } else {
    await refreshStatus(res?.error || "Откройте страницу результатов теста (review.php)");
  }
});

resendBtn.addEventListener("click", async () => {
  noticeEl.textContent = "Обновляю ответы на странице...";
  const res = await sendToActiveTab("MAB_RESEND");
  if (res && res.ok) {
    await refreshStatus("Страница обновлена");
  } else {
    await refreshStatus(res?.error || "Откройте страницу теста Moodle");
  }
});

toggleBtn.addEventListener("click", async () => {
  const res = await sendToActiveTab("MAB_TOGGLE");
  if (res && res.ok) {
    toggleBtn.textContent = res.visible ? "Скрыть стрелку" : "Показать стрелку";
  } else {
    await refreshStatus("Откройте страницу теста Moodle");
  }
});
