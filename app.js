/* =========================================================================
 * 単語帳 PWA - アプリケーション本体
 * ========================================================================= */
"use strict";

/* -------------------------------------------------------------------------
 * 定数
 * ------------------------------------------------------------------------- */
const APP_NAME = "単語帳";
const APP_VERSION = "1.0.0";
const BACKUP_VERSION = 2; // バックアップ形式のバージョン（アップデート対応）

const DB_NAME = "vocab-pwa-db";
const DB_VERSION = 1;
const STORE_DECKS = "decks";
const STORE_WORDS = "words";
const STORE_META = "meta";
const STORE_TESTS = "tests";

// 暗記スコア設定
const SCORE_MIN = 0.10;
const SCORE_MAX = 5.00;
const SCORE_INIT = 1.0;

// テストタイマー（秒）
const TIME_OPEN_LIMIT = 15; // 1単語の開放制限時間
const TIME_FORCE_QUIT = 30; // これを超えたらテスト自体を強制終了

const ENC_UTF8 = "utf-8";
const ENC_SHIFT_JIS = "shift-jis";

/* -------------------------------------------------------------------------
 * ユーティリティ
 * ------------------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

function uid() {
  return "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function showToast(msg, duration = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.add("hidden"), duration);
}

/* -------------------------------------------------------------------------
 * IndexedDB データ層
 * ------------------------------------------------------------------------- */
const db = {
  _conn: null,

  open() {
    if (this._conn) return Promise.resolve(this._conn);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(STORE_DECKS)) {
          d.createObjectStore(STORE_DECKS, { keyPath: "id" });
        }
        if (!d.objectStoreNames.contains(STORE_WORDS)) {
          const s = d.createObjectStore(STORE_WORDS, { keyPath: "id", autoIncrement: true });
          s.createIndex("deckId", "deckId", { unique: false });
        }
        if (!d.objectStoreNames.contains(STORE_META)) {
          d.createObjectStore(STORE_META, { keyPath: "key" });
        }
        if (!d.objectStoreNames.contains(STORE_TESTS)) {
          const s = d.createObjectStore(STORE_TESTS, { keyPath: "id", autoIncrement: true });
          s.createIndex("deckId", "deckId", { unique: false });
          s.createIndex("date", "date", { unique: false });
        }
      };
      req.onsuccess = () => {
        this._conn = req.result;
        resolve(this._conn);
      };
      req.onerror = () => reject(req.error);
    });
  },

  getAll(store) {
    return this.open().then((conn) =>
      new Promise((res, rej) => {
        const tx = conn.transaction(store, "readonly");
        const r = tx.objectStore(store).getAll();
        r.onerror = () => rej(r.error);
        r.onsuccess = () => res(r.result);
      })
    );
  },

  getAllByIndex(store, indexName, value) {
    return this.open().then((conn) =>
      new Promise((res, rej) => {
        const tx = conn.transaction(store, "readonly");
        const r = tx.objectStore(store).index(indexName).getAll(IDBKeyRange.only(value));
        r.onerror = () => rej(r.error);
        r.onsuccess = () => res(r.result);
      })
    );
  },

  get(store, key) {
    return this.open().then((conn) =>
      new Promise((res, rej) => {
        const tx = conn.transaction(store, "readonly");
        const r = tx.objectStore(store).get(key);
        r.onerror = () => rej(r.error);
        r.onsuccess = () => res(r.result);
      })
    );
  },

  put(store, value) {
    return this.open().then((conn) =>
      new Promise((res, rej) => {
        const tx = conn.transaction(store, "readwrite");
        const r = tx.objectStore(store).put(value);
        r.onerror = () => rej(r.error);
        r.onsuccess = () => res(r.result);
      })
    );
  },

  del(store, key) {
    return this.open().then((conn) =>
      new Promise((res, rej) => {
        const tx = conn.transaction(store, "readwrite");
        tx.objectStore(store).delete(key);
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      })
    );
  },

  delByIndex(store, indexName, value) {
    return this.open().then((conn) =>
      new Promise((res, rej) => {
        const tx = conn.transaction(store, "readwrite");
        const storeObj = tx.objectStore(store);
        const keysReq = storeObj.index(indexName).getAllKeys(IDBKeyRange.only(value));
        keysReq.onsuccess = () => {
          keysReq.result.forEach((k) => storeObj.delete(k));
        };
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      })
    );
  },
};

