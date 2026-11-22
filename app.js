const STORAGE_KEY = "wb_secret_key_v1";
const THEME_KEY = "wb_theme_v1";
const FONT_KEY = "wb_font_v1";
const READ_KEY = "wb_read_v1";
const BOOKMARKS_KEY = "wb_bookmarks_v1";

const SHORT_TAB_NAMES = {
  taiwan: "台灣焦點",
  industry: "產業深水區",
  economy: "國際經濟",
  markets: "金融市場",
  politics: "國際政治",
  finance: "財金企業",
  tech: "科技 AI",
  weekly: "本週回顧",
};

// Register offline Service Worker
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

function updateOnlineBadge() {
  const pill = document.getElementById("offlinePill");
  if (pill) pill.classList.toggle("hidden", navigator.onLine);
}
window.addEventListener("online", updateOnlineBadge);
window.addEventListener("offline", updateOnlineBadge);
updateOnlineBadge();

// Theme
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#0b1120" : "#f4f2ec");
}
const savedTheme = localStorage.getItem(THEME_KEY) ||
  (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
applyTheme(savedTheme);
document.getElementById("themeBtn").addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

// Font size
const FONT_STEPS = ["md", "lg", "xl"];
const FONT_LABELS = { md: "A", lg: "A+", xl: "A++" };
function applyFont(sz) {
  document.documentElement.setAttribute("data-font", sz);
  document.getElementById("fontBtn").textContent = FONT_LABELS[sz] || "A";
}
let currentFont = localStorage.getItem(FONT_KEY) || "md";
applyFont(currentFont);
document.getElementById("fontBtn").addEventListener("click", () => {
  const next = FONT_STEPS[(FONT_STEPS.indexOf(currentFont) + 1) % FONT_STEPS.length];
  currentFont = next;
  localStorage.setItem(FONT_KEY, next);
  applyFont(next);
  showToast(next === "md" ? "字體：標準" : next === "lg" ? "字體：大" : "字體：特大");
});

function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2000);
}

function b64urlToBytes(str) {
  let s = str.trim().replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64ToBytes(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function extractKeyFromInput(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "";
  const hashIdx = trimmed.indexOf("#");
  if (hashIdx !== -1) return trimmed.slice(hashIdx + 1).trim();
  return trimmed;
}

async function importAesKey(keyB64Url) {
  const rawBytes = b64urlToBytes(keyB64Url);
  if (rawBytes.length !== 32) throw new Error("金鑰長度不正確");
  return crypto.subtle.importKey("raw", rawBytes, { name: "AES-GCM" }, false, ["decrypt", "encrypt"]);
}

function bytesToB64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

async function encryptJsonPayload(obj, cryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plain));
  return JSON.stringify({ v: 1, iv: bytesToB64(iv), ct: bytesToB64(ct) });
}

async function decryptPayload(payload, cryptoKey) {
  const iv = b64ToBytes(payload.iv);
  const ct = b64ToBytes(payload.ct);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ct);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

// Errors carry a `kind` so the UI can tell a wrong key from being offline:
// "network" | "http" | "key" | "data".
function loadError(kind, message, status) {
  return Object.assign(new Error(message), { kind, status });
}

async function fetchEncryptedJson(relPath, cryptoKey) {
  let res;
  try {
    res = await fetch(`${relPath}?t=${Date.now()}`, { cache: "no-store" });
  } catch {
    throw loadError("network", "network error");
  }
  if (!res.ok) throw loadError("http", `HTTP ${res.status}`, res.status);
  let payload;
  try {
    payload = await res.json();
  } catch {
    throw loadError("data", "invalid payload");
  }
  try {
    return await decryptPayload(payload, cryptoKey);
  } catch (err) {
    // AES-GCM auth failure surfaces as OperationError: the key does not match.
    throw loadError(err?.name === "OperationError" ? "key" : "data", err?.message || "decrypt failed");
  }
}

function describeLoadError(err) {
  switch (err?.kind) {
    case "network":
      return "無法連線，且這份資料尚未離線快取。請連上網路後重試。";
    case "http":
      return err.status === 404
        ? "找不到這份資料（404），可能尚未發佈或已被移除。"
        : `伺服器暫時無法提供資料（HTTP ${err.status}），請稍後重試。`;
    case "key":
      return "解密失敗：金鑰不正確或連結不完整。請確認您的專屬加密網址。";
    default:
      return "資料格式異常，無法解密顯示。請重新整理或稍後再試。";
  }
}

// Only http(s) links are rendered as clickable; javascript:, data:, etc. become "#".
function safeUrl(raw) {
  try {
    const u = new URL(String(raw ?? ""), "https://invalid.invalid/");
    if ((u.protocol === "https:" || u.protocol === "http:") && u.hostname !== "invalid.invalid") return u.href;
  } catch {}
  return "#";
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Read state tracking
function getReadMap() {
  try { return JSON.parse(localStorage.getItem(READ_KEY) || "{}"); } catch { return {}; }
}
const READ_KEEP_DAYS = 60;
function markTabRead(date, tabId) {
  if (!date || !tabId) return;
  const map = getReadMap();
  const set = new Set(map[date] || []);
  set.add(tabId);
  map[date] = Array.from(set);
  // Keep only the most recent READ_KEEP_DAYS issue dates.
  const dates = Object.keys(map).sort().reverse();
  for (const d of dates.slice(READ_KEEP_DAYS)) delete map[d];
  localStorage.setItem(READ_KEY, JSON.stringify(map));
}
function isTabRead(date, tabId) {
  const map = getReadMap();
  return (map[date] || []).includes(tabId);
}

// Bookmarks
function getBookmarks() {
  try { return JSON.parse(localStorage.getItem(BOOKMARKS_KEY) || "[]"); } catch { return []; }
}
function makeBookmarkId(date, headline) {
  return `${date}::${headline}`;
}
function isBookmarked(date, headline) {
  const id = makeBookmarkId(date, headline);
  return getBookmarks().some((b) => b.id === id);
}
function toggleBookmark(date, secId, secName, item) {
  const id = makeBookmarkId(date, item.headline);
  const list = getBookmarks();
  const idx = list.findIndex((b) => b.id === id);
  if (idx >= 0) {
    list.splice(idx, 1);
    showToast("已取消收藏");
  } else {
    list.unshift({
      id,
      date,
      secId,
      secName,
      headline: item.headline,
      summary: item.summary,
      sources: item.sources || [],
    });
    showToast("已加入本機收藏 ★");
  }
  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(list.slice(0, 100)));
  renderActiveTab();
}

