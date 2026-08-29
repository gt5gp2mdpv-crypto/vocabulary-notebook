"use strict";

const DB_NAME = "vocab-pwa-db";
const DB_VERSION = 1;
const APP_SCHEMA_VERSION = 1;
const BACKUP_VERSION = 1;
const SCORE_MIN = 0.1;
const SCORE_MAX = 5;
const SCORE_DEFAULT = 1;

const state = {
  db: null,
  decks: [],
  cards: [],
  currentDeck: null,
  currentTab: "list",
  pendingImports: [],
  test: null,
  timerId: null
};

const el = {};

document.addEventListener("DOMContentLoaded", async () => {
  bindElements();
  bindEvents();
  state.db = await openDb();
  await refreshDecks();
  showInitialNotice();
  registerServiceWorker();
});

function bindElements() {
  [
    "backButton", "backupButton", "screenLabel", "screenTitle", "homeScreen", "deckScreen", "backupScreen",
    "csvInput", "updateNotice", "dismissNotice", "importPreviewPanel", "importPreviewList",
    "cancelImportButton", "confirmImportButton", "deckCount", "deckList", "deckStats", "listTab", "testTab",
    "listPanel", "testPanel", "searchInput", "sortSelect", "cardList", "testModeSelect", "startTestButton",
    "testIdle", "testRunning", "timerBar", "timerText", "testProgress", "finishTestButton", "revealButton",
    "testTerm", "answerPanel", "testMeaning", "testSummary", "exportBackupButton", "restoreInput", "toast"
  ].forEach((id) => {
    el[id] = document.getElementById(id);
  });
}