/* -------------------------------------------------------------------------
 * アプリ状態
 * ------------------------------------------------------------------------- */
const App = {
  decks: [],           // 単語帳一覧
  currentDeck: null,   // 表示中の単語帳
  currentWords: [],    // 表示中の単語帳の単語
  cachedWords: {},     // deckId -> words（テスト中の一時取得用にも）
  sortMode: "order",
};

/* -------------------------------------------------------------------------
 * 画面遷移
 * ------------------------------------------------------------------------- */
const SCREENS = { home: "homeScreen", deck: "deckScreen", backup: "backupScreen" };

function showScreen(name) {
  Object.values(SCREENS).forEach((id) => $(id).classList.remove("active"));
  $(SCREENS[name]).classList.add("active");

  const label = $("screenLabel");
  const title = $("screenTitle");
  if (name === "home") {
    label.textContent = "Library";
    title.textContent = APP_NAME;
    $("openMenuButton").classList.remove("hidden");
  } else if (name === "deck") {
    label.textContent = "単語帳";
    title.textContent = App.currentDeck ? App.currentDeck.name : "";
    $("openMenuButton").classList.remove("hidden");
  } else if (name === "backup") {
    label.textContent = "設定";
    title.textContent = "バックアップ / 設定";
    $("openMenuButton").classList.remove("hidden");
  }
  window.scrollTo(0, 0);
}

function closeMenu(force = false) {
  $("menuBackdrop").classList.add("hidden");
  $("drawer").classList.remove("open");
  if (force) document.body.style.overflow = "";
}

function openMenu() {
  $("menuBackdrop").classList.remove("hidden");
  $("drawer").classList.add("open");
  document.body.style.overflow = "hidden";
}

/* -------------------------------------------------------------------------
 * ホーム（単語帳一覧）
 * ------------------------------------------------------------------------- */
async function loadDecks() {
  App.decks = await db.getAll(STORE_DECKS);
  App.decks.sort((a, b) => (a.order || 0) - (b.order || 0));
  renderDeckList();
}

function renderDeckList() {
  const list = $("deckList");
  $("deckCount").textContent = App.decks.length + "件";
  if (App.decks.length === 0) {
    list.className = "deck-grid empty-state";
    list.textContent = "まだ単語帳がありません。「CSVを追加」から読み込んでください。";
    return;
  }
  list.className = "deck-grid";
  list.innerHTML = App.decks.map((deck) => {
    const avg = deck.avgScore != null ? Number(deck.avgScore).toFixed(2) : "-";
    const wc = deck.wordCount != null ? deck.wordCount : "-";
    return `
      <div class="deck-card" data-id="${esc(deck.id)}">
        <div class="deck-main">
          <button class="deck-open" type="button">${esc(deck.name)}
            <span class="deck-count">${esc(wc)}単語</span>
          </button>
          <div class="deck-actions">
            <button class="mini-button" data-act="rename" type="button">名前変更</button>
            <button class="mini-button danger" data-act="delete" type="button">削除</button>
          </div>
        </div>
        <div class="deck-meta">平均スコア ${avg}</div>
      </div>`;
  }).join("");
}

function bindDeckList() {
  $("deckList").addEventListener("click", (e) => {
    const card = e.target.closest(".deck-card");
    if (!card) return;
    const deckId = card.dataset.id;
    const btn = e.target.closest("button");
    if (btn) {
      const act = btn.dataset.act;
      if (act === "rename") return renameDeck(deckId);
      if (act === "delete") return deleteDeck(deckId);
      if (btn.classList.contains("deck-open")) return openDeck(deckId);
      return;
    }
    openDeck(deckId);
  });
}

async function openDeck(deckId) {
  const deck = App.decks.find((d) => String(d.id) === String(deckId));
  if (!deck) return;
  App.currentDeck = deck;
  App.currentWords = await db.getAllByIndex(STORE_WORDS, "deckId", deck.id);
  showScreen("deck");
  renderDeckStats();
  renderWordList();
}