// Audio Briefing (Encrypted Neural MP3 with Web Speech API fallback)
let speechRate = 1.0;
let isSpeaking = false;
let audioEl = null;
let activeAudioFile = "";
let decryptedAudio = { path: "", url: "" }; // only the current issue's audio stays in memory

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function fetchDecryptedAudioUrl(relPath, cryptoKey) {
  if (decryptedAudio.path === relPath) return decryptedAudio.url;
  const res = await fetch(`${relPath}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`音檔載入失敗 (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ct);
  const blob = new Blob([plainBuf], { type: "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  if (decryptedAudio.url) URL.revokeObjectURL(decryptedAudio.url);
  decryptedAudio = { path: relPath, url };
  return url;
}

// Fallback for system speech. New issues carry `audio_script` (the exact text
// publish.mjs sent to TTS); the rest mirrors publish.mjs for older issues.
function composeAudioScript(report) {
  if (report.audio_script && String(report.audio_script).trim()) return String(report.audio_script).trim();
  if (report.audio_brief && String(report.audio_brief).trim()) return String(report.audio_brief).trim();
  const parts = [`早安，為您播報 ${report.date} 全球深度日報重點。`];
  if (report.subtitle) parts.push(report.subtitle);
  (report.executive_summary || []).forEach((line, i) => {
    parts.push(`重點 ${i + 1}，${line}`);
  });
  parts.push("以上是今日核心重點播報。");
  return parts.join(" ");
}

function stopSpeech() {
  if (audioEl) {
    audioEl.pause();
    audioEl.currentTime = 0;
  }
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  isSpeaking = false;
  updateAudioUi("點擊開始收聽主播語音摘要");
}

function updateAudioUi(statusText) {
  const btn = document.getElementById("audioPlayBtn");
  const st = document.getElementById("audioStatus");
  if (btn) btn.textContent = isSpeaking ? "⏸ 暫停" : "▶ 播報";
  if (st && statusText) st.textContent = statusText;
}

function syncAudioProgress() {
  const range = document.getElementById("audioRange");
  const timeEl = document.getElementById("audioTime");
  if (!audioEl || !range || !timeEl) return;
  const dur = audioEl.duration || 0;
  const cur = audioEl.currentTime || 0;
  range.max = dur ? Math.floor(dur) : 100;
  range.value = Math.floor(cur);
  timeEl.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
}

async function toggleSpeech() {
  if (!currentReport) return;

  // Prefer encrypted Neural MP3 audio
  if (currentReport.audio_file) {
    try {
      if (!audioEl) {
        audioEl = new Audio();
        audioEl.preload = "metadata";
        audioEl.addEventListener("timeupdate", syncAudioProgress);
        audioEl.addEventListener("loadedmetadata", syncAudioProgress);
        audioEl.addEventListener("ended", () => {
          isSpeaking = false;
          updateAudioUi("播報完畢");
        });
        audioEl.addEventListener("pause", () => {
          if (!audioEl.ended) {
            isSpeaking = false;
            updateAudioUi("已暫停");
          }
        });
        audioEl.addEventListener("play", () => {
          isSpeaking = true;
          updateAudioUi(`神經網路主播播報中（${speechRate}x）`);
        });
      }

      if (activeAudioFile !== currentReport.audio_file) {
        updateAudioUi("正在本機解密音檔…");
        const url = await fetchDecryptedAudioUrl(`./data/${currentReport.audio_file}`, currentCryptoKey);
        audioEl.src = url;
        activeAudioFile = currentReport.audio_file;
        if ("mediaSession" in navigator) {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: `全球深度日報 · ${currentReport.date}`,
            artist: "Daily World Brief",
            artwork: [{ src: "./icon-512.png?v=4", sizes: "512x512", type: "image/png" }],
          });
        }
      }

      audioEl.playbackRate = speechRate;
      if (audioEl.paused) {
        await audioEl.play();
      } else {
        audioEl.pause();
      }
      return;
    } catch (err) {
      console.error(err);
      showToast("音檔播放失敗，改用系統語音");
    }
  }

  // Fallback: browser Web Speech API
  if (!("speechSynthesis" in window)) {
    showToast("此瀏覽器不支援語音播報");
    return;
  }
  if (isSpeaking) {
    stopSpeech();
    return;
  }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(composeAudioScript(currentReport));
  utter.lang = "zh-TW";
  utter.rate = speechRate;
  const voices = window.speechSynthesis.getVoices();
  const zhTw = voices.find((v) => /zh[-_]TW/i.test(v.lang)) || voices.find((v) => /zh/i.test(v.lang));
  if (zhTw) utter.voice = zhTw;
  utter.onstart = () => {
    isSpeaking = true;
    updateAudioUi(`正在播報（${speechRate}x）…`);
  };
  utter.onend = () => {
    isSpeaking = false;
    updateAudioUi("播報結束");
  };
  utter.onerror = () => {
    isSpeaking = false;
    updateAudioUi("語音播報已停止");
  };
  window.speechSynthesis.speak(utter);
}

let currentKeyStr = "";
let currentCryptoKey = null;
let currentIndex = null;
let currentReport = null;
let currentTabs = [];
let activeTabId = "overview";
const decryptedCache = new Map();

function buildTabs(report) {
  const tabs = [{ id: "overview", label: "總覽", count: null }];
  for (const sec of (report.sections || [])) {
    tabs.push({
      id: sec.id,
      label: SHORT_TAB_NAMES[sec.id] || sec.name,
      fullName: sec.name,
      count: (sec.items || []).length,
    });
  }
  if (report.weekly_recap) {
    tabs.push({ id: "weekly", label: "本週回顧", fullName: "本週回顧與下週行事曆", count: null });
  }
  return tabs;
}

function renderTabBar() {
  const tabbar = document.getElementById("tabbar");
  const date = currentReport?.date;
  tabbar.innerHTML = currentTabs.map((t) => {
    const read = t.id !== "overview" && isTabRead(date, t.id);
    return `
      <button
        class="tab-btn ${t.id === activeTabId ? "active" : ""}"
        role="tab"
        aria-selected="${t.id === activeTabId}"
        data-tab="${esc(t.id)}"
      >
        ${esc(t.label)}${t.count !== null ? `<span class="tab-count">${t.count}</span>` : ""}${read ? `<span class="tab-read-dot">✓</span>` : ""}
      </button>
    `;
  }).join("");

  tabbar.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  const activeBtn = tabbar.querySelector(".tab-btn.active");
  if (activeBtn) {
    activeBtn.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }
}

function renderPager() {
  const idx = currentTabs.findIndex((t) => t.id === activeTabId);
  const prev = idx > 0 ? currentTabs[idx - 1] : null;
  const next = idx < currentTabs.length - 1 ? currentTabs[idx + 1] : null;
  return `
    <div class="pager-nav">
      <button class="pager-btn prev ${prev ? "" : "invisible"}" data-jump="${prev ? esc(prev.id) : ""}">
        ← ${prev ? esc(prev.label) : ""}
      </button>
      <button class="pager-btn next ${next ? "" : "invisible"}" data-jump="${next ? esc(next.id) : ""}">
        ${next ? esc(next.label) : ""} →
      </button>
    </div>
  `;
}

function renderOverview(report) {
  const audioHtml = `
    <div class="audio-bar">
      <div class="audio-top">
        <div class="audio-info">
          <span class="audio-title">🎧 晨間主播語音重點播報</span>
          <span class="audio-status" id="audioStatus">${isSpeaking ? `神經網路主播播報中（${speechRate}x）` : (report.audio_file ? "台灣神經網路主播 · 本機加密解密播放" : "本機語音合成")}</span>
        </div>
        <div class="audio-actions">
          <button id="audioSpeedBtn">${speechRate}x</button>
          <button id="audioPlayBtn" class="btn-accent">${isSpeaking ? "⏸ 暫停" : "▶ 播報"}</button>
        </div>
      </div>
      ${report.audio_file ? `
        <div class="audio-progress-row">
          <input type="range" id="audioRange" class="audio-range" min="0" max="100" value="0" />
          <span class="audio-time" id="audioTime">0:00 / 0:00</span>
        </div>` : ""}
    </div>
  `;

  const execHtml = (report.executive_summary || []).length
    ? `<div class="card">
         <div class="card-title">今日核心摘要</div>
         <ul class="exec-list">${report.executive_summary.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
       </div>`
    : "";

  const marketHtml = (report.market_snapshot || []).length
    ? `<div class="card">
         <div class="card-title">關鍵市場數據</div>
         <div class="market-grid">
           ${report.market_snapshot.map((m) => `
             <div class="ticker">
               <div class="ticker-label">${esc(m.label)}</div>
               <div class="ticker-val">${esc(m.value)}</div>
               <div class="ticker-chg ${esc(m.direction || "flat")}">${esc(m.change || "")}</div>
               ${m.as_of ? `<div class="ticker-asof">${esc(m.as_of)}</div>` : ""}
             </div>
           `).join("")}
         </div>
       </div>`
    : "";

  const watchlistHtml = (report.watchlist_updates || []).length
    ? `<div class="card">
         <div class="card-head-row">
           <div class="card-title">自選關注清單動態</div>
           <button id="openWatchlistBtn" style="font-size:12px;padding:4px 10px;">⚙ 管理清單</button>
         </div>
         <div class="watchlist-list">
           ${report.watchlist_updates.map((w) => `
             <div class="watch-row">
               <div class="watch-row-top">
                 <span class="watch-name">${esc(w.name)}</span>
                 <div style="display:flex;gap:5px;align-items:center;">
                   ${w.type === "stock" ? `<span class="badge badge-watch">個股</span>` : ""}
                   ${w.signal === "high" ? `<span class="badge badge-high">高影響</span>` : w.signal === "watch" ? `<span class="badge badge-watch">觀察</span>` : ""}
                 </div>
               </div>
               <div class="watch-status">${esc(w.status)}</div>
               ${w.note ? `<div class="watch-note">${esc(w.note)}</div>` : ""}
               ${w.next_earnings ? `
                 <div class="watch-earnings-row">
                   <span>📅 下次法說／財報會議：${esc(w.next_earnings.event || "")} · ${esc(w.next_earnings.date || "")}</span>
                 </div>` : ""}
               ${w.earnings_recap ? `
                 <details class="earnings-recap">
                   <summary>📋 ${esc(w.earnings_recap.event_title || "查看最新法說／電話會議重點報告")} ▾</summary>
                   ${(w.earnings_recap.metrics || []).length ? `
                     <div><strong>關鍵財報數據：</strong></div>
                     <ul>${w.earnings_recap.metrics.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : ""}
                   ${w.earnings_recap.guidance ? `<div style="margin-bottom:6px;"><strong>下季財測指引：</strong>${esc(w.earnings_recap.guidance)}</div>` : ""}
                   ${(w.earnings_recap.highlights || []).length ? `
                     <div><strong>會議重點摘要：</strong></div>
                     <ul>${w.earnings_recap.highlights.map((h) => `<li>${esc(h)}</li>`).join("")}</ul>` : ""}
                   ${(w.earnings_recap.sources || []).length ? `
                     <div class="sources" style="margin-top:6px;">
                       ${w.earnings_recap.sources.map((s) => `<a class="source-link" href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.name)} ↗</a>`).join("")}
                     </div>` : ""}
                 </details>` : ""}
             </div>
           `).join("")}
         </div>
       </div>`
    : `<div class="card">
         <div class="card-head-row">
           <div class="card-title">自選關注清單</div>
           <button id="openWatchlistBtn" style="font-size:12px;padding:4px 10px;">⚙ 管理清單</button>
         </div>
         <p class="subtitle" style="font-size:13px;margin:0;">本期沒有自選標的動態。可在這裡新增追蹤的個股或總經指標，明早的日報就會開始追蹤。</p>
       </div>`;

  const topicsHtml = (report.sections || []).length
    ? `<div class="card">
         <div class="card-title">主題快速切換</div>
         <div class="topic-grid">
           ${report.sections.map((s) => `
             <button class="topic-jump" data-jump="${esc(s.id)}">
               <span class="topic-jump-name">${esc(SHORT_TAB_NAMES[s.id] || s.name)}${isTabRead(report.date, s.id) ? " ✓" : ""}</span>
               <span class="topic-jump-meta">${(s.items || []).length} 則深度分析 →</span>
             </button>
           `).join("")}
           ${report.weekly_recap ? `
             <button class="topic-jump" data-jump="weekly">
               <span class="topic-jump-name">本週回顧${isTabRead(report.date, "weekly") ? " ✓" : ""}</span>
               <span class="topic-jump-meta">週日特別整理 →</span>
             </button>
           ` : ""}
         </div>
       </div>`
    : "";

  const watchHtml = (report.watch_ahead || []).length
    ? `<div class="card">
         <div class="card-title">未來 24–72 小時關注焦點</div>
         <ul class="exec-list">${report.watch_ahead.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>
       </div>`
    : "";

  return `
    ${renderMissingTodayBanner(report)}
    <div class="masthead">
      <div class="issue-meta">DAILY WORLD BRIEF · ${esc(report.date)}</div>
      <h1>${esc(report.title || "全球政經財金科技深度日報")}</h1>
      ${report.subtitle ? `<p class="subtitle">${esc(report.subtitle)}</p>` : ""}
    </div>
    ${renderCatchupCard(report)}
    ${audioHtml}
    ${execHtml}
    ${marketHtml}
    ${watchlistHtml}
    ${topicsHtml}
    ${renderWatchReview(report)}
    ${watchHtml}
  `;
}

// ---------- Daily status: missing issue, catch-up, prediction review ----------

const ISSUE_EXPECTED_HOUR = 9; // the schedule runs at 08:00 Asia/Taipei
const CATCHUP_MAX_ISSUES = 7;

function taipeiNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const shortDate = (d) => String(d || "").slice(5).replace("-", "/");
const isLatestIssue = (report) => currentIndex?.issues?.[0]?.date === report.date;

// Shown on the newest issue when today's issue should exist but doesn't.
function renderMissingTodayBanner(report) {
  if (!isLatestIssue(report)) return "";
  const now = taipeiNow();
  if (report.date >= now.date || now.hour < ISSUE_EXPECTED_HOUR) return "";
  return `
    <div class="card status-banner" role="status">
      <div class="status-banner-title">⚠ 今日（${esc(shortDate(now.date))}）日報尚未發佈</div>
      <p>早上 8:00 的排程可能失敗，或仍在產生中。目前顯示的是 ${esc(report.date)} 的日報。</p>
      <button data-action="recheck">重新檢查</button>
    </div>`;
}

// Issues published after the last one the reader opened (excluding the newest).
// Nothing counts as missed until at least one earlier issue has been read.
function getMissedIssues() {
  const issues = currentIndex?.issues || [];
  if (issues.length < 2) return [];
  const latest = issues[0].date;
  const map = getReadMap();
  const readBefore = Object.keys(map).filter((d) => d < latest && (map[d] || []).length).sort();
  if (!readBefore.length) return [];
  const lastRead = readBefore[readBefore.length - 1];
  return issues
    .slice(1)
    .filter((it) => it.date > lastRead && !(map[it.date] || []).length)
    .slice(0, CATCHUP_MAX_ISSUES);
}

function renderCatchupCard(report) {
  if (!isLatestIssue(report)) return "";
  const missed = getMissedIssues();
  if (!missed.length) return "";
  return `
    <div class="card catchup-card">
      <div class="card-title">你錯過了 ${missed.length} 期</div>
      <p class="subtitle" style="font-size:13px;margin:0 0 10px;">${missed.map((m) => esc(shortDate(m.date))).join("、")}：把這幾期的高影響新聞整理在一起，幾分鐘就能補上。</p>
      <div style="display:flex;gap:8px;">
        <button class="btn-accent" data-action="catchup-open" style="flex:1;">看錯過的重點</button>
        <button data-action="catchup-dismiss">全部標為已讀</button>
      </div>
    </div>`;
}

async function openCatchup() {
  const missed = getMissedIssues();
  const box = document.getElementById("catchupList");
  box.innerHTML = `<p class="subtitle">正在本機解密錯過的期數…</p>`;
  setModalOpen("catchupModal", true);
  const loaded = await Promise.all(missed.map((m) => fetchIssueCached(m.file).then((r) => ({ m, r }), () => ({ m, r: null }))));
  box.innerHTML = loaded.map(({ m, r }) => {
    if (!r) return `<div class="catchup-day"><div class="catchup-date">${esc(m.date)}</div><p class="subtitle">這期目前無法載入（可能離線）。</p></div>`;
    const highs = [];
    for (const sec of r.sections || []) {
      (sec.items || []).forEach((item) => { if (item.priority === "high") highs.push({ sec, item }); });
    }
    const rows = highs.length
      ? highs.map(({ sec, item }) => `
          <button class="search-hit" data-catchup-file="${esc(m.file)}" data-catchup-tab="${esc(sec.id)}">
            <div class="search-hit-meta">${esc(SHORT_TAB_NAMES[sec.id] || sec.name)}</div>
            <div class="search-hit-title">${esc(item.headline)}</div>
            ${item.summary ? `<div class="search-hit-snip">${esc(String(item.summary).slice(0, 90))}${String(item.summary).length > 90 ? "…" : ""}</div>` : ""}
          </button>`).join("")
      : `<button class="search-hit" data-catchup-file="${esc(m.file)}" data-catchup-tab="overview">
           <div class="search-hit-title">本期沒有高影響新聞</div>
           ${r.subtitle ? `<div class="search-hit-snip">${esc(r.subtitle)}</div>` : ""}
         </button>`;
    return `<div class="catchup-day"><div class="catchup-date">${esc(m.date)}${r.subtitle && highs.length ? ` · ${esc(r.subtitle)}` : ""}</div>${rows}</div>`;
  }).join("");
  box.querySelectorAll("[data-catchup-file]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      setModalOpen("catchupModal", false);
      document.getElementById("issueSelect").value = btn.dataset.catchupFile;
      await loadIssue(btn.dataset.catchupFile, btn.dataset.catchupTab);
    });
  });
}

function dismissCatchup() {
  for (const m of getMissedIssues()) markTabRead(m.date, "overview");
  renderActiveTab();
  showToast("已將錯過的期數標為已讀");
}

const REVIEW_STATUS = {
  happened: ["badge-followup", "✓ 如預期"],
  partial: ["badge-watch", "◐ 部分發生"],
  not_happened: ["badge-high", "✗ 未發生"],
  pending: ["badge-pending", "… 待揭曉"],
};

// How earlier "watch ahead" calls actually played out.
function renderWatchReview(report) {
  const rows = report.watch_review || [];
  if (!rows.length) return "";
  return `
    <div class="card">
      <div class="card-title">預測回顧：之前說要注意的事</div>
      <div class="review-list">
        ${rows.map((r) => {
          const [cls, label] = REVIEW_STATUS[r.status] || REVIEW_STATUS.pending;
          return `
            <div class="review-row">
              <div class="review-top"><span class="review-item">${esc(r.item)}</span><span class="badge ${cls}">${label}</span></div>
              ${r.outcome ? `<div class="review-outcome">${esc(r.outcome)}</div>` : ""}
              ${(r.sources || []).length ? `<div class="sources">${r.sources.map((s) => `<a class="source-link" href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.name)} ↗</a>`).join("")}</div>` : ""}
            </div>`;
        }).join("")}
      </div>
    </div>`;
}

document.getElementById("reportView").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  if (btn.dataset.action === "recheck") document.getElementById("refreshBtn").click();
  else if (btn.dataset.action === "catchup-open") openCatchup();
  else if (btn.dataset.action === "catchup-dismiss") dismissCatchup();
});

function renderSection(sec, report) {
  return `
    <div class="section-banner">
      <div>
        <h2>${esc(sec.name)}</h2>
        <span>${esc(report.date)} · ${(sec.items || []).length} 則分析</span>
      </div>
      ${sec.id === "industry" ? `<button id="openIndustryCfgBtn" style="font-size:12px;padding:5px 10px;">⚙ 客製產業主題</button>` : ""}
    </div>
    ${(sec.items || []).map((item, idx) => {
      const saved = isBookmarked(report.date, item.headline);
      const sectorBadge = item.sector
        ? `<span class="badge badge-watch">${esc(item.sector)}</span>`
        : "";
      const credBadge = item.credibility === "official"
        ? `<span class="badge badge-followup">官方證實</span>`
        : item.credibility === "corroborated"
          ? `<span class="badge badge-watch">多方佐證</span>`
          : item.credibility === "rumor"
            ? `<span class="badge badge-rumor">供應鏈傳聞・待證實</span>`
            : "";
      const priorityBadge = item.priority === "high"
        ? `<span class="badge badge-high">高影響</span>`
        : item.priority === "watch"
          ? `<span class="badge badge-watch">中期觀察</span>`
          : "";
      const followBadge = item.is_followup
        ? `<span class="badge badge-followup">延續追蹤</span>`
        : "";
      return `
        <div class="card news-item">
          <div class="item-meta-row">
            <div class="item-badges">${sectorBadge}${credBadge}${priorityBadge}${followBadge}</div>
            <button class="star-btn ${saved ? "saved" : ""}" data-star-sec="${esc(sec.id)}" data-star-idx="${idx}" title="收藏這則分析">
              ${saved ? "★ 已收藏" : "☆ 收藏"}
            </button>
          </div>
          <h3>${esc(item.headline)}</h3>
          ${item.followup_note ? `<div class="followup-box"><strong>延續昨日進展：</strong>${esc(item.followup_note)}</div>` : ""}
          <p class="news-summary">${esc(item.summary)}</p>
          ${(item.key_data || []).length ? `
            <div class="sub-block">
              <div class="sub-block-label">關鍵數據與事實</div>
              <ul>${item.key_data.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>
            </div>` : ""}
          ${item.impact ? `
            <div class="sub-block">
              <div class="sub-block-label">市場與亞太／台灣影響</div>
              <div>${esc(item.impact)}</div>
            </div>` : ""}
          ${item.verification_note ? `<div class="verify-badge">✓ 查核說明：${esc(item.verification_note)}</div>` : ""}
          <div class="sources">
            ${(item.sources || []).map((src) => `
              <a class="source-link" href="${esc(safeUrl(src.url))}" target="_blank" rel="noopener noreferrer">
                ${esc(src.name)}${src.date ? ` · ${esc(src.date)}` : ""} ↗
              </a>
            `).join("")}
          </div>
        </div>
      `;
    }).join("")}
  `;
}

function renderWeeklyRecap(report) {
  const w = report.weekly_recap;
  if (!w) return renderOverview(report);
  return `
    <div class="section-banner">
      <h2>本週全球回顧</h2>
      <span>${esc(w.week_range || report.date)}</span>
    </div>
    ${w.summary ? `<div class="card"><div class="card-title">一週總結</div><p class="news-summary" style="margin:0;">${esc(w.summary)}</p></div>` : ""}
    ${(w.themes || []).map((t) => `
      <div class="card news-item">
        <h3>${esc(t.title)}</h3>
        <p class="news-summary" style="margin:0;">${esc(t.detail)}</p>
      </div>
    `).join("")}
    ${(w.next_week_calendar || []).length ? `
      <div class="card">
        <div class="card-title">下週重大財經與政治行事曆</div>
        <ul class="exec-list">${w.next_week_calendar.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
      </div>` : ""}
  `;
}

function renderActiveTab() {
  if (!currentReport) return;
  markTabRead(currentReport.date, activeTabId);
  renderTabBar();
  const view = document.getElementById("reportView");
  let bodyHtml = "";
  if (activeTabId === "overview") {
    bodyHtml = renderOverview(currentReport);
  } else if (activeTabId === "weekly") {
    bodyHtml = renderWeeklyRecap(currentReport);
  } else {
    const sec = (currentReport.sections || []).find((s) => s.id === activeTabId);
    bodyHtml = sec ? renderSection(sec, currentReport) : renderOverview(currentReport);
  }

  view.innerHTML = `
    ${bodyHtml}
    ${renderPager()}
    <div class="footer-note">
      v2.9 · AES-256-GCM 本機端對端解密 · 支援離線閱讀與左右滑動切換 · ${esc(currentReport.generated_at || currentReport.date)}
    </div>
  `;

  view.querySelectorAll("[data-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.jump) switchTab(btn.dataset.jump);
    });
  });

  view.querySelectorAll("[data-star-sec]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sec = (currentReport.sections || []).find((s) => s.id === btn.dataset.starSec);
      const item = sec?.items?.[Number(btn.dataset.starIdx)];
      if (sec && item) toggleBookmark(currentReport.date, sec.id, sec.name, item);
    });
  });

  const openWlBtn = document.getElementById("openWatchlistBtn");
  if (openWlBtn) openWlBtn.addEventListener("click", () => openWatchlistModal(false));
  const openIndBtn = document.getElementById("openIndustryCfgBtn");
  if (openIndBtn) openIndBtn.addEventListener("click", () => openWatchlistModal(true));

  const playBtn = document.getElementById("audioPlayBtn");
  if (playBtn) playBtn.addEventListener("click", toggleSpeech);
  const rangeEl = document.getElementById("audioRange");
  if (rangeEl) {
    syncAudioProgress();
    rangeEl.addEventListener("input", (e) => {
      if (audioEl && Number.isFinite(audioEl.duration)) {
        audioEl.currentTime = Number(e.target.value);
        syncAudioProgress();
      }
    });
  }
  const speedBtn = document.getElementById("audioSpeedBtn");
  if (speedBtn) {
    speedBtn.addEventListener("click", () => {
      const speeds = [1.0, 1.15, 1.25, 1.5];
      speechRate = speeds[(speeds.indexOf(speechRate) + 1) % speeds.length];
      speedBtn.textContent = `${speechRate}x`;
      if (audioEl && !audioEl.paused) {
        audioEl.playbackRate = speechRate;
        updateAudioUi(`神經網路主播播報中（${speechRate}x）`);
      } else if (isSpeaking && !currentReport?.audio_file) {
        stopSpeech();
        toggleSpeech();
      }
    });
  }
}

function switchTab(tabId) {
  if (!currentTabs.some((t) => t.id === tabId)) tabId = "overview";
  activeTabId = tabId;
  renderActiveTab();
  window.scrollTo({ top: 0, behavior: "instant" });
}

// Touch swipe left/right between tabs
let touchStartX = 0;
let touchStartY = 0;
const swipeArea = document.getElementById("swipeArea");
swipeArea.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1) return;
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
}, { passive: true });
swipeArea.addEventListener("touchend", (e) => {
  if (!currentReport || e.changedTouches.length !== 1) return;
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;
  if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.6) {
    const idx = currentTabs.findIndex((t) => t.id === activeTabId);
    if (dx < 0 && idx < currentTabs.length - 1) switchTab(currentTabs[idx + 1].id);
    if (dx > 0 && idx > 0) switchTab(currentTabs[idx - 1].id);
  }
}, { passive: true });

// Local full-text search across all decrypted issues
const SEARCH_CONCURRENCY = 4;
const SEARCH_MAX_HITS = 100;
const pendingIssueFetches = new Map(); // file -> in-flight promise, shared by overlapping searches
let searchSeq = 0;
let searchDebounce = null;

function fetchIssueCached(file) {
  if (decryptedCache.has(file)) return Promise.resolve(decryptedCache.get(file));
  if (!pendingIssueFetches.has(file)) {
    const p = fetchEncryptedJson(`./data/${file}`, currentCryptoKey)
      .then((rep) => {
        decryptedCache.set(file, rep);
        return rep;
      })
      .finally(() => pendingIssueFetches.delete(file));
    pendingIssueFetches.set(file, p);
  }
  return pendingIssueFetches.get(file);
}

async function loadAllIssuesForSearch() {
  if (!currentIndex?.issues || !currentCryptoKey) return { results: [], failed: 0 };
  const metas = currentIndex.issues;
  const reports = new Array(metas.length);
  let next = 0;
  let failed = 0;
  async function worker() {
    while (next < metas.length) {
      const i = next++;
      try {
        reports[i] = await fetchIssueCached(metas[i].file);
      } catch {
        failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SEARCH_CONCURRENCY, metas.length) }, worker));
  const results = metas.map((meta, i) => ({ meta, report: reports[i] })).filter((r) => r.report);
  return { results, failed };
}

const joinText = (...parts) => parts.flat().filter(Boolean).join(" ");

// Flattens one report into searchable entries: news items, weekly recap, watchlist.
function searchEntries(meta, report) {
  const out = [];
  for (const sec of report.sections || []) {
    for (const item of sec.items || []) {
      out.push({
        tabId: sec.id,
        label: SHORT_TAB_NAMES[sec.id] || sec.name,
        title: item.headline,
        snippet: item.summary,
        hay: joinText(item.headline, item.summary, item.key_data || [], item.impact, item.followup_note),
      });
    }
  }
  const w = report.weekly_recap;
  if (w) {
    out.push({
      tabId: "weekly",
      label: "本週回顧",
      title: `本週回顧 ${w.week_range || ""}`.trim(),
      snippet: w.summary,
      hay: joinText(w.summary, (w.themes || []).map((t) => [t.title, t.detail]), w.next_week_calendar || []),
    });
  }
  for (const r of report.watch_review || []) {
    out.push({
      tabId: "overview",
      label: "預測回顧",
      title: r.item,
      snippet: r.outcome,
      hay: joinText(r.item, r.outcome),
    });
  }
  for (const wu of report.watchlist_updates || []) {
    const r = wu.earnings_recap || {};
    out.push({
      tabId: "overview",
      label: "自選清單",
      title: wu.name,
      snippet: joinText(wu.status, wu.note),
      hay: joinText(wu.name, wu.symbol, wu.status, wu.note, r.event_title, r.metrics || [], r.guidance, r.highlights || []),
    });
  }
  return out.map((e) => ({ ...e, file: meta.file, date: report.date }));
}

async function runSearch(query) {
  const seq = ++searchSeq;
  const box = document.getElementById("searchResults");
  const q = (query || "").trim().toLowerCase();
  if (!q) {
    box.innerHTML = `<p class="subtitle">輸入關鍵字，將在本機即時搜尋所有歷史期數（共 ${(currentIndex?.issues || []).length} 期）。</p>`;
    return;
  }
  box.innerHTML = `<p class="subtitle">正在本機解密並搜尋歷史期數…</p>`;
  const { results, failed } = await loadAllIssuesForSearch();
  if (seq !== searchSeq) return; // a newer query started while we were loading

  const hits = [];
  for (const { meta, report } of results) {
    for (const e of searchEntries(meta, report)) {
      if (e.hay.toLowerCase().includes(q)) hits.push(e);
    }
  }
  const failedNote = failed ? `<p class="subtitle" style="font-size:12px;">（另有 ${failed} 期目前無法載入，未納入搜尋）</p>` : "";
  if (hits.length === 0) {
    box.innerHTML = `<p class="subtitle">找不到包含「${esc(query)}」的歷史紀錄。</p>${failedNote}`;
    return;
  }
  const shown = hits.slice(0, SEARCH_MAX_HITS);
  const moreNote = hits.length > shown.length
    ? `<p class="subtitle" style="font-size:12px;">共 ${hits.length} 筆，僅顯示前 ${shown.length} 筆，請輸入更精確的關鍵字。</p>`
    : "";
  box.innerHTML = shown.map((h, i) => {
    const snip = String(h.snippet || "");
    return `
    <button class="search-hit" data-hit-idx="${i}">
      <div class="search-hit-meta">${esc(h.date)} · ${esc(h.label)}</div>
      <div class="search-hit-title">${esc(h.title)}</div>
      ${snip ? `<div class="search-hit-snip">${esc(snip.slice(0, 90))}${snip.length > 90 ? "…" : ""}</div>` : ""}
    </button>`;
  }).join("") + moreNote + failedNote;
  box.querySelectorAll(".search-hit").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const hit = shown[Number(btn.dataset.hitIdx)];
      setModalOpen("searchModal", false);
      document.getElementById("issueSelect").value = hit.file;
      await loadIssue(hit.file, hit.tabId);
    });
  });
}

function scheduleSearch(query) {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch(query), 250);
}

function setModalOpen(id, open) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle("hidden", !open);
  const anyOpen = ["searchModal", "bookmarksModal", "watchlistModal", "catchupModal"].some(
    (m) => !document.getElementById(m).classList.contains("hidden")
  );
  document.body.style.overflow = anyOpen ? "hidden" : "";
}

["searchModal", "bookmarksModal", "watchlistModal", "catchupModal"].forEach((id) => {
  document.getElementById(id).addEventListener("click", (e) => {
    if (e.target.id === id) setModalOpen(id, false);
  });
});

document.getElementById("searchBtn").addEventListener("click", () => {
  setModalOpen("searchModal", true);
  const inp = document.getElementById("searchInput");
  runSearch(inp.value);
});
document.getElementById("closeSearchBtn").addEventListener("click", () => {
  setModalOpen("searchModal", false);
});
document.getElementById("searchInput").addEventListener("input", (e) => scheduleSearch(e.target.value));

// Bookmarks modal
function renderBookmarksModal() {
  const box = document.getElementById("bookmarksList");
  const list = getBookmarks();
  if (!list.length) {
    box.innerHTML = `<p class="subtitle">目前尚未收藏文章。閱讀任意主題時，點選右上角「☆ 收藏」即可儲存於本機。</p>`;
    return;
  }
  box.innerHTML = list.map((b, i) => `
    <div class="card" style="padding:14px;">
      <div class="item-meta-row" style="margin-bottom:6px;">
        <span class="search-hit-meta" style="margin:0;">${esc(b.date)} · ${esc(SHORT_TAB_NAMES[b.secId] || b.secName)}</span>
        <button class="star-btn saved" data-rm-bm="${i}">移除</button>
      </div>
      <div class="search-hit-title">${esc(b.headline)}</div>
      <div class="search-hit-snip" style="margin-bottom:8px;">${esc(b.summary)}</div>
      <div class="sources">
        ${(b.sources || []).map((s) => `<a class="source-link" href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.name)} ↗</a>`).join("")}
      </div>
    </div>
  `).join("");
  box.querySelectorAll("[data-rm-bm]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const updated = getBookmarks();
      updated.splice(Number(btn.dataset.rmBm), 1);
      localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(updated));
      renderBookmarksModal();
      renderActiveTab();
    });
  });
}
document.getElementById("bookmarksBtn").addEventListener("click", () => {
  renderBookmarksModal();
  setModalOpen("bookmarksModal", true);
});
document.getElementById("closeCatchupBtn").addEventListener("click", () => setModalOpen("catchupModal", false));
document.getElementById("closeBookmarksBtn").addEventListener("click", () => {
  setModalOpen("bookmarksModal", false);
});

// Watchlist Manager Modal (Local edit + optional encrypted GitHub Sync)
const WL_LOCAL_KEY = "wb_watchlist_local_v1";
const GH_TOKEN_KEY = "wb_gh_sync_token_v1";
const GH_SYNC_REPO_KEY = "wb_gh_sync_repo_v1";
// Legacy target: the Pages repo itself. A token for it can also rewrite this app,
// so prefer a separate private sync repo (set in the watchlist settings panel).
const PAGES_REPO = "VineRo/wb-291128492f";
const WL_MAX_ITEMS = 50;
const IND_MAX_TOPICS = 20;
const DEFAULT_INDUSTRY_TOPICS = [
  { name: "CoWoS／先進封裝", focus: "台積電、日月光、矽品、精材、CoWoS-L 產能與外包" },
  { name: "HBM 記憶體", focus: "SK 海力士、美光、三星、HBM4 驗證與設備訂單" },
  { name: "AI 伺服器 ODM", focus: "鴻海、廣達、緯創、緯穎、GB300 與 Vera Rubin 機櫃出貨" },
  { name: "矽光子", focus: "台積電 COUPE、CPO 交換器、博通、輝達、光電測試與 InP 基板" },
  { name: "生技", focus: "FDA 藥證審查、臨床試驗數據、大藥廠併購與授權" },
  { name: "航運", focus: "Drewry／SCFI 運價、紅海繞道、荷姆茲海峽通行量與貨櫃航商" },
];
let editableWatchlist = { updated_at: new Date().toISOString(), items: [], industry_topics: DEFAULT_INDUSTRY_TOPICS };

function getSyncTarget() {
  const repo = localStorage.getItem(GH_SYNC_REPO_KEY) || PAGES_REPO;
  return { repo, path: repo === PAGES_REPO ? "data/watchlist.enc" : "watchlist.enc" };
}

function renderWatchlistModalItems() {
  const box = document.getElementById("wlItemsList");
  const items = editableWatchlist.items || [];
  if (!items.length) {
    box.innerHTML = `<p class="subtitle">目前清單為空，請於下方新增標的。</p>`;
    return;
  }
  box.innerHTML = items.map((it, i) => `
    <div class="wl-item-row">
      <div>
        <div style="font-weight:800;font-size:14px;">${esc(it.name)} <span style="font-weight:600;color:var(--muted);font-size:12px;">${esc(it.symbol || "")}</span></div>
        <div style="font-size:11.5px;color:var(--accent);">${it.type === "stock" ? "📈 個股（追蹤法說／財報會議）" : "🌐 總經／指數／商品"}</div>
      </div>
      <button data-rm-wl="${i}" style="color:var(--signal);border-color:var(--border);">移除</button>
    </div>
  `).join("");
  box.querySelectorAll("[data-rm-wl]").forEach((btn) => {
    btn.addEventListener("click", () => {
      editableWatchlist.items.splice(Number(btn.dataset.rmWl), 1);
      editableWatchlist.updated_at = new Date().toISOString();
      localStorage.setItem(WL_LOCAL_KEY, JSON.stringify(editableWatchlist));
      renderWatchlistModalItems();
    });
  });
}

function renderIndustryTopicsModal() {
  const box = document.getElementById("indTopicsList");
  if (!box) return;
  const topics = editableWatchlist.industry_topics || [];
  if (!topics.length) {
    box.innerHTML = `<p class="subtitle">目前未設定產業主題，請於下方新增。</p>`;
    return;
  }
  box.innerHTML = topics.map((t, i) => `
    <div class="wl-item-row">
      <div>
        <div style="font-weight:800;font-size:14px;">${esc(t.name)}</div>
        ${t.focus ? `<div style="font-size:11.5px;color:var(--muted);">${esc(t.focus)}</div>` : ""}
      </div>
      <button data-rm-ind="${i}" style="color:var(--signal);border-color:var(--border);">移除</button>
    </div>
  `).join("");
  box.querySelectorAll("[data-rm-ind]").forEach((btn) => {
    btn.addEventListener("click", () => {
      editableWatchlist.industry_topics.splice(Number(btn.dataset.rmInd), 1);
      editableWatchlist.updated_at = new Date().toISOString();
      localStorage.setItem(WL_LOCAL_KEY, JSON.stringify(editableWatchlist));
      renderIndustryTopicsModal();
    });
  });
}

async function openWatchlistModal(scrollToIndustry = false) {
  setModalOpen("watchlistModal", true);
  document.getElementById("ghTokenInput").value = localStorage.getItem(GH_TOKEN_KEY) || "";
  document.getElementById("ghRepoInput").value = localStorage.getItem(GH_SYNC_REPO_KEY) || "";
  try {
    const remote = await fetchEncryptedJson("./data/watchlist.enc", currentCryptoKey);
    const localRaw = localStorage.getItem(WL_LOCAL_KEY);
    const local = localRaw ? JSON.parse(localRaw) : null;
    const rTs = Date.parse(remote.updated_at || 0) || 0;
    const lTs = local ? (Date.parse(local.updated_at || 0) || 0) : 0;
    editableWatchlist = lTs > rTs ? local : remote;
  } catch {
    const localRaw = localStorage.getItem(WL_LOCAL_KEY);
    editableWatchlist = localRaw
      ? JSON.parse(localRaw)
      : {
          updated_at: new Date().toISOString(),
          items: (currentReport?.watchlist_updates || []).map((w) => ({
            name: w.name,
            symbol: w.symbol || "",
            type: w.type || "macro",
          })),
          industry_topics: DEFAULT_INDUSTRY_TOPICS,
        };
  }
  if (!Array.isArray(editableWatchlist.industry_topics)) {
    editableWatchlist.industry_topics = [...DEFAULT_INDUSTRY_TOPICS];
  }
  renderWatchlistModalItems();
  renderIndustryTopicsModal();
  if (scrollToIndustry) {
    const sec = document.getElementById("industryTopicsSection");
    if (sec) sec.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

document.getElementById("closeWatchlistBtn").addEventListener("click", () => {
  setModalOpen("watchlistModal", false);
});

document.getElementById("wlAddBtn").addEventListener("click", () => {
  const name = document.getElementById("wlNameInput").value.trim();
  const symbol = document.getElementById("wlSymbolInput").value.trim();
  const type = document.getElementById("wlTypeSelect").value;
  if (!name) {
    showToast("請輸入標的名稱");
    return;
  }
  editableWatchlist.items = editableWatchlist.items || [];
  if (editableWatchlist.items.length >= WL_MAX_ITEMS) {
    showToast(`清單最多 ${WL_MAX_ITEMS} 項`);
    return;
  }
  editableWatchlist.items.push({ name, symbol, type });
  editableWatchlist.updated_at = new Date().toISOString();
  localStorage.setItem(WL_LOCAL_KEY, JSON.stringify(editableWatchlist));
  document.getElementById("wlNameInput").value = "";
  document.getElementById("wlSymbolInput").value = "";
  renderWatchlistModalItems();
  showToast(`已加入 ${name}`);
});

document.getElementById("indAddBtn").addEventListener("click", () => {
  const name = document.getElementById("indNameInput").value.trim();
  const focus = document.getElementById("indFocusInput").value.trim();
  if (!name) {
    showToast("請輸入產業主題名稱");
    return;
  }
  editableWatchlist.industry_topics = editableWatchlist.industry_topics || [];
  if (editableWatchlist.industry_topics.length >= IND_MAX_TOPICS) {
    showToast(`產業主題最多 ${IND_MAX_TOPICS} 項`);
    return;
  }
  editableWatchlist.industry_topics.push(focus ? { name, focus } : { name });
  editableWatchlist.updated_at = new Date().toISOString();
  localStorage.setItem(WL_LOCAL_KEY, JSON.stringify(editableWatchlist));
  document.getElementById("indNameInput").value = "";
  document.getElementById("indFocusInput").value = "";
  renderIndustryTopicsModal();
  showToast(`已加入產業主題：${name}`);
});

document.getElementById("saveGhTokenBtn").addEventListener("click", () => {
  const tok = document.getElementById("ghTokenInput").value.trim();
  const repo = document.getElementById("ghRepoInput").value.trim();
  if (repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    showToast("同步 repo 格式應為 owner/name");
    return;
  }
  if (repo) localStorage.setItem(GH_SYNC_REPO_KEY, repo);
  else localStorage.removeItem(GH_SYNC_REPO_KEY);
  if (!tok) {
    localStorage.removeItem(GH_TOKEN_KEY);
    showToast("已清除本機同步 Token");
  } else {
    localStorage.setItem(GH_TOKEN_KEY, tok);
    showToast("已儲存同步 Token 至本機");
  }
});

document.getElementById("wlCopyBtn").addEventListener("click", async () => {
  const summary = (editableWatchlist.items || [])
    .map((it) => `- ${it.name}${it.symbol ? ` (${it.symbol})` : ""} [${it.type === "stock" ? "個股" : "總經"}]`)
    .join("\n");
  const indSummary = (editableWatchlist.industry_topics || [])
    .map((t) => `- ${t.name}${t.focus ? `（${t.focus}）` : ""}`)
    .join("\n");
  const text = `請幫我更新 Daily World Brief 的自選清單為：\n${summary}\n\n產業深水區主題：\n${indSummary}`;
  try {
    await navigator.clipboard.writeText(text);
    showToast("已複製清單，可直接貼給 Antigravity 更新");
  } catch {
    prompt("請複製以下清單：", text);
  }
});

document.getElementById("wlSyncBtn").addEventListener("click", async () => {
  editableWatchlist.updated_at = new Date().toISOString();
  localStorage.setItem(WL_LOCAL_KEY, JSON.stringify(editableWatchlist));
  const token = localStorage.getItem(GH_TOKEN_KEY);
  if (!token) {
    showToast("已存於本機；請設定下方 Token 或點「複製清單」同步回排程");
    return;
  }
  try {
    showToast("正在加密並同步至排程…");
    const encStr = await encryptJsonPayload(editableWatchlist, currentCryptoKey);
    const contentB64 = btoa(unescape(encodeURIComponent(encStr)));
    const target = getSyncTarget();
    const apiUrl = `https://api.github.com/repos/${target.repo}/contents/${target.path}`;
    let sha = undefined;
    const getRes = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (getRes.ok) {
      const meta = await getRes.json();
      sha = meta.sha;
    } else if (getRes.status !== 404) {
      throw new Error(getRes.status === 401 || getRes.status === 403 ? "Token 無效或沒有此 repo 權限" : `GitHub HTTP ${getRes.status}`);
    }
    const putRes = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "Sync encrypted watchlist from mobile",
        content: contentB64,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!putRes.ok) throw new Error(`GitHub HTTP ${putRes.status}`);
    showToast("✓ 已加密同步！明早 8:00 自動生效");
  } catch (err) {
    console.error(err);
    showToast(`同步失敗：${err.message}`);
  }
});