function bindEvents() {
  el.backButton.addEventListener("click", () => {
    if (screenIs("backupScreen")) showHome();
    else if (screenIs("deckScreen")) showHome();
  });
  el.backupButton.addEventListener("click", showBackup);
  el.csvInput.addEventListener("change", handleCsvSelection);
  el.cancelImportButton.addEventListener("click", clearImportPreview);
  el.confirmImportButton.addEventListener("click", confirmImports);
  el.dismissNotice.addEventListener("click", dismissNotice);
  el.listTab.addEventListener("click", () => switchTab("list"));
  el.testTab.addEventListener("click", () => switchTab("test"));
  el.searchInput.addEventListener("input", renderCards);
  el.sortSelect.addEventListener("change", renderCards);
  el.startTestButton.addEventListener("click", startTest);
  el.finishTestButton.addEventListener("click", () => finishTest("manual"));
  el.revealButton.addEventListener("click", revealAnswer);
  document.querySelectorAll(".answer-button").forEach((button) => {
    button.addEventListener("click", () => answerCurrent(button.dataset.result));
  });
  el.exportBackupButton.addEventListener("click", exportBackup);
  el.restoreInput.addEventListener("change", restoreBackup);
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("decks")) {
        const decks = db.createObjectStore("decks", { keyPath: "id" });
        decks.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains("cards")) {
        const cards = db.createObjectStore("cards", { keyPath: "id" });
        cards.createIndex("deckId", "deckId");
        cards.createIndex("deckIdTerm", ["deckId", "term"], { unique: false });
      }
      if (!db.objectStoreNames.contains("testHistory")) {
        const history = db.createObjectStore("testHistory", { keyPath: "id" });
        history.createIndex("deckId", "deckId");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(storeNames, mode = "readonly") {
  const transaction = state.db.transaction(storeNames, mode);
  return {
    transaction,
    stores: Array.isArray(storeNames)
      ? Object.fromEntries(storeNames.map((name) => [name, transaction.objectStore(name)]))
      : transaction.objectStore(storeNames)
  };
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function getAll(storeName) {
  const { stores } = tx(storeName);
  return requestToPromise(stores.getAll());
}

async function refreshDecks() {
  state.decks = (await getAll("decks")).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  await Promise.all(state.decks.map(async (deck) => {
    deck.cards = await getCardsByDeck(deck.id);
  }));
  renderDecks();
}

async function getCardsByDeck(deckId) {
  const { stores } = tx("cards");
  const cards = await requestToPromise(stores.index("deckId").getAll(deckId));
  return cards.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

async function handleCsvSelection(event) {
  const files = [...event.target.files];
  if (!files.length) return;
  try {
    state.pendingImports = [];
    for (const file of files) {
      state.pendingImports.push(await parseCsvFile(file));
    }
    renderImportPreview();
  } catch (error) {
    showToast(`CSVを読み込めませんでした: ${error.message}`);
  } finally {
    el.csvInput.value = "";
  }
}

async function parseCsvFile(file) {
  const buffer = await file.arrayBuffer();
  const decoded = decodeCsv(buffer);
  const rows = parseCsv(decoded.text);
  if (rows.length < 2) throw new Error(`${file.name}: データ行がありません`);

  const headers = rows[0].map((value) => value.trim().replace(/^\uFEFF/, ""));
  const termIndex = findHeader(headers, ["英単語", "単語", "word", "term"]);
  const meaningIndex = findHeader(headers, ["意味", "訳", "meaning", "definition"]);
  if (termIndex < 0 || meaningIndex < 0) {
    throw new Error(`${file.name}: 英単語/単語 と 意味 の列が必要です`);
  }

  const orderIndex = findHeader(headers, ["番号", "no", "number", "#"]);
  const cards = [];
  const seen = new Set();
  const duplicates = [];

  rows.slice(1).forEach((row, index) => {
    const term = cleanCell(row[termIndex]);
    const meaning = cleanCell(row[meaningIndex]);
    if (!term || !meaning) return;

    const duplicateKey = term.toLowerCase();
    if (seen.has(duplicateKey)) duplicates.push(term);
    seen.add(duplicateKey);

    const extraPairs = headers
      .map((header, i) => ({ header, value: cleanCell(row[i]) }))
      .filter(({ header, value }, i) => value && i !== termIndex && i !== meaningIndex && i !== orderIndex && header);

    cards.push({
      term,
      meaning,
      extra: extraPairs.map(({ header, value }) => `${header}: ${value}`).join("\n"),
      order: orderIndex >= 0 ? Number.parseInt(row[orderIndex], 10) || index + 1 : index + 1
    });
  });

  if (!cards.length) throw new Error(`${file.name}: 有効な単語がありません`);

  return {
    fileName: file.name,
    deckName: file.name.replace(/\.csv$/i, ""),
    encoding: decoded.encoding,
    headers,
    cards,
    duplicates: [...new Set(duplicates)]
  };
}

function decodeCsv(buffer) {
  const candidates = [
    { encoding: "UTF-8", decoder: new TextDecoder("utf-8", { fatal: false }) },
    { encoding: "Shift_JIS", decoder: new TextDecoder("shift_jis", { fatal: false }) }
  ].map((candidate) => {
    const text = candidate.decoder.decode(buffer);
    return { ...candidate, text, badness: replacementScore(text) };
  });
  candidates.sort((a, b) => a.badness - b.badness);
  return candidates[0];
}

function replacementScore(text) {
  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  const mojibakeCount = (text.match(/[�]/g) || []).length;
  const headerBonus = /英単語|単語|意味/.test(text.slice(0, 200)) ? -5 : 0;
  return replacementCount * 10 + mojibakeCount * 10 + headerBonus;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter((r) => r.some((value) => cleanCell(value)));
}

function findHeader(headers, names) {
  const normalized = headers.map((header) => header.trim().toLowerCase());
  return normalized.findIndex((header) => names.some((name) => header === name.toLowerCase()));
}

function cleanCell(value) {
  return String(value ?? "").trim();
}

function renderImportPreview() {
  el.importPreviewPanel.classList.remove("hidden");
  el.importPreviewList.innerHTML = state.pendingImports.map((item) => `
    <article class="preview-item ${item.duplicates.length ? "warning" : ""}">
      <h3>${escapeHtml(item.deckName)}</h3>
      <div class="deck-stats">
        <span class="stat-pill">${item.cards.length}語</span>
        <span class="stat-pill">${item.encoding}</span>
        <span class="stat-pill">列: ${item.headers.map(escapeHtml).join(" / ")}</span>
      </div>
      ${item.duplicates.length ? `<p class="muted">重複候補: ${item.duplicates.slice(0, 6).map(escapeHtml).join(", ")}${item.duplicates.length > 6 ? "..." : ""}</p>` : ""}
    </article>
  `).join("");
}

function clearImportPreview() {
  state.pendingImports = [];
  el.importPreviewPanel.classList.add("hidden");
  el.importPreviewList.innerHTML = "";
}

async function confirmImports() {
  if (!state.pendingImports.length) return;
  const now = new Date().toISOString();
  const { transaction, stores } = tx(["decks", "cards"], "readwrite");

  for (const item of state.pendingImports) {
    const deckId = crypto.randomUUID();
    stores.decks.put({
      id: deckId,
      name: item.deckName,
      createdAt: now,
      updatedAt: now,
      sourceFileName: item.fileName,
      schemaVersion: APP_SCHEMA_VERSION
    });
    item.cards.forEach((card) => {
      stores.cards.put({
        id: crypto.randomUUID(),
        deckId,
        term: card.term,
        meaning: card.meaning,
        extra: card.extra,
        order: card.order,
        score: SCORE_DEFAULT,
        testedCount: 0,
        createdAt: now,
        updatedAt: now
      });
    });
  }

  await transactionDone(transaction);
  const count = state.pendingImports.length;
  clearImportPreview();
  await refreshDecks();
  showToast(`${count}件の単語帳を保存しました`);
}

function renderDecks() {
  el.deckCount.textContent = `${state.decks.length}件`;
  if (!state.decks.length) {
    el.deckList.className = "deck-grid empty-state";
    el.deckList.textContent = "まだ単語帳がありません。";
    return;
  }
  el.deckList.className = "deck-grid";
  el.deckList.innerHTML = state.decks.map((deck) => {
    const stats = deckSummary(deck.cards);
    return `
      <article class="deck-card">
        <h3>${escapeHtml(deck.name)}</h3>
        <div class="deck-stats">
          <span class="stat-pill">${deck.cards.length}語</span>
          <span class="stat-pill">平均 ${stats.average}</span>
          <span class="stat-pill">低スコア ${stats.lowCount}</span>
        </div>
        <div class="deck-actions">
          <button class="primary-button" type="button" data-open-deck="${deck.id}" data-tab="list">一覧</button>
          <button class="ghost-button" type="button" data-open-deck="${deck.id}" data-tab="test">テスト</button>
        </div>
      </article>
    `;
  }).join("");
  el.deckList.querySelectorAll("[data-open-deck]").forEach((button) => {
    button.addEventListener("click", () => openDeck(button.dataset.openDeck, button.dataset.tab));
  });
}

function deckSummary(cards) {
  if (!cards.length) return { average: "0.00", lowCount: 0 };
  const total = cards.reduce((sum, card) => sum + Number(card.score || SCORE_DEFAULT), 0);
  const lowCount = cards.filter((card) => Number(card.score || SCORE_DEFAULT) < 1).length;
  return { average: (total / cards.length).toFixed(2), lowCount };
}

async function openDeck(deckId, tab = "list") {
  const deck = state.decks.find((item) => item.id === deckId);
  if (!deck) return;
  state.currentDeck = { ...deck, cards: await getCardsByDeck(deck.id) };
  showScreen("deckScreen", "Deck", state.currentDeck.name);
  renderDeckStats();
  switchTab(tab);
  renderCards();
}

function renderDeckStats() {
  const stats = deckSummary(state.currentDeck.cards);
  el.deckStats.innerHTML = `
    <span class="stat-pill">${state.currentDeck.cards.length}語</span>
    <span class="stat-pill">平均スコア ${stats.average}</span>
    <span class="stat-pill">低スコア ${stats.lowCount}</span>
  `;
}

function switchTab(tab) {
  state.currentTab = tab;
  el.listTab.classList.toggle("active", tab === "list");
  el.testTab.classList.toggle("active", tab === "test");
  el.listPanel.classList.toggle("active", tab === "list");
  el.testPanel.classList.toggle("active", tab === "test");
  if (tab === "test") resetTestView();
}

function renderCards() {
  if (!state.currentDeck) return;
  const query = el.searchInput.value.trim().toLowerCase();
  let cards = [...state.currentDeck.cards];
  if (query) {
    cards = cards.filter((card) =>
      `${card.term} ${card.meaning} ${card.extra || ""}`.toLowerCase().includes(query)
    );
  }
  const sort = el.sortSelect.value;
  cards.sort((a, b) => {
    if (sort === "scoreAsc") return a.score - b.score;
    if (sort === "scoreDesc") return b.score - a.score;
    if (sort === "term") return a.term.localeCompare(b.term);
    return (a.order ?? 0) - (b.order ?? 0);
  });

  if (!cards.length) {
    el.cardList.className = "word-grid empty-state";
    el.cardList.textContent = "表示できる単語がありません。";
    return;
  }
  el.cardList.className = "word-grid";
  el.cardList.innerHTML = cards.map((card) => `
    <button class="word-card" type="button" data-card-id="${card.id}" aria-label="${escapeHtml(card.term)}">
      <span class="word-card-inner">
        <span class="term">${escapeHtml(card.term)}</span>
        <span class="meaning hidden">${escapeHtml(card.meaning)}</span>
        ${card.extra ? `<span class="extra hidden">${escapeHtml(card.extra)}</span>` : ""}
        <span class="score">Score ${Number(card.score).toFixed(2)}</span>
      </span>
    </button>
  `).join("");
  el.cardList.querySelectorAll(".word-card").forEach((button) => {
    button.addEventListener("click", () => {
      button.querySelectorAll(".meaning, .extra").forEach((node) => node.classList.toggle("hidden"));
    });
  });
}

function resetTestView() {
  stopTimer();
  state.test = null;
  el.testIdle.classList.remove("hidden");
  el.testRunning.classList.add("hidden");
  el.testSummary.classList.add("hidden");
  el.answerPanel.classList.add("hidden");
}

function startTest() {
  if (!state.currentDeck?.cards.length) {
    showToast("テストできる単語がありません");
    return;
  }
  let cards = [...state.currentDeck.cards];
  const mode = el.testModeSelect.value;
  if (mode === "low") {
    cards.sort((a, b) => a.score - b.score);
  } else if (mode === "untested") {
    cards.sort((a, b) => (a.testedCount || 0) - (b.testedCount || 0));
  } else {
    cards = shuffle(cards);
  }

  state.test = {
    deckId: state.currentDeck.id,
    startedAt: new Date().toISOString(),
    cards,
    index: 0,
    results: [],
    currentStartedAt: 0,
    revealed: false
  };
  el.testIdle.classList.add("hidden");
  el.testSummary.classList.add("hidden");
  el.testRunning.classList.remove("hidden");
  showCurrentQuestion();
}

function showCurrentQuestion() {
  const current = currentTestCard();
  if (!current) {
    finishTest("completed");
    return;
  }
  state.test.currentStartedAt = performance.now();
  state.test.revealed = false;
  el.testProgress.textContent = `${state.test.index + 1} / ${state.test.cards.length}`;
  el.testTerm.textContent = current.term;
  el.testMeaning.textContent = current.meaning;
  el.answerPanel.classList.add("hidden");
  startTimer();
}

function currentTestCard() {
  return state.test?.cards[state.test.index];
}

function revealAnswer() {
  if (!state.test) return;
  state.test.revealed = true;
  el.answerPanel.classList.remove("hidden");
}

async function answerCurrent(result) {
  const card = currentTestCard();
  if (!card) return;
  const elapsedSeconds = (performance.now() - state.test.currentStartedAt) / 1000;
  const change = scoreChange(result, elapsedSeconds);
  const newScore = clampScore(Number(card.score || SCORE_DEFAULT) + change);
  const updated = {
    ...card,
    score: newScore,
    testedCount: (card.testedCount || 0) + 1,
    updatedAt: new Date().toISOString()
  };

  await putRecord("cards", updated);
  state.currentDeck.cards = state.currentDeck.cards.map((item) => item.id === updated.id ? updated : item);
  state.test.cards[state.test.index] = updated;
  state.test.results.push({
    cardId: card.id,
    term: card.term,
    meaning: card.meaning,
    result,
    elapsedSeconds: Number(elapsedSeconds.toFixed(2)),
    scoreBefore: Number(card.score || SCORE_DEFAULT),
    scoreAfter: newScore,
    scoreDelta: Number(change.toFixed(2))
  });

  state.test.index += 1;
  renderDeckStats();
  renderCards();
  showCurrentQuestion();
}

function scoreChange(result, elapsedSeconds) {
  const base = { known: 0.1, partial: -0.05, unknown: -0.1 }[result] ?? 0;
  let multiplier = 1;
  if (elapsedSeconds <= 5) {
    multiplier = 2;
  } else if (elapsedSeconds > 15 && result !== "known") {
    multiplier = 2;
  }
  return base * multiplier;
}

function clampScore(score) {
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, Number(score.toFixed(2))));
}

function startTimer() {
  stopTimer();
  tickTimer();
  state.timerId = window.setInterval(tickTimer, 100);
}

function stopTimer() {
  if (state.timerId) {
    clearInterval(state.timerId);
    state.timerId = null;
  }
}

function tickTimer() {
  if (!state.test) return;
  const elapsed = (performance.now() - state.test.currentStartedAt) / 1000;
  const remaining = Math.max(0, 15 - elapsed);
  const scale = Math.max(0, remaining / 15);
  el.timerBar.style.transform = `scaleX(${scale})`;
  el.timerText.textContent = elapsed <= 15
    ? `残り ${remaining.toFixed(1)}秒`
    : `15秒超過 ${elapsed.toFixed(1)}秒`;
  el.timerText.classList.toggle("warning", elapsed > 15);
  if (elapsed >= 30) finishTest("timeout");
}

async function finishTest(reason) {
  if (!state.test) return;
  const finished = state.test;
  stopTimer();
  const history = {
    id: crypto.randomUUID(),
    deckId: finished.deckId,
    startedAt: finished.startedAt,
    endedAt: new Date().toISOString(),
    results: finished.results,
    forcedEndReason: reason === "timeout" ? "30秒超過" : ""
  };
  await putRecord("testHistory", history);
  state.test = null;
  el.testRunning.classList.add("hidden");
  el.testIdle.classList.add("hidden");
  renderTestSummary(finished.results, reason);
}

function renderTestSummary(results, reason) {
  const partial = results.filter((item) => item.result === "partial");
  const unknown = results.filter((item) => item.result === "unknown");
  el.testSummary.classList.remove("hidden");
  el.testSummary.innerHTML = `
    <h3>テスト結果</h3>
    <div class="deck-stats">
      <span class="stat-pill">回答 ${results.length}語</span>
      <span class="stat-pill">${reason === "timeout" ? "30秒超過で終了" : reason === "completed" ? "完了" : "手動終了"}</span>
    </div>
    <div class="summary-grid">
      ${summaryList("一部だけわかった", partial)}
      ${summaryList("わからなかった", unknown)}
    </div>
  `;
}

function summaryList(title, items) {
  return `
    <section class="summary-card">
      <h4>${title} (${items.length})</h4>
      ${items.length ? `<ul>${items.map((item) => `<li><strong>${escapeHtml(item.term)}</strong>: ${escapeHtml(item.meaning)} <span class="muted">${item.scoreBefore.toFixed(2)} → ${item.scoreAfter.toFixed(2)}</span></li>`).join("")}</ul>` : `<p class="muted">該当なし</p>`}
    </section>
  `;
}

async function putRecord(storeName, value) {
  const { transaction, stores } = tx(storeName, "readwrite");
  stores.put(value);
  await transactionDone(transaction);
}

async function exportBackup() {
  const backup = {
    backupVersion: BACKUP_VERSION,
    appSchemaVersion: APP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    decks: await getAll("decks"),
    cards: await getAll("cards"),
    testHistory: await getAll("testHistory")
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `vocab-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("バックアップを書き出しました");
}

async function restoreBackup(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const backup = migrateBackup(JSON.parse(await file.text()));
    await importBackup(backup);
    await refreshDecks();
    showHome();
    showToast("バックアップを復元しました");
  } catch (error) {
    showToast(`復元できませんでした: ${error.message}`);
  } finally {
    el.restoreInput.value = "";
  }
}

function migrateBackup(backup) {
  if (!backup || typeof backup !== "object") throw new Error("JSON形式が不正です");
  if (!backup.backupVersion) throw new Error("バックアップバージョンがありません");
  if (backup.backupVersion > BACKUP_VERSION) {
    throw new Error("このアプリより新しいバックアップです。アプリを更新してください");
  }
  return {
    backupVersion: BACKUP_VERSION,
    appSchemaVersion: APP_SCHEMA_VERSION,
    decks: Array.isArray(backup.decks) ? backup.decks : [],
    cards: Array.isArray(backup.cards) ? backup.cards : [],
    testHistory: Array.isArray(backup.testHistory) ? backup.testHistory : []
  };
}

async function importBackup(backup) {
  const now = new Date().toISOString();
  const { transaction, stores } = tx(["decks", "cards", "testHistory"], "readwrite");
  backup.decks.forEach((deck) => stores.decks.put({
    id: deck.id || crypto.randomUUID(),
    name: deck.name || "復元した単語帳",
    createdAt: deck.createdAt || now,
    updatedAt: now,
    sourceFileName: deck.sourceFileName || "backup.json",
    schemaVersion: APP_SCHEMA_VERSION
  }));
  backup.cards.forEach((card, index) => {
    if (!card.deckId || !card.term || !card.meaning) return;
    stores.cards.put({
      id: card.id || crypto.randomUUID(),
      deckId: card.deckId,
      term: card.term,
      meaning: card.meaning,
      extra: card.extra || "",
      order: card.order ?? index + 1,
      score: clampScore(Number(card.score || SCORE_DEFAULT)),
      testedCount: card.testedCount || 0,
      createdAt: card.createdAt || now,
      updatedAt: now
    });
  });
  backup.testHistory.forEach((history) => stores.testHistory.put({
    id: history.id || crypto.randomUUID(),
    deckId: history.deckId,
    startedAt: history.startedAt || now,
    endedAt: history.endedAt || now,
    results: Array.isArray(history.results) ? history.results : [],
    forcedEndReason: history.forcedEndReason || ""
  }));
  await transactionDone(transaction);
}

function showHome() {
  stopTimer();
  state.currentDeck = null;
  showScreen("homeScreen", "Library", "単語帳");
  refreshDecks();
}

function showBackup() {
  stopTimer();
  showScreen("backupScreen", "Backup", "バックアップ");
}

function showScreen(screenId, label, title) {
  document.querySelectorAll(".screen").forEach((screen) => screen.classList.remove("active"));
  el[screenId].classList.add("active");
  el.screenLabel.textContent = label;
  el.screenTitle.textContent = title;
  el.backButton.classList.toggle("hidden", screenId === "homeScreen");
}

function screenIs(screenId) {
  return el[screenId].classList.contains("active");
}

function showInitialNotice() {
  const dismissedVersion = localStorage.getItem("backupNoticeDismissedFor");
  if (dismissedVersion === String(APP_SCHEMA_VERSION)) {
    el.updateNotice.classList.add("hidden");
  }
}

function dismissNotice() {
  localStorage.setItem("backupNoticeDismissedFor", String(APP_SCHEMA_VERSION));
  el.updateNotice.classList.add("hidden");
}

function showToast(message) {
  el.toast.textContent = message;
  el.toast.classList.remove("hidden");
  window.clearTimeout(showToast.timeoutId);
  showToast.timeoutId = window.setTimeout(() => el.toast.classList.add("hidden"), 3200);
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
    .replaceAll("\n", "<br>");
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      showToast("オフライン機能の登録に失敗しました");
    });
  }
}