async function renameDeck(deckId) {
  const deck = App.decks.find((d) => String(d.id) === String(deckId));
  if (!deck) return;
  const name = prompt("新しい単語帳名を入力してください", deck.name);
  if (name == null || name.trim() === "") return;
  deck.name = name.trim();
  await db.put(STORE_DECKS, deck);
  loadDecks();
  showToast("名前を変更しました");
}

async function deleteDeck(deckId) {
  if (!confirm("この単語帳と、含まれる単語をすべて削除しますか？")) return;
  const deck = App.decks.find((d) => String(d.id) === String(deckId));
  const realId = deck ? deck.id : deckId;
  await db.del(STORE_DECKS, realId);
  await db.delByIndex(STORE_WORDS, "deckId", realId);
  await db.delByIndex(STORE_TESTS, "deckId", realId);
  delete App.cachedWords[String(realId)];
  loadDecks();
  showToast("単語帳を削除しました");
}

/* -------------------------------------------------------------------------
 * CSV インポート
 * ------------------------------------------------------------------------- */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = false;
      } else cur += c;
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ",") {
      row.push(cur); cur = "";
    } else if (c === "\n") {
      row.push(cur); cur = ""; rows.push(row); row = [];
    } else if (c === "\r") {
      // 無視
    } else {
      cur += c;
    }
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function decodeBuffer(buffer) {
  // BOM付きUTF-8
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(buffer.subarray(3));
  }
  // まずUTF-8でフォールトレスデコード（無効バイトはU+FFFDへ）
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  // U+FFFD(=不正バイト)が含まれないならそのままUTF-8
  if (utf8.indexOf("\uFFFD") === -1) return utf8;
  // 不正バイトあり → Shift_JISとして再デコード
  try {
    return new TextDecoder(ENC_SHIFT_JIS).decode(buffer);
  } catch (e) {
    return utf8;
  }
}

let pendingImports = [];

function handleCsvFiles(files) {
  if (!files || files.length === 0) return;
  closeMenu(true);
  const reads = Array.from(files).map((file) =>
    file.arrayBuffer().then((buf) => decodeBuffer(new Uint8Array(buf)))
  );
  Promise.all(reads).then((texts) => {
    const result = [];
    files.forEach((file, idx) => {
      const rows = parseCSV(texts[idx]);
      const name = file.name.replace(/\.csv$/i, "") || "単語帳";
      const terms = [];
      let started = false;
      rows.forEach((r) => {
        const term = (r[0] || "").trim();
        const meaning = (r[1] || "").trim();
        if (!term) return;
        if (!started && /^(term|word|単語|vocab|表|表1)$/i.test(term)) { started = true; return; }
        started = true;
        terms.push({ term, meaning });
      });
      if (terms.length) result.push({ deckName: name, terms });
    });
    if (result.length === 0) { showToast("読み込める単語がありません"); return; }
    pendingImports = result;
    showScreen("home");
    renderImportPreview();
    $("importPreviewPanel").classList.remove("hidden");
    $("importPreviewPanel").scrollIntoView({ behavior: "smooth", block: "start" });
  }).catch((e) => {
    console.error("CSV読み込みエラー:", e);
    showToast("CSVの読み込みに失敗しました: " + (e && e.message ? e.message : e));
  });
}

function renderImportPreview() {
  const list = $("importPreviewList");
  list.innerHTML = pendingImports.map((imp) => `
    <div class="preview-card">
      <div class="section-head">
        <strong>${esc(imp.deckName)}</strong>
        <span class="muted">${imp.terms.length}語</span>
      </div>
      <div class="preview-samples">
        ${imp.terms.slice(0, 4).map((t) => `<div><b>${esc(t.term)}</b> — ${esc(t.meaning)}</div>`).join("")}
        ${imp.terms.length > 4 ? `<div class="muted">...ほか ${imp.terms.length - 4}語</div>` : ""}
      </div>
    </div>`).join("");
}