async function loadIssue(file, targetTab = "overview") {
  stopSpeech();
  document.getElementById("loadingView").classList.remove("hidden");
  const view = document.getElementById("reportView");
  view.classList.add("hidden");
  try {
    const rep = await fetchEncryptedJson(`./data/${file}`, currentCryptoKey);
    decryptedCache.set(file, rep);
    currentReport = rep;
    currentTabs = buildTabs(currentReport);
    activeTabId = currentTabs.some((t) => t.id === targetTab) ? targetTab : "overview";
    renderActiveTab();
  } catch (err) {
    console.error(err);
    // Clear the previous issue so tabs/swipes don't show it under the new selection.
    currentReport = null;
    currentTabs = [];
    renderTabBar();
    view.innerHTML = `
      <div class="card locked-box">
        <p class="subtitle">${esc(describeLoadError(err))}</p>
        <button id="retryIssueBtn" class="btn-primary">重試</button>
      </div>`;
    document.getElementById("retryIssueBtn").addEventListener("click", () => loadIssue(file, targetTab));
  } finally {
    document.getElementById("loadingView").classList.add("hidden");
    view.classList.remove("hidden");
  }
}

async function boot(rawKey) {
  const lockedView = document.getElementById("lockedView");
  const loadingView = document.getElementById("loadingView");
  const reportView = document.getElementById("reportView");
  const stickyHeader = document.getElementById("stickyHeader");

  if (!rawKey) {
    loadingView.classList.add("hidden");
    lockedView.classList.remove("hidden");
    return;
  }

  try {
    lockedView.classList.add("hidden");
    loadingView.classList.remove("hidden");

    currentCryptoKey = await importAesKey(rawKey);
    currentIndex = await fetchEncryptedJson("./data/index.enc", currentCryptoKey);
    currentKeyStr = rawKey;
    localStorage.setItem(STORAGE_KEY, rawKey);
    if (window.location.hash !== `#${rawKey}`) {
      history.replaceState(null, "", `#${rawKey}`);
    }

    const select = document.getElementById("issueSelect");
    select.innerHTML = (currentIndex.issues || [])
      .map((it) => `<option value="${esc(it.file)}">${esc(it.date)}${it.has_weekly_recap ? " 週報" : ""}</option>`)
      .join("");

    stickyHeader.classList.remove("hidden");
    if (currentIndex.issues && currentIndex.issues.length > 0) {
      await loadIssue(currentIndex.issues[0].file);
    } else {
      loadingView.classList.add("hidden");
      reportView.innerHTML = `<div class="card"><p>目前尚無已發佈的日報。</p></div>`;
      reportView.classList.remove("hidden");
    }
  } catch (err) {
    console.error(err);
    loadingView.classList.add("hidden");
    reportView.classList.add("hidden");
    stickyHeader.classList.add("hidden");
    // importAesKey throws a plain Error for a malformed key, so no kind means "key".
    document.getElementById("lockedMsg").textContent = describeLoadError(err.kind ? err : { kind: "key" });
    lockedView.classList.remove("hidden");
  }
}

document.getElementById("issueSelect").addEventListener("change", (e) => {
  if (e.target.value) loadIssue(e.target.value);
});

const DATA_CACHE_NAME = "world-brief-data-v1"; // must match DATA_CACHE in sw.js
document.getElementById("refreshBtn").addEventListener("click", async () => {
  decryptedCache.clear();
  if ("caches" in window) {
    try {
      // Drop only the app shell; keep downloaded issues for offline reading.
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== DATA_CACHE_NAME).map((k) => caches.delete(k)));
    } catch {}
  }
  if ("serviceWorker" in navigator) {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.update()));
    } catch {}
  }
  showToast("正在重新載入最新版本…");
  window.location.reload();
});

document.getElementById("unlockBtn").addEventListener("click", () => {
  const k = extractKeyFromInput(document.getElementById("manualKeyInput").value);
  boot(k);
});

const hashKey = extractKeyFromInput(window.location.hash);
const initialKey = hashKey || localStorage.getItem(STORAGE_KEY) || "";
boot(initialKey);
