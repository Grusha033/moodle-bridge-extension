(() => {
  const POLL_INTERVAL_MS = 700;
  const FETCH_CONCURRENCY = 4;
  const OVERLAY_ID = "moodle-agent-bridge-overlay";
  const WIDGET_ID = "moodle-agent-bridge-widget";

  const RIGHT_ANSWER_PREFIX_RE =
    /^(?:Правильна відповідь|Правильні відповіді|Правильный ответ|Правильные ответы|The correct answer is|The correct answers are)\s*:\s*/i;

  const SVG_REFRESH =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>';
  const SVG_EYE =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const SVG_CHEVRON_UP =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
  const SVG_CHEVRON_DOWN =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

  let localQuestions = [];
  let elementMap = new Map();
  let allItems = [];
  let currentAnswers = {};
  let kbMap = {};
  let kbTotal = 0;
  let overlayVisible = true;
  let panelExpanded = false;
  let bridgeOnline = false;
  let cloudSynced = false;
  let scanningProgress = null;
  let reviewLearnInfo = null;
  let pollTimer = null;
  let repositionRaf = null;
  let lastPanelHash = "";

  function cleanText(str) {
    return (str || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeLoose(str) {
    return cleanText(str).toLowerCase().replace(/[?.!;: ]+$/g, "");
  }

  function stripOptionPrefix(str) {
    return cleanText(str).replace(/^(?:\d+|[a-zа-яіїєґ])\s*[.)]\s*/i, "").trim();
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function extractCleanOptionText(labelEl) {
    if (!labelEl) return "";
    const clone = labelEl.cloneNode(true);
    clone.querySelectorAll(".answernumber, .accesshide, .sr-only, i.icon").forEach((n) => n.remove());
    return cleanText(clone.innerText || clone.textContent);
  }

  function sendMsg(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: "Empty response" });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  function bridgeFetch(path, method = "GET", body = undefined) {
    return sendMsg({ type: "BRIDGE_FETCH", path, method, body });
  }

  function matchQuestionWithKb(q) {
    const qkey = normalizeLoose(q.qtext || "");
    if (!qkey || !kbMap[qkey]) return null;
    const entry = kbMap[qkey];

    const options = q.options || [];
    const correctTexts = entry.correctTexts || [];

    if (options.length > 0 && correctTexts.length > 0) {
      const targets = correctTexts.map((t) => normalizeLoose(t)).filter(Boolean);
      const uniqueTargets = new Set(targets);
      const matched = [];
      for (const opt of options) {
        const optClean = opt.cleanText || stripOptionPrefix(opt.text || "");
        if (uniqueTargets.has(normalizeLoose(optClean))) {
          matched.push(Number(opt.index));
        }
      }
      if (matched.length > 0 && matched.length >= uniqueTargets.size) {
        return {
          questionId: q.questionId,
          correctIndices: Array.from(new Set(matched)).sort((a, b) => a - b),
          textAnswer: null,
          matchAnswers: null,
          note: "100% из базы MongoDB",
          source: "kb"
        };
      }
    }

    if (entry.textAnswer && q.type === "shortanswer") {
      return {
        questionId: q.questionId,
        correctIndices: [],
        textAnswer: entry.textAnswer,
        matchAnswers: null,
        note: "100% из базы MongoDB",
        source: "kb"
      };
    }

    if (entry.matchAnswers && q.type === "match") {
      return {
        questionId: q.questionId,
        correctIndices: [],
        textAnswer: null,
        matchAnswers: entry.matchAnswers,
        note: "100% из базы MongoDB",
        source: "kb"
      };
    }

    return null;
  }

  function applyLocalKbToQuestions(questions) {
    for (const q of questions) {
      const kbAns = matchQuestionWithKb(q);
      if (kbAns) {
        currentAnswers[q.questionId] = kbAns;
      }
    }
  }

  function isReviewPage(doc = document) {
    if (/\/mod\/quiz\/review\.php/i.test(window.location.pathname)) return true;
    const firstQue = doc.querySelector("div.que");
    if (!firstQue) return false;
    if (firstQue.querySelector(".outcome .rightanswer")) return true;
    const disabledInput = firstQue.querySelector(".answer input[disabled], .answer select[disabled]");
    const hasGradeState =
      firstQue.classList.contains("correct") ||
      firstQue.classList.contains("incorrect") ||
      firstQue.classList.contains("partiallycorrect");
    return Boolean(disabledInput && hasGradeState);
  }

  function getAttemptKey() {
    try {
      const u = new URL(window.location.href);
      const attempt = u.searchParams.get("attempt");
      const cmid = u.searchParams.get("cmid");
      if (attempt) return `attempt-${attempt}${cmid ? `-cmid-${cmid}` : ""}`;
      if (u.protocol === "file:") {
        return `file-${document.title.replace(/\(сторінка.*$/i, "").trim()}`;
      }
      return `${u.origin}${u.pathname}`;
    } catch {
      return window.location.href;
    }
  }

  function parseQuestionsFromDocument(doc, pageUrl, pageTitle, collectDomRefs = false) {
    const queNodes = Array.from(doc.querySelectorAll("div.que"));
    const questions = [];
    const domRefs = collectDomRefs ? new Map() : null;

    queNodes.forEach((queEl, idx) => {
      const questionId = queEl.id || `que-auto-${idx + 1}`;
      const qnoEl = queEl.querySelector(".info .qno");
      const qno = cleanText(qnoEl ? qnoEl.textContent : String(idx + 1));

      const qtextEl = queEl.querySelector(".formulation .qtext");
      const qtext = cleanText(qtextEl ? qtextEl.innerText || qtextEl.textContent : "");
      const images = qtextEl
        ? Array.from(qtextEl.querySelectorAll("img"))
            .map((img) => img.getAttribute("src") || "")
            .filter(Boolean)
        : [];

      const promptEl = queEl.querySelector(".formulation .ablock .prompt");
      const prompt = cleanText(promptEl ? promptEl.textContent : "");

      const answerContainer = queEl.querySelector(".formulation .ablock .answer");
      const options = [];
      const optionEls = new Map();
      const matchRows = [];
      const matchSelects = new Map();
      let textInput = null;
      let type = "unknown";

      if (answerContainer) {
        const rows = Array.from(
          answerContainer.querySelectorAll(":scope > .r0, :scope > .r1, :scope > div")
        );
        const choiceRows = rows.filter((row) =>
          row.querySelector('input[type="radio"], input[type="checkbox"]')
        );

        if (choiceRows.length > 0) {
          const firstInput = choiceRows[0].querySelector('input[type="radio"], input[type="checkbox"]');
          type = firstInput && firstInput.type === "checkbox" ? "multichoice_multi" : "multichoice_single";

          choiceRows.forEach((row) => {
            const input = row.querySelector('input[type="radio"], input[type="checkbox"]');
            if (!input || input.value === "-1") return;
            const index = options.length + 1;
            const label =
              row.querySelector("label") ||
              row.querySelector('[data-region="answer-label"]') ||
              row;
            const text = cleanText(label.innerText || label.textContent);
            const cleanOpt = extractCleanOptionText(label);
            options.push({
              index,
              inputId: input.id || "",
              value: input.value,
              text,
              cleanText: cleanOpt
            });
            if (collectDomRefs) {
              optionEls.set(index, { row, input, label });
            }
          });
        } else if (answerContainer.querySelector("select")) {
          type = "match";
          const trs = Array.from(answerContainer.querySelectorAll("tr"));
          trs.forEach((tr, i) => {
            const select = tr.querySelector("select");
            if (!select) return;
            const index = i + 1;
            const textTd = tr.querySelector(".text") || tr.querySelector("td");
            const choices = Array.from(select.options)
              .map((o) => cleanText(o.textContent))
              .filter((t) => t && !/^виберіть|choose/i.test(t));
            matchRows.push({
              index,
              text: cleanText(textTd ? textTd.textContent : ""),
              choices
            });
            if (collectDomRefs) {
              matchSelects.set(index, { row: tr, select });
            }
          });
        } else if (answerContainer.querySelector('input[type="text"], textarea')) {
          type = "shortanswer";
          textInput = answerContainer.querySelector('input[type="text"], textarea');
        }
      }

      questions.push({
        questionId,
        qno,
        type,
        qtext,
        prompt,
        images,
        options,
        matchRows,
        pageUrl,
        pageTitle
      });

      if (collectDomRefs) {
        domRefs.set(questionId, {
          root: queEl,
          qtextEl,
          optionEls,
          textInput,
          matchSelects
        });
      }
    });

    return { questions, domRefs };
  }

  function extractReviewAnswersFromDocument(doc) {
    const queNodes = Array.from(doc.querySelectorAll("div.que"));
    const learned = [];

    for (const queEl of queNodes) {
      const qtextEl = queEl.querySelector(".formulation .qtext");
      const qtext = cleanText(qtextEl ? qtextEl.innerText || qtextEl.textContent : "");
      if (!qtext) continue;

      const answerContainer = queEl.querySelector(".formulation .ablock .answer");
      const optionRows = answerContainer
        ? Array.from(answerContainer.querySelectorAll(":scope > .r0, :scope > .r1, :scope > div")).filter((row) =>
            row.querySelector('input[type="radio"], input[type="checkbox"]')
          )
        : [];

      const isMulti = optionRows.some((r) => r.querySelector('input[type="checkbox"]'));
      const type =
        optionRows.length > 0
          ? isMulti
            ? "multichoice_multi"
            : "multichoice_single"
          : answerContainer && answerContainer.querySelector('input[type="text"], textarea')
          ? "shortanswer"
          : answerContainer && answerContainer.querySelector("select")
          ? "match"
          : "unknown";

      const optCleanList = optionRows.map((row) => {
        const label = row.querySelector("label") || row.querySelector('[data-region="answer-label"]') || row;
        return {
          row,
          input: row.querySelector('input[type="radio"], input[type="checkbox"]'),
          cleanText: extractCleanOptionText(label)
        };
      });

      let correctTexts = [];
      let textAnswer = null;

      const raEl = queEl.querySelector(".outcome .rightanswer");
      if (raEl) {
        const raRaw = cleanText(raEl.innerText || raEl.textContent).replace(RIGHT_ANSWER_PREFIX_RE, "").trim();
        if (raRaw) {
          if (optCleanList.length > 0) {
            const raNorm = normalizeLoose(raRaw);
            const exact = optCleanList.find((o) => normalizeLoose(o.cleanText) === raNorm);
            if (exact) {
              correctTexts = [exact.cleanText];
            } else if (isMulti) {
              const sortedOpts = [...optCleanList].sort((a, b) => b.cleanText.length - a.cleanText.length);
              let remaining = raNorm;
              for (const opt of sortedOpts) {
                const on = normalizeLoose(opt.cleanText);
                if (on && remaining.includes(on)) {
                  correctTexts.push(opt.cleanText);
                  remaining = remaining.replace(on, " ");
                }
              }
            }
            if (correctTexts.length === 0) {
              correctTexts = [raRaw];
            }
          } else if (type === "shortanswer") {
            textAnswer = raRaw;
          }
        }
      }

      if (correctTexts.length === 0 && !textAnswer && optCleanList.length > 0) {
        const isWholeQueCorrect = queEl.classList.contains("correct");
        const markedCorrect = optCleanList.filter(
          (o) => o.row.classList.contains("correct") || (isWholeQueCorrect && o.input && o.input.checked)
        );
        if (markedCorrect.length > 0) {
          correctTexts = markedCorrect.map((o) => o.cleanText).filter(Boolean);
        }
      }

      if (correctTexts.length > 0 || textAnswer) {
        learned.push({ qtext, type, correctTexts, textAnswer });
      }
    }

    return { totalOnPage: queNodes.length, learned };
  }

  function getQuizPageLinks() {
    if (window.location.protocol !== "http:" && window.location.protocol !== "https:") {
      return [];
    }
    const navLinks = Array.from(document.querySelectorAll(".qn_buttons a.qnbutton[href]"));
    if (navLinks.length === 0) return [];

    const currentNormalized = window.location.href.split("#")[0];
    const seenPages = new Set();
    const pages = [];

    for (const a of navLinks) {
      if (a.classList.contains("blocked")) continue;
      const rawHref = a.getAttribute("href");
      if (!rawHref || rawHref === "#") continue;
      let absUrl;
      try {
        const u = new URL(rawHref, window.location.href);
        if (u.origin !== window.location.origin) continue;
        u.hash = "";
        absUrl = u.toString();
      } catch {
        continue;
      }
      const pageKey = a.getAttribute("data-quiz-page") || absUrl;
      if (seenPages.has(pageKey)) continue;
      seenPages.add(pageKey);
      const isCurrent = a.classList.contains("thispage") || absUrl === currentNormalized;
      pages.push({ pageKey, url: absUrl, isCurrent });
    }
    return pages;
  }

  async function syncCloudKb() {
    const res = await sendMsg({ type: "KB_SYNC", push: false });
    if (res && res.ok) {
      kbMap = res.kb || {};
      kbTotal = res.kbTotal || Object.keys(kbMap).length;
      cloudSynced = Boolean(res.cloudLoaded);
      bridgeOnline = Boolean(res.bridgeOnline);
    }
  }

  async function runReviewAutoLearn() {
    reviewLearnInfo = {
      ...(reviewLearnInfo || {}),
      busy: true
    };
    updateWidget();

    let allLearned = [];
    let totalQuestions = 0;

    const first = extractReviewAnswersFromDocument(document);
    allLearned.push(...first.learned);
    totalQuestions = first.totalOnPage;

    const pages = getQuizPageLinks();
    const otherPages = pages.filter((p) => !p.isCurrent);
    if (otherPages.length > 0) {
      scanningProgress = { done: 1, total: pages.length };
      updateWidget();
      const parser = new DOMParser();
      const queue = [...otherPages];
      let done = 1;
      async function worker() {
        while (queue.length > 0) {
          const page = queue.shift();
          try {
            const resp = await fetch(page.url, { credentials: "include" });
            if (resp.ok) {
              const doc = parser.parseFromString(await resp.text(), "text/html");
              const res = extractReviewAnswersFromDocument(doc);
              allLearned.push(...res.learned);
              totalQuestions += res.totalOnPage;
            }
          } catch {
            // ignore
          } finally {
            done += 1;
            scanningProgress = { done, total: pages.length };
            updateWidget();
          }
        }
      }
      const workers = [];
      for (let i = 0; i < Math.min(FETCH_CONCURRENCY, otherPages.length); i++) {
        workers.push(worker());
      }
      await Promise.all(workers);
      scanningProgress = null;
    }

    if (allLearned.length === 0) {
      await syncCloudKb();
      reviewLearnInfo = {
        saved: 0,
        added: 0,
        updated: 0,
        total: totalQuestions,
        kbTotal,
        hidden: true,
        cloudPushed: false,
        busy: false
      };
      updateWidget();
      return { ok: true, ...reviewLearnInfo };
    }

    const res = await sendMsg({ type: "KB_LEARN", items: allLearned });
    if (res && res.ok) {
      bridgeOnline = Boolean(res.bridgeOnline);
      kbTotal = res.kbTotal || 0;
      cloudSynced = Boolean(res.cloudPushed);
      const details = Array.isArray(res.details) ? res.details : [];
      reviewLearnInfo = {
        saved: allLearned.length,
        added: Number(res.added || 0),
        updated: Number(res.updated || 0),
        total: totalQuestions,
        kbTotal,
        hidden: false,
        cloudPushed: Boolean(res.cloudPushed),
        cloudError: res.cloudError || null,
        busy: false
      };
      allItems = details.length > 0
        ? details.map((d, i) => ({
            questionId: `review-${i + 1}`,
            qno: String(i + 1),
            qtext: d.qtext,
            pageUrl: "",
            options: [],
            importStatus: d.status, // "added" | "updated" | "saved"
            answer: {
              source: "kb",
              correctIndices: [],
              textAnswer: d.answerText || ""
            }
          }))
        : allLearned.map((it, i) => ({
            questionId: `review-${i + 1}`,
            qno: String(i + 1),
            qtext: it.qtext,
            pageUrl: "",
            options: [],
            importStatus: "saved",
            answer: {
              source: "kb",
              correctIndices: [],
              textAnswer: (it.correctTexts && it.correctTexts.join("; ")) || it.textAnswer || ""
            }
          }));
      // Automatically expand the drawer so user can immediately see what was added/updated
      panelExpanded = true;
      lastPanelHash = "";
    } else {
      reviewLearnInfo = {
        saved: 0,
        added: 0,
        updated: 0,
        total: totalQuestions,
        kbTotal,
        hidden: false,
        cloudPushed: false,
        cloudError: res?.error || "Ошибка отправки",
        busy: false
      };
    }
    updateWidget();
    return { ok: Boolean(res && res.ok), ...reviewLearnInfo };
  }

  async function scanAllPages(force = false) {
    await syncCloudKb();

    const { questions: currentPageQs, domRefs } = parseQuestionsFromDocument(
      document,
      window.location.href.split("#")[0],
      document.title,
      true
    );
    localQuestions = currentPageQs;
    elementMap = domRefs;

    applyLocalKbToQuestions(currentPageQs);
    renderArrows();

    const attemptKey = getAttemptKey();
    const pages = getQuizPageLinks();
    const otherPages = pages.filter((p) => !p.isCurrent);

    const scanFlagKey = `mab_scanned_${attemptKey}`;
    const cacheItemsKey = `mab_items_${attemptKey}`;
    const alreadyScanned = !force && sessionStorage.getItem(scanFlagKey) === String(pages.length);

    let allCollected = currentPageQs;

    if (otherPages.length > 0 && !alreadyScanned) {
      allCollected = [...currentPageQs];
      const seenQids = new Set(currentPageQs.map((q) => q.questionId));
      const totalPages = pages.length;
      let donePages = 1;
      scanningProgress = { done: donePages, total: totalPages };
      updateWidget();

      const queue = [...otherPages];
      const parser = new DOMParser();

      async function worker() {
        while (queue.length > 0) {
          const page = queue.shift();
          try {
            const resp = await fetch(page.url, { credentials: "include" });
            if (resp.ok) {
              const html = await resp.text();
              const doc = parser.parseFromString(html, "text/html");
              const { questions: pageQs } = parseQuestionsFromDocument(
                doc,
                page.url,
                doc.title || document.title,
                false
              );
              for (const q of pageQs) {
                if (!seenQids.has(q.questionId)) {
                  seenQids.add(q.questionId);
                  allCollected.push(q);
                }
              }
            }
          } catch {
            // ignore
          } finally {
            donePages += 1;
            scanningProgress = { done: donePages, total: totalPages };
            updateWidget();
          }
        }
      }

      const workers = [];
      for (let i = 0; i < Math.min(FETCH_CONCURRENCY, otherPages.length); i++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      scanningProgress = null;
      allCollected.sort((a, b) => Number(a.qno || 0) - Number(b.qno || 0));
      sessionStorage.setItem(scanFlagKey, String(pages.length));
      try {
        sessionStorage.setItem(cacheItemsKey, JSON.stringify(allCollected));
      } catch {
        // ignore
      }
    } else if (alreadyScanned) {
      try {
        const cached = JSON.parse(sessionStorage.getItem(cacheItemsKey) || "[]");
        if (Array.isArray(cached) && cached.length > 0) {
          allCollected = cached;
        }
      } catch {
        // ignore
      }
    }

    applyLocalKbToQuestions(allCollected);
    allItems = allCollected.map((q) => ({
      questionId: q.questionId,
      qno: q.qno,
      type: q.type,
      qtext: q.qtext,
      pageUrl: q.pageUrl,
      options: q.options,
      answer: currentAnswers[q.questionId] || null
    }));
    renderArrows();
    updateWidget();

    const res = await bridgeFetch("/api/questions", "POST", {
      attemptKey,
      pageUrl: window.location.href.split("#")[0],
      pageTitle: document.title,
      questions: allCollected,
      force,
      replaceAll: otherPages.length > 0 && !alreadyScanned
    });
    if (res && res.ok && res.data && res.data.ok) {
      bridgeOnline = true;
      const bridgeAnswers = res.data.answers || {};
      for (const [qid, ans] of Object.entries(bridgeAnswers)) {
        if (!currentAnswers[qid] || currentAnswers[qid].source !== "kb") {
          currentAnswers[qid] = ans;
        }
      }
      if (Array.isArray(res.data.items) && res.data.items.length > 0) {
        allItems = res.data.items.map((it) => ({
          ...it,
          answer: currentAnswers[it.questionId] || it.answer || null
        }));
      }
      renderArrows();
    } else {
      bridgeOnline = false;
    }
    updateWidget();
  }

  function ensureOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      document.body.appendChild(overlay);
    }
    overlay.style.display = overlayVisible ? "block" : "none";
    return overlay;
  }

  function createArrowElement(answer) {
    const isKb = answer.source === "kb";
    const wrap = document.createElement("div");
    wrap.className = "mab-arrow-wrap" + (isKb ? " mab-arrow-kb" : "");
    const gradId = isKb ? "mabGradKb" : "mabGradOk";
    const cTop = isKb ? "#fde047" : "#bef264";
    const cMid = isKb ? "#f59e0b" : "#65a30d";
    const cBot = isKb ? "#d97706" : "#3f6212";
    const stroke = isKb ? "#78350f" : "#1a2e05";
    wrap.innerHTML = `
      <svg class="mab-arrow-svg" viewBox="0 0 68 40" width="68" height="40" aria-hidden="true">
        <defs>
          <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${cTop}"/>
            <stop offset="55%" stop-color="${cMid}"/>
            <stop offset="100%" stop-color="${cBot}"/>
          </linearGradient>
        </defs>
        <!-- Tiny bouncing sparkle behind tail -->
        <path class="mab-sparkle" d="M6 7 L7.5 10.5 L11 12 L7.5 13.5 L6 17 L4.5 13.5 L1 12 L4.5 10.5 Z" fill="#fde047" stroke="#92400e" stroke-width="1"/>
        <!-- Chunky 3D shadow lip -->
        <path d="M12 16 H36 V8 L63 22 L36 36 V28 H12 Q8 28 8 22 Q8 16 12 16 Z" fill="${stroke}" opacity="0.9"/>
        <!-- Glossy cartoon arrow body -->
        <path d="M12 13 H36 V5 L63 19 L36 33 V25 H12 Q8 25 8 19 Q8 13 12 13 Z" fill="url(#${gradId})" stroke="${stroke}" stroke-width="2.6" stroke-linejoin="round"/>
        <!-- Top glossy shine -->
        <path d="M14 15.5 H36.5 V9.5 L54 18.5" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.6"/>
        <!-- Funny cartoon eyes staring at the answer -->
        <ellipse cx="22" cy="19" rx="3.4" ry="4" fill="#ffffff" stroke="${stroke}" stroke-width="1.4"/>
        <ellipse cx="30" cy="19" rx="3.4" ry="4" fill="#ffffff" stroke="${stroke}" stroke-width="1.4"/>
        <circle cx="23.4" cy="19" r="1.7" fill="#0f172a"/>
        <circle cx="31.4" cy="19" r="1.7" fill="#0f172a"/>
        <circle cx="24" cy="18" r="0.6" fill="#ffffff"/>
        <circle cx="32" cy="18" r="0.6" fill="#ffffff"/>
      </svg>
    `;
    if (answer.note) wrap.title = answer.note;
    return wrap;
  }

  function createHintBubble(text) {
    const bubble = document.createElement("div");
    bubble.className = "mab-hint-bubble";
    bubble.textContent = text;
    return bubble;
  }

  function renderArrows() {
    const overlay = ensureOverlay();
    overlay.innerHTML = "";
    if (!overlayVisible) return;

    const scrollX = window.scrollX || document.documentElement.scrollLeft;
    const scrollY = window.scrollY || document.documentElement.scrollTop;

    for (const [qid, refs] of elementMap.entries()) {
      const answer = currentAnswers[qid];
      if (!answer) continue;

      const indices = Array.isArray(answer.correctIndices) ? answer.correctIndices : [];
      for (const idx of indices) {
        const optRef = refs.optionEls.get(Number(idx));
        if (!optRef) continue;
        const target = optRef.input || optRef.row;
        const rect = target.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;

        const arrow = createArrowElement(answer);
        const arrowWidth = 68;
        const arrowHeight = 40;
        const left = Math.max(4, rect.left + scrollX - arrowWidth - 4);
        const top = rect.top + scrollY + rect.height / 2 - arrowHeight / 2;
        arrow.style.left = `${left}px`;
        arrow.style.top = `${top}px`;
        overlay.appendChild(arrow);
      }

      if (answer.textAnswer && refs.textInput) {
        const rect = refs.textInput.getBoundingClientRect();
        const bubble = createHintBubble(answer.textAnswer);
        bubble.style.left = `${rect.right + scrollX + 10}px`;
        bubble.style.top = `${rect.top + scrollY + rect.height / 2 - 14}px`;
        overlay.appendChild(bubble);
      }

      if (answer.matchAnswers && typeof answer.matchAnswers === "object") {
        for (const [rowIdx, choiceText] of Object.entries(answer.matchAnswers)) {
          const matchRef = refs.matchSelects.get(Number(rowIdx));
          if (!matchRef) continue;
          const rect = matchRef.select.getBoundingClientRect();
          const bubble = createHintBubble(choiceText);
          bubble.style.left = `${rect.right + scrollX + 8}px`;
          bubble.style.top = `${rect.top + scrollY + rect.height / 2 - 14}px`;
          overlay.appendChild(bubble);
        }
      }

      if (answer.note && indices.length === 0 && !answer.textAnswer && !answer.matchAnswers) {
        const anchor = refs.qtextEl || refs.root;
        const rect = anchor.getBoundingClientRect();
        const bubble = createHintBubble(answer.note);
        bubble.style.left = `${rect.left + scrollX}px`;
        bubble.style.top = `${rect.bottom + scrollY + 4}px`;
        overlay.appendChild(bubble);
      }
    }
  }

  function scheduleReposition() {
    if (repositionRaf) return;
    repositionRaf = requestAnimationFrame(() => {
      repositionRaf = null;
      renderArrows();
    });
  }

  function formatAnswerSummary(item) {
    const ans = item.answer;
    if (!ans) return bridgeOnline ? "Ожидает ответа агента" : "Нет в базе";
    const parts = [];
    if (Array.isArray(ans.correctIndices) && ans.correctIndices.length > 0) {
      const labels = ans.correctIndices.map((idx) => {
        const opt = (item.options || []).find((o) => Number(o.index) === Number(idx));
        return opt ? `[${idx}] ${opt.text}` : `[${idx}]`;
      });
      parts.push(labels.join("; "));
    }
    if (ans.textAnswer) parts.push(ans.textAnswer);
    if (ans.matchAnswers) parts.push("Соответствия готовы");
    if (ans.note && parts.length === 0) parts.push(ans.note);
    return parts.join(" | ") || "Готово";
  }

  function ensureWidget() {
    let widget = document.getElementById(WIDGET_ID);
    if (!widget) {
      widget = document.createElement("div");
      widget.id = WIDGET_ID;
      widget.innerHTML = `
        <div class="mab-panel" style="display:none;">
          <div class="mab-panel-top">
            <div class="mab-ribbon">QUIZ PANEL</div>
            <div class="mab-stats-row"></div>
            <div class="mab-progress-track"><div class="mab-progress-fill"></div></div>
          </div>
          <div class="mab-panel-list"></div>
        </div>
        <div class="mab-bar">
          <div class="mab-bar-main" data-action="expand" title="Открыть список вопросов">
            <span class="mab-dot"></span>
            <span class="mab-status-text">BRIDGE</span>
            <span class="mab-chevron">${SVG_CHEVRON_UP}</span>
          </div>
          <button class="mab-push-btn" data-action="push-db" style="display:none;" title="Собрать правильные ответы со всех страниц теста и сохранить в MongoDB">В БД</button>
          <button class="mab-icon-btn" data-action="scan" title="Обновить базу и пересканировать">${SVG_REFRESH}</button>
          <button class="mab-icon-btn" data-action="toggle" title="Показать/скрыть стрелку (Alt+M)">${SVG_EYE}</button>
        </div>
      `;

      widget.addEventListener("click", (e) => {
        const row = e.target.closest(".mab-q-row[data-url]");
        if (row) {
          const url = row.getAttribute("data-url");
          if (url && url !== window.location.href.split("#")[0] && url.startsWith("http")) {
            window.location.href = url;
          }
          return;
        }
        const actionEl = e.target.closest("[data-action]");
        if (!actionEl) return;
        const action = actionEl.getAttribute("data-action");
        if (action === "expand") {
          panelExpanded = !panelExpanded;
          updateWidget();
        } else if (action === "push-db") {
          runReviewAutoLearn();
        } else if (action === "scan") {
          if (isReviewPage()) {
            runReviewAutoLearn();
          } else {
            scanAllPages(true);
          }
        } else if (action === "toggle") {
          overlayVisible = !overlayVisible;
          renderArrows();
          updateWidget();
        }
      });

      document.body.appendChild(widget);
    }
    return widget;
  }

  function updateWidget() {
    const widget = ensureWidget();
    const dot = widget.querySelector(".mab-dot");
    const text = widget.querySelector(".mab-status-text");
    const chevron = widget.querySelector(".mab-chevron");
    const toggleBtn = widget.querySelector('button[data-action="toggle"]');
    const pushDbBtn = widget.querySelector('button[data-action="push-db"]');
    const panel = widget.querySelector(".mab-panel");
    const ribbon = widget.querySelector(".mab-ribbon");
    const statsRow = widget.querySelector(".mab-stats-row");
    const progressFill = widget.querySelector(".mab-progress-fill");
    const list = widget.querySelector(".mab-panel-list");

    const onReview = isReviewPage();
    if (pushDbBtn) {
      pushDbBtn.style.display = onReview ? "inline-flex" : "none";
      if (onReview) {
        pushDbBtn.classList.toggle("is-done", Boolean(reviewLearnInfo?.cloudPushed));
        if (reviewLearnInfo?.busy) {
          pushDbBtn.textContent = "ЗАГРУЗКА...";
          pushDbBtn.disabled = true;
        } else if (reviewLearnInfo?.cloudPushed) {
          pushDbBtn.textContent = "СОХРАНЕНО";
          pushDbBtn.disabled = false;
        } else {
          pushDbBtn.textContent = "В БД";
          pushDbBtn.disabled = false;
        }
      }
    }

    dot.classList.remove("mab-online", "mab-waiting", "mab-offline", "mab-kb");

    let progressPct = 0;

    if (onReview && reviewLearnInfo) {
      ribbon.textContent = reviewLearnInfo.cloudPushed ? "BAZA UPDATED" : "REVIEW MODE";
      if (reviewLearnInfo.busy) {
        dot.classList.add("mab-waiting");
        text.textContent = scanningProgress
          ? `СКАН ${scanningProgress.done}/${scanningProgress.total}`
          : "ОТПРАВКА В БД";
        progressPct = scanningProgress
          ? Math.round((scanningProgress.done / Math.max(1, scanningProgress.total)) * 100)
          : 60;
      } else if (reviewLearnInfo.hidden) {
        dot.classList.add("mab-waiting");
        text.textContent = "ОТВЕТЫ СКРЫТЫ";
        progressPct = 0;
      } else if (reviewLearnInfo.saved > 0) {
        dot.classList.add(reviewLearnInfo.cloudPushed ? "mab-kb" : "mab-waiting");
        text.textContent = reviewLearnInfo.cloudPushed
          ? `НОВЫХ +${reviewLearnInfo.added || 0} / ОБН ${reviewLearnInfo.updated || 0}`
          : `КЕШ ${reviewLearnInfo.saved}/${reviewLearnInfo.total}`;
        progressPct = 100;
      } else {
        dot.classList.add("mab-online");
        text.textContent = `НАЙДЕНО ${reviewLearnInfo.detected || 0} ОТВ.`;
        progressPct = reviewLearnInfo.total > 0
          ? Math.round(((reviewLearnInfo.detected || 0) / reviewLearnInfo.total) * 100)
          : 0;
      }
    } else {
      const total = allItems.length || localQuestions.length;
      const answered = allItems.length
        ? allItems.filter((it) => Boolean(it.answer)).length
        : localQuestions.filter((q) => Boolean(currentAnswers[q.questionId])).length;
      const kbCount = allItems.filter((it) => it.answer && it.answer.source === "kb").length;
      const pending = Math.max(0, total - answered);
      progressPct = total > 0 ? Math.round((answered / total) * 100) : 0;

      ribbon.textContent = total > 0 && answered === total ? "COMPLETE" : "QUIZ LIST";

      if (scanningProgress) {
        dot.classList.add("mab-waiting");
        text.textContent = `СКАН ${scanningProgress.done}/${scanningProgress.total}`;
      } else if (total > 0 && kbCount === total) {
        dot.classList.add("mab-kb");
        text.textContent = `БАЗА 100% (${answered}/${total})`;
      } else if (!bridgeOnline && kbCount > 0) {
        dot.classList.add("mab-kb");
        text.textContent = `БАЗА ${kbCount}/${total}`;
      } else if (!bridgeOnline) {
        dot.classList.add("mab-offline");
        text.textContent = "OFFLINE";
      } else if (total > 0 && pending > 0) {
        dot.classList.add("mab-waiting");
        text.textContent = kbCount > 0 ? `БАЗА ${kbCount} | ЖДУ ${pending}` : `ЖДУ (${answered}/${total})`;
      } else if (total > 0) {
        dot.classList.add("mab-online");
        text.textContent = `ГОТОВО (${answered}/${total})`;
      } else {
        dot.classList.add("mab-online");
        text.textContent = "НЕТ ВОПРОСОВ";
      }
    }

    progressFill.style.width = `${progressPct}%`;
    toggleBtn.classList.toggle("is-dim", !overlayVisible);
    chevron.innerHTML = panelExpanded ? SVG_CHEVRON_DOWN : SVG_CHEVRON_UP;
    panel.style.display = panelExpanded ? "flex" : "none";

    if (panelExpanded) {
      const itemsToRender = allItems.length
        ? allItems
        : localQuestions.map((q) => ({ ...q, answer: currentAnswers[q.questionId] || null }));

      if (onReview && reviewLearnInfo) {
        const pills = [];
        if (reviewLearnInfo.saved > 0) {
          pills.push(`<span class="mab-stat-pill pill-new">НОВЫХ: +${reviewLearnInfo.added || 0}</span>`);
          pills.push(`<span class="mab-stat-pill pill-upd">ОБНОВЛЕНО: ${reviewLearnInfo.updated || 0}</span>`);
          pills.push(`<span class="mab-stat-pill">ВСЕГО В БД: ${reviewLearnInfo.kbTotal || kbTotal}</span>`);
        } else {
          pills.push(`<span class="mab-stat-pill">НА СТРАНИЦЕ: ${reviewLearnInfo.detected || 0}/${reviewLearnInfo.total || 0}</span>`);
          pills.push(`<span class="mab-stat-pill">ВСЕГО В БД: ${reviewLearnInfo.kbTotal || kbTotal}</span>`);
        }
        statsRow.innerHTML = pills.join("");
      } else {
        const kbCount = itemsToRender.filter((it) => it.answer && it.answer.source === "kb").length;
        const agentCount = itemsToRender.filter((it) => it.answer && it.answer.source !== "kb").length;
        const pendingCount = itemsToRender.filter((it) => !it.answer).length;
        statsRow.innerHTML = [
          `<span class="mab-stat-pill">БД: ${kbCount}</span>`,
          `<span class="mab-stat-pill pill-new">АГЕНТ: ${agentCount}</span>`,
          `<span class="mab-stat-pill pill-wait">ЖДУТ: ${pendingCount}</span>`
        ].join("");
      }

      const localIds = new Set(localQuestions.map((q) => q.questionId));
      const panelHash = JSON.stringify(
        itemsToRender.map((it) => [
          it.questionId,
          it.qno,
          it.importStatus,
          it.answer?.source,
          it.answer?.correctIndices,
          it.answer?.textAnswer
        ])
      );
      if (panelHash !== lastPanelHash) {
        lastPanelHash = panelHash;
        if (itemsToRender.length === 0) {
          list.innerHTML = `<div class="mab-empty">${
            reviewLearnInfo?.hidden ? "На этой странице преподаватель скрыл правильные ответы" : "Нет вопросов"
          }</div>`;
        } else {
          list.innerHTML = itemsToRender
            .map((it) => {
              const isDone = Boolean(it.answer);
              const isKb = isDone && it.answer.source === "kb";
              const isCurrent = localIds.has(it.questionId);
              const ansSummary = formatAnswerSummary(it);
              const qSnippet = (it.qtext || "(без текста)").slice(0, 120);

              let statusTag = "";
              if (it.importStatus === "added") {
                statusTag = '<span class="mab-tag tag-new">NEW</span>';
              } else if (it.importStatus === "updated") {
                statusTag = '<span class="mab-tag tag-upd">UPD</span>';
              } else if (isKb) {
                statusTag = '<span class="mab-tag tag-db">DB 100%</span>';
              } else if (isDone) {
                statusTag = '<span class="mab-tag tag-ok">OK</span>';
              } else {
                statusTag = '<span class="mab-tag tag-wait">WAIT</span>';
              }

              const hereTag = isCurrent ? '<span class="mab-tag tag-here">HERE</span>' : "";

              return `
                <div class="mab-q-row ${isDone ? "is-done" : "is-pending"} ${isCurrent ? "is-current" : ""}" data-url="${escapeHtml(it.pageUrl || "")}" title="${escapeHtml(it.qtext || "")}">
                  <div class="mab-q-top">
                    <span class="mab-q-num">ВОПРОС #${escapeHtml(it.qno || "?")}</span>
                    <span class="mab-tags">${hereTag}${statusTag}</span>
                  </div>
                  <div class="mab-q-text">${escapeHtml(qSnippet)}</div>
                  <div class="mab-q-ans ${isKb ? "ans-kb" : isDone ? "ans-ready" : "ans-wait"}">${escapeHtml(ansSummary)}</div>
                </div>
              `;
            })
            .join("");
        }
      }
    }
  }

  async function pollAnswers() {
    if (scanningProgress || reviewLearnInfo) return;
    const res = await bridgeFetch("/api/answers", "GET");
    if (res && res.ok && res.data && res.data.ok) {
      const wasOffline = !bridgeOnline;
      bridgeOnline = true;
      if (wasOffline) {
        await scanAllPages(false);
        return;
      }
      const nextBridgeAnswers = res.data.answers || {};
      let changed = false;
      for (const [qid, ans] of Object.entries(nextBridgeAnswers)) {
        if (!currentAnswers[qid] || JSON.stringify(currentAnswers[qid]) !== JSON.stringify(ans)) {
          if (currentAnswers[qid]?.source !== "kb" || ans.source === "kb") {
            currentAnswers[qid] = ans;
            changed = true;
          }
        }
      }
      if (changed) {
        allItems = allItems.map((it) => ({
          ...it,
          answer: currentAnswers[it.questionId] || it.answer || null
        }));
        renderArrows();
        updateWidget();
      }
    } else if (bridgeOnline) {
      bridgeOnline = false;
      updateWidget();
    }
  }

  function start() {
    if (document.querySelectorAll("div.que").length === 0) return;

    ensureWidget();
    ensureOverlay();

    if (isReviewPage()) {
      const preview = extractReviewAnswersFromDocument(document);
      reviewLearnInfo = {
        saved: 0,
        added: 0,
        updated: 0,
        detected: preview.learned.length,
        total: preview.totalOnPage,
        kbTotal,
        hidden: preview.learned.length === 0,
        cloudPushed: false,
        busy: false
      };
      allItems = preview.learned.map((it, i) => ({
        questionId: `review-${i + 1}`,
        qno: String(i + 1),
        qtext: it.qtext,
        pageUrl: "",
        options: [],
        answer: {
          source: "kb",
          correctIndices: [],
          textAnswer: (it.correctTexts && it.correctTexts.join("; ")) || it.textAnswer || ""
        }
      }));
      syncCloudKb().then(() => {
        if (reviewLearnInfo) reviewLearnInfo.kbTotal = kbTotal;
        updateWidget();
      });
      updateWidget();
    } else {
      scanAllPages(false);
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(pollAnswers, POLL_INTERVAL_MS);
    }

    window.addEventListener("resize", scheduleReposition, { passive: true });
    window.addEventListener("scroll", scheduleReposition, { passive: true });

    window.addEventListener("keydown", (e) => {
      if (e.altKey && (e.key === "m" || e.key === "M" || e.key === "ь" || e.key === "Ь")) {
        overlayVisible = !overlayVisible;
        renderArrows();
        updateWidget();
      }
    });

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg) return;
      if (msg.type === "MAB_TOGGLE") {
        overlayVisible = !overlayVisible;
        renderArrows();
        updateWidget();
        sendResponse({ ok: true, visible: overlayVisible });
      } else if (msg.type === "MAB_PUSH_DB") {
        if (!isReviewPage()) {
          sendResponse({ ok: false, error: "Откройте страницу просмотра ответов теста (review.php)" });
          return;
        }
        runReviewAutoLearn().then((res) => sendResponse(res));
        return true;
      } else if (msg.type === "MAB_RESEND") {
        const fn = isReviewPage() ? runReviewAutoLearn() : scanAllPages(true);
        fn.then(() => sendResponse({ ok: true }));
        return true;
      }
    });
  }

  start();
})();