async function confirmImport() {
  try {
    for (const imp of pendingImports) {
      const deckId = uid();
      const deck = { id: deckId, name: imp.deckName, order: Date.now(), wordCount: imp.terms.length, avgScore: SCORE_INIT };
      await db.put(STORE_DECKS, deck);
      for (const t of imp.terms) {
        await db.put(STORE_WORDS, { deckId, term: t.term, meaning: t.meaning, score: SCORE_INIT, tested: false });
      }
    }
    const total = pendingImports.reduce((s, x) => s + x.terms.length, 0);
    pendingImports = [];
    $("importPreviewPanel").classList.add("hidden");
    $("csvInput").value = "";
    await loadDecks();
    showToast(total + "語をインポートしました");
  } catch (e) {
    console.error("インポート保存エラー:", e);
    showToast("保存に失敗しました: " + (e && e.message ? e.message : e));
  }
}

/* -------------------------------------------------------------------------
 * 単語一覧（カードUI）
 * ------------------------------------------------------------------------- */
function filteredWords() {
  const q = ($("searchInput").value || "").trim().toLowerCase();
  let words = App.currentWords;
  if (q) {
    words = words.filter((w) =>
      (w.term || "").toLowerCase().includes(q) || (w.meaning || "").toLowerCase().includes(q)
    );
  }
  if (App.sortMode === "scoreAsc") words = words.slice().sort((a, b) => (a.score||0) - (b.score||0));
  else if (App.sortMode === "scoreDesc") words = words.slice().sort((a, b) => (b.score||0) - (a.score||0));
  else if (App.sortMode === "term") words = words.slice().sort((a, b) => String(a.term).localeCompare(String(b.term)));
  return words;
}

function renderWordList() {
  const list = $("cardList");
  const words = filteredWords();
  if (words.length === 0) {
    list.className = "word-grid empty-state";
    list.innerHTML = "<div>条件に一致する単語がありません</div>";
    return;
  }
  list.className = "word-grid";
  list.innerHTML = words.map((w, i) => `
    <div class="flip-card" data-id="${w.id}">
      <div class="flip-inner">
        <button class="flip-face flip-front" type="button">
          <span class="flip-index">#${i + 1}</span>
          <span class="flip-term">${esc(w.term)}</span>
          <span class="flip-score">score ${(w.score||SCORE_INIT).toFixed(2)}</span>
        </button>
        <div class="flip-face flip-back">
          <span class="flip-meaning">${w.meaning ? esc(w.meaning) : "<i>（意味なし）</i>"}</span>
          <button class="mini-button" data-act="edit" type="button">編集</button>
        </div>
      </div>
    </div>`).join("");
}

function bindWordList() {
  $("cardList").addEventListener("click", (e) => {
    const card = e.target.closest(".flip-card");
    if (!card) return;
    const editBtn = e.target.closest('[data-act="edit"]');
    if (editBtn) return addNewWord(card.dataset.id);
    card.classList.toggle("flipped");
  });
  $("searchInput").addEventListener("input", renderWordList);
  $("sortSelect").addEventListener("change", (e) => {
    App.sortMode = e.target.value;
    renderWordList();
  });
}

async function addNewWord(wordId) {
  if (wordId) {
    const w = App.currentWords.find((x) => String(x.id) === String(wordId));
    if (!w) return;
    const term = prompt("用語を編集", w.term);
    if (term == null) return;
    const meaning = prompt("意味を編集", w.meaning);
    if (meaning == null) return;
    w.term = term.trim();
    w.meaning = meaning.trim();
    await db.put(STORE_WORDS, w);
    App.currentWords = await db.getAllByIndex(STORE_WORDS, "deckId", App.currentDeck.id);
    renderWordList();
    showToast("編集しました");
  }
}

function renderDeckStats() {
  const stats = $("deckStats");
  const words = App.currentWords;
  const avg = words.length
    ? (words.reduce((s, w) => s + (w.score || SCORE_INIT), 0) / words.length).toFixed(2)
    : "-";
  stats.innerHTML = `
    <div class="stat"><b>${words.length}</b><span>単語数</span></div>
    <div class="stat"><b>${avg}</b><span>平均スコア</span></div>`;
}

/* -------------------------------------------------------------------------
 * バックアップ / 復元
 * ------------------------------------------------------------------------- */
async function exportBackup() {
  const decks = await db.getAll(STORE_DECKS);
  const words = await db.getAll(STORE_WORDS);
  const tests = await db.getAll(STORE_TESTS);
  const payload = {
    app: "vocab-pwa",
    backupVersion: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    decks,
    words,
    tests,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `単語帳_backup_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("JSONバックアップを書き出しました");
}

async function restoreBackup(file) {
  if (!file) return;
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { showToast("JSONとして読み込めません"); return; }

  // バージョンチェック（アップデート対応）
  if (data.app !== "vocab-pwa") { showToast("このアプリのバックアップではありません"); return; }
  const v = Number(data.backupVersion || 0);
  if (v > BACKUP_VERSION) { showToast("新しいバージョンのバックアップです"); return; }

  if (!confirm("現在のデータをすべて置き換えて復元します。よろしいですか？")) { return; }

  for (const store of [STORE_DECKS, STORE_WORDS, STORE_TESTS]) {
    const conn = await db.open();
    await new Promise((res, rej) => {
      const tx = conn.transaction(store, "readwrite");
      tx.objectStore(store).clear();
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
  }
  const decks = data.decks || [];
  const words = data.words || [];
  const tests = data.tests || [];
  for (const item of decks) await db.put(STORE_DECKS, item);
  for (const item of words) await db.put(STORE_WORDS, item);
  for (const item of tests) await db.put(STORE_TESTS, item);

  await loadDecks();
  showToast(`復元しました（単語帳${decks.length}件 / 単語${words.length}語）`);
}

/* -------------------------------------------------------------------------
 * 単語テスト
 * ------------------------------------------------------------------------- */
const Test = {
  running: false,
  seq: [],          // 出題オブジェクト列 { word, elapsed }
  index: 0,
  revealed: false,
  startTime: 0,
  timerId: null,
  results: [],      // { wordId, result, elapsed }
  partialList: [],
  unknownList: [],
  filter: "all",
};

function buildTestSequence() {
  const seq = App.currentWords.slice();
  switch (Test.filter) {
    case "low":
      seq.sort((a, b) => (a.score || SCORE_INIT) - (b.score || SCORE_INIT));
      break;
    case "untested":
      seq.sort((a, b) => {
        const au = a.tested ? 1 : 0;
        const bu = b.tested ? 1 : 0;
        return au - bu;
      });
      break;
    default:
      break;
  }
  Test.seq = seq.map((w) => ({ word: JSON.parse(JSON.stringify(w)), elapsed: 0 }));
}

function startTest() {
  Test.filter = $("testModeSelect").value;
  if (!App.currentWords.length) { showToast("単語がありません"); return; }
  Test.running = true;
  Test.index = 0;
  Test.results = [];
  Test.partialList = [];
  Test.unknownList = [];
  buildTestSequence();

  $("testIdle").classList.add("hidden");
  $("testRunning").classList.remove("hidden");
  $("testSummary").classList.add("hidden");
  renderTestQuestion();
}

function renderTestQuestion() {
  const item = Test.seq[Test.index];
  if (!item) { finishTest(false); return; }
  Test.revealed = false;
  $("testProgress").textContent = `${Test.index + 1} / ${Test.seq.length}`;
  $("testTerm").textContent = item.word.term;
  $("testMeaning").textContent = item.word.meaning || "（意味なし）";
  $("answerPanel").classList.add("hidden");
  $("revealButton").disabled = false;
  Test.startTime = performance.now();
  startTimer();
}

function startTimer() {
  cancelAnimationFrame(Test.timerId);
  const start = Test.startTime;
  const bar = $("timerBar");
  const text = $("timerText");

  const tick = (now) => {
    const elapsed = (now - start) / 1000;
    Test.seq[Test.index].elapsed = elapsed;

    if (elapsed >= TIME_FORCE_QUIT) { finishTest(true); return; }

    const remain = Math.max(0, TIME_OPEN_LIMIT - elapsed);
    const pct = clamp(remain / TIME_OPEN_LIMIT, 0, 1);
    bar.style.transform = "scaleX(" + pct + ")";
    text.textContent = remain.toFixed(1) + "秒";
    text.classList.toggle("warning", remain <= 10);

    if (remain <= 10 && !Test.revealed) revealAnswer();

    Test.timerId = requestAnimationFrame(tick);
  };
  Test.timerId = requestAnimationFrame(tick);
}

function stopTimer() {
  if (Test.timerId) { cancelAnimationFrame(Test.timerId); Test.timerId = null; }
}

function revealAnswer() {
  if (Test.revealed) return;
  Test.revealed = true;
  $("answerPanel").classList.remove("hidden");
}

/* -------------------------------------------------------------------------
 * 回答処理・スコア・終了・結果表示
 * ------------------------------------------------------------------------- */
function onAnswer(result) {
  if (!Test.running || !Test.revealed) return;
  const item = Test.seq[Test.index];
  const elapsed = item.elapsed;
  Test.results.push({ wordId: item.word.id, result, elapsed });

  if (result === "partial") Test.partialList.push(item.word);
  else if (result === "unknown") Test.unknownList.push(item.word);

  applyScore(item.word, result, elapsed);

  stopTimer();
  $("answerPanel").classList.add("hidden");
  $("revealButton").disabled = true;

  Test.index++;
  if (Test.index < Test.seq.length) {
    renderTestQuestion();
  } else {
    finishTest(false);
  }
}

/* スコア変動
 * base: known +0.10 / partial -0.05 / unknown -0.10
 * 0~5秒: 一律2倍 / 5~15秒: 通常 / 15秒以上: known通常、partial・unknown2倍
 */
function applyScore(word, result, elapsed) {
  const base = result === "known" ? 0.10 : result === "partial" ? -0.05 : -0.10;
  let factor = 1;
  if (elapsed <= 5) factor = 2;
  else if (elapsed > TIME_OPEN_LIMIT && result !== "known") factor = 2;
  const delta = base * factor;
  word.score = round2(clamp(round2((word.score || SCORE_INIT) + delta), SCORE_MIN, SCORE_MAX));
  word.tested = true;
  db.put(STORE_WORDS, word); // fire-and-forget
}

function finishTest(forced) {
  stopTimer();
  const wasRunning = Test.running;
  Test.running = false;
  $("testRunning").classList.add("hidden");
  if (!wasRunning) return;

  // 強制終了時、未回答の現項目があれば「わからなかった」として保存
  if (forced && Test.index < Test.seq.length && Test.revealed) {
    const item = Test.seq[Test.index];
    applyScore(item.word, "unknown", TIME_FORCE_QUIT);
    Test.results.push({ wordId: item.word.id, result: "unknown", elapsed: TIME_FORCE_QUIT });
    Test.unknownList.push(item.word);
  }

  const note = forced ? "（30秒超過のため自動終了）" : "";
  const today = new Date().toISOString();
  db.put(STORE_TESTS, {
    deckId: App.currentDeck.id,
    date: today,
    total: Test.seq.length,
    results: Test.results,
  });

  updateDeckAvg().then(() => {
    App.currentWords = db.getAllByIndex(STORE_WORDS, "deckId", App.currentDeck.id).then((ws) => {
      App.currentWords = ws;
      renderWordList();
      renderDeckStats();
      $("testIdle").classList.remove("hidden");
      renderSummary(note);
    });
  });
}

async function updateDeckAvg() {
  const words = await db.getAllByIndex(STORE_WORDS, "deckId", App.currentDeck.id);
  const avg = words.length
    ? round2(words.reduce((s, w) => s + (w.score || SCORE_INIT), 0) / words.length)
    : SCORE_INIT;
  App.currentDeck.avgScore = avg;
  await db.put(STORE_DECKS, App.currentDeck);
}

function renderSummary(note) {
  $("testSummary").classList.remove("hidden");
  const n = Test.results.length;
  const known = Test.results.filter((r) => r.result === "known").length;
  const partial = Test.partialList.length;
  const unknown = Test.unknownList.length;
  let html = `<h3>テスト結果${note ? " " + esc(note) : ""}</h3>
    <div class="summary-grid">
      <div class="summary-stat"><b>${n}</b><span>出題</span></div>
      <div class="summary-stat good"><b>${known}</b><span>わかった</span></div>
      <div class="summary-stat mid"><b>${partial}</b><span>一部</span></div>
      <div class="summary-stat bad"><b>${unknown}</b><span>わからなかった</span></div>
    </div>`;
  if (partial) {
    html += `<div class="summary-section"><h4>一部だけわかった（${partial}）</h4><ul>${partial.map((w) => `<li><b>${esc(w.term)}</b> — ${esc(w.meaning)}</li>`).join("")}</ul></div>`;
  }
  if (unknown) {
    html += `<div class="summary-section"><h4>わからなかった（${unknown}）</h4><ul>${unknown.map((w) => `<li><b>${esc(w.term)}</b> — ${esc(w.meaning)}</li>`).join("")}</ul></div>`;
  }
  html += `<p class="muted">一覧タブからスコアを確認できます。</p>`;
  $("testSummary").innerHTML = html;
}

/* -------------------------------------------------------------------------
 * 初期化・イベント登録
 * ------------------------------------------------------------------------- */
function bindTabs() {
  const listTab = $("listTab");
  const testTab = $("testTab");
  const switchPanel = (showList) => {
    listTab.classList.toggle("active", showList);
    testTab.classList.toggle("active", !showList);
    $("listPanel").classList.toggle("active", showList);
    $("testPanel").classList.toggle("active", !showList);
  };
  listTab.addEventListener("click", () => switchPanel(true));
  testTab.addEventListener("click", () => switchPanel(false));
}

function bindGlobalEvents() {
  // ハンバーガーメニュー
  $("openMenuButton").addEventListener("click", openMenu);
  $("closeMenuButton").addEventListener("click", closeMenu);
  $("menuBackdrop").addEventListener("click", () => closeMenu(true));
  $("menuHome").addEventListener("click", () => { closeMenu(true); showScreen("home"); loadDecks(); });
  $("menuBackup").addEventListener("click", () => { closeMenu(true); showScreen("backup"); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(true); });

  // 戻る
  const backBtn = $("backButton");
  if (backBtn) backBtn.addEventListener("click", () => { closeMenu(true); showScreen("home"); loadDecks(); });

  // CSVインポート
  $("csvInput").addEventListener("change", (e) => handleCsvFiles(e.target.files));
  $("cancelImportButton").addEventListener("click", () => {
    pendingImports = [];
    $("importPreviewPanel").classList.add("hidden");
    $("csvInput").value = "";
  });
  $("confirmImportButton").addEventListener("click", confirmImport);

  // バックアップ
  $("exportBackupButton").addEventListener("click", exportBackup);
  $("restoreInput").addEventListener("change", (e) => {
    restoreBackup(e.target.files[0]);
    e.target.value = "";
  });

  // テスト
  $("startTestButton").addEventListener("click", startTest);
  $("revealButton").addEventListener("click", () => { if (Test.running) revealAnswer(); });
  $("finishTestButton").addEventListener("click", () => {
    if (confirm("テストを終了しますか？")) finishTest(false);
  });
  document.querySelectorAll(".answer-button").forEach((btn) => {
    btn.addEventListener("click", () => onAnswer(btn.dataset.result));
  });

  // 通知を閉じる
  $("dismissNotice").addEventListener("click", () => {
    $("updateNotice").classList.add("hidden");
    localStorage.setItem("noticeDismissed", "1");
  });
}

async function init() {
  try {
    await db.open();
  } catch (e) {
    showToast("データベースを開けませんでした");
    return;
  }
  bindGlobalEvents();
  bindDeckList();
  bindWordList();
  bindTabs();

  if (!localStorage.getItem("noticeDismissed")) {
    $("updateNotice").classList.remove("hidden");
  }

  showScreen("home");
  await loadDecks();
}

document.addEventListener("DOMContentLoaded", init);
/* END APP */
