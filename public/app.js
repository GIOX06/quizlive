const socket = io();

const answerLetters = ["A", "B", "C", "D", "E", "F"];
const answerClasses = ["answer-a", "answer-b", "answer-c", "answer-d", "answer-e", "answer-f"];
const questionTypes = [
  { value: "multiple", label: "Scelta multipla" },
  { value: "true_false", label: "Vero/Falso" },
  { value: "speed", label: "Risposta veloce" },
  { value: "multiple_select", label: "Risposte multiple" }
];
let local = {
  mode: initialMode(),
  room: null,
  quiz: defaultQuiz(),
  selectedAnswer: null,
  selectedAnswers: [],
  importOpen: false,
  archiveOpen: false,
  archiveLoading: false,
  hostAuth: {
    checked: false,
    enabled: false,
    authenticated: false,
    loading: false,
    password: ""
  },
  importText: "",
  savedQuizzes: [],
  savedResults: [],
  archiveSearch: "",
  currentQuizId: null,
  joinCode: initialJoinCode(),
  screenCode: initialScreenCode(),
  screenJoining: false,
  screenWaiting: false,
  nickname: "",
  playerBaseUrl: window.location.origin,
  playerAccessMode: "same-origin"
};
let reconnectingForHostAuth = false;
let screenPresentationRequest = null;
let screenPresentationUrl = "";
let screenPresentationConnection = null;
let screenPresentationDisconnecting = false;

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");

socket.on("connect", () => {
  reconnectingForHostAuth = false;
  autoJoinScreen();
  render();
});

socket.on("disconnect", () => {
  if (!reconnectingForHostAuth) showToast("Connessione persa");
  render();
});

socket.on("room:state", (room) => {
  local.room = room;
  local.mode = room.role;
  if (room.role === "screen") {
    local.screenCode = room.code;
    window.history.replaceState(null, "", `#screen=${encodeURIComponent(room.code)}`);
  }
  if (room.status !== "question") {
    local.selectedAnswer = null;
    local.selectedAnswers = [];
  }
  render();
});

socket.on("player:removed", (payload) => {
  leaveRoomLocally(payload && payload.message ? payload.message : "Sei fuori dalla nuova partita");
});

socket.on("screen:waiting", () => {
  enterScreenWaiting();
});

loadNetworkConfig();
loadHostAuth();

window.addEventListener("hashchange", () => {
  if (local.room) return;
  local.joinCode = initialJoinCode();
  local.screenCode = initialScreenCode();
  local.mode = initialMode();
  autoJoinScreen();
  render();
});

setInterval(() => {
  if (local.room && local.room.status === "question") updateLiveTimers();
}, 250);

function render() {
  app.innerHTML = shell(renderMain(), renderTopbar());
  bindEvents();
  updateScreenPresentationRequest();
}

function renderTopbar() {
  const room = local.room;
  const code = room ? `<span class="room-code">${escapeHtml(room.code)}</span>` : "";
  const status = room ? `<span class="status-pill">${statusLabel(room.status)}</span>` : `<span class="status-pill">${socket.connected ? "Online" : "Offline"}</span>`;
  return `
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
        <div>
          <div class="brand-name">QuizLive</div>
          <p class="subtle">${room ? escapeHtml(room.title) : "Live quiz web"}</p>
        </div>
      </div>
      <div class="toolbar right">${code}${status}</div>
    </header>
  `;
}

function renderMain() {
  if (!local.room) {
    if (local.mode === "host") return hostAccessGranted() ? renderHostHome() : renderHostAccess();
    if (local.mode === "screen") return renderScreenHome();
    return renderJoinHome();
  }
  if (local.room.role === "host") return renderHostGame(local.room);
  if (local.room.role === "screen") return renderScreenGame(local.room);
  return renderPlayerGame(local.room);
}

function shell(main, topbar) {
  return `<div class="shell">${topbar}<main class="main">${main}</main></div>`;
}

function renderJoinHome() {
  return `
    <section class="join-shell">
      <div class="panel join-panel stack">
        <div>
          <h1 class="section-title">Entra in partita</h1>
          <p class="subtle">Inserisci codice e nickname.</p>
        </div>
        <label class="stack">
          <span>Codice stanza</span>
          <input data-field="join-code" inputmode="numeric" maxlength="6" placeholder="123456" value="${escapeAttr(local.joinCode)}" />
        </label>
        <label class="stack">
          <span>Nickname</span>
          <input data-field="join-name" maxlength="24" placeholder="Nome" value="${escapeAttr(local.nickname)}" />
        </label>
        <div class="toolbar">
          <button class="btn teal" data-action="join-room">Entra in partita</button>
        </div>
      </div>
    </section>
  `;
}

function renderScreenHome() {
  return `
    <section class="screen-layout">
      <div class="panel screen-panel screen-splash stack">
        <div class="screen-brand">
          <div class="screen-brand-mark" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
          <div>
            <p class="screen-kicker">Monitor pubblico</p>
            <h1 class="screen-title">QuizLive</h1>
          </div>
        </div>
        <div class="screen-waiting">
          <span class="status-pill">${local.screenWaiting ? "In attesa della stanza" : "Pronto"}</span>
        </div>
        <div class="screen-code-entry">
          <input data-field="screen-code" inputmode="numeric" maxlength="6" placeholder="Codice stanza" value="${escapeAttr(local.screenCode)}" />
          <button class="btn ghost" data-action="join-screen" ${local.screenJoining ? "disabled" : ""}>Collega codice</button>
          ${renderCastScreenButton()}
        </div>
      </div>
    </section>
  `;
}

function renderCastScreenButton() {
  if (isScreenPresentationConnected()) {
    return `<button class="btn ghost" data-action="disconnect-screen-cast">Scollega TV</button>`;
  }
  return `<button class="btn ghost" data-action="cast-screen">Trasmetti TV</button>`;
}

function renderHostHome() {
  return `
    <section class="stack">
      <div class="host-header">
        <div>
          <h1 class="section-title">Crea partita</h1>
          <p class="subtle">Quiz, lobby, timer, punteggio e risultati esportabili.</p>
        </div>
        <div class="toolbar">
          <button class="btn ghost" data-action="open-waiting-screen">Apri monitor</button>
          ${renderCastScreenButton()}
          ${local.hostAuth.enabled ? `<button class="btn ghost" data-action="host-logout">Blocca host</button>` : ""}
          <button class="btn ghost" data-action="open-player-link">Apri giocatore</button>
        </div>
      </div>
      <div class="panel stack">
        ${renderQuizBuilder()}
        <div class="toolbar">
          <button class="btn primary" data-action="create-room">Crea stanza</button>
          <button class="btn gold" data-action="quick-start-room">Avvia subito</button>
          <button class="btn teal" data-action="save-quiz">Salva quiz</button>
          <button class="btn ghost" data-action="add-question">Aggiungi domanda</button>
          <button class="btn ghost" data-action="toggle-import">Import XLSX</button>
          <button class="btn ghost" data-action="download-template-xlsx">Modello XLSX</button>
          <button class="btn ghost" data-action="download-quiz-xlsx">Export XLSX</button>
          <button class="btn ghost" data-action="toggle-archive">Archivio</button>
        </div>
        ${local.importOpen ? renderImportBox() : ""}
        ${local.archiveOpen ? renderArchiveBox() : ""}
      </div>
    </section>
  `;
}

function renderHostAccess() {
  if (!local.hostAuth.checked) {
    return `
      <section class="join-shell">
        <div class="panel join-panel stack">
          <div>
            <h1 class="section-title">Accesso host</h1>
            <p class="subtle">Controllo accesso...</p>
          </div>
          <button class="btn ghost" data-action="open-player-link">Apri giocatore</button>
        </div>
      </section>
    `;
  }

  return `
    <section class="join-shell">
      <div class="panel join-panel stack">
        <div>
          <h1 class="section-title">Accesso host</h1>
          <p class="subtle">Inserisci la password host.</p>
        </div>
        <label class="stack">
          <span>Password</span>
          <input data-field="host-password" type="password" autocomplete="current-password" value="${escapeAttr(local.hostAuth.password)}" />
        </label>
        <div class="toolbar">
          <button class="btn primary" data-action="host-login" ${local.hostAuth.loading ? "disabled" : ""}>Sblocca host</button>
          <button class="btn ghost" data-action="open-player-link">Apri giocatore</button>
        </div>
      </div>
    </section>
  `;
}

function renderQuizBuilder() {
  return `
    <div class="stack">
      <label class="stack">
        <span>Titolo</span>
        <input data-quiz-title value="${escapeAttr(local.quiz.title)}" maxlength="80" />
      </label>
      <div class="grid-4">
        <label class="stack">
          <span>Materia</span>
          <input data-quiz-meta="subject" value="${escapeAttr(local.quiz.subject || "")}" maxlength="40" placeholder="Es. Matematica" />
        </label>
        <label class="stack">
          <span>Livello/Classe</span>
          <input data-quiz-meta="level" value="${escapeAttr(local.quiz.level || "")}" maxlength="40" placeholder="Es. 2 media" />
        </label>
        <label class="stack">
          <span>Lingua</span>
          <input data-quiz-meta="language" value="${escapeAttr(local.quiz.language || "Italiano")}" maxlength="32" />
        </label>
        <label class="stack">
          <span>Tag</span>
          <input data-quiz-tags value="${escapeAttr((local.quiz.tags || []).join(", "))}" maxlength="160" placeholder="ripasso, verifica" />
        </label>
      </div>
      <label class="toggle-row">
        <input data-quiz-team-mode type="checkbox" ${local.quiz.teamMode ? "checked" : ""} />
        <span>Team mode: dividi automaticamente i giocatori in squadre</span>
      </label>
      ${local.quiz.questions.map(renderQuestionEditor).join("")}
    </div>
  `;
}

function renderQuestionEditor(question, questionIndex) {
  const questionType = normalizeQuestionType(question.type);
  const answers = editableAnswers(question);
  const selectedCorrect = Math.min(Math.max(Number(question.correctIndex) || 0, 0), Math.max(answers.length - 1, 0));
  const selectedCorrectIndexes = correctIndexesForQuestion(question, answers);
  return `
    <article class="builder-question stack" data-question-index="${questionIndex}">
      <div class="question-head">
        <strong>Domanda ${questionIndex + 1}</strong>
        <span class="status-pill compact">${escapeHtml(questionTypeLabel(questionType))}</span>
        <button class="btn small ghost" data-action="remove-question" data-question-index="${questionIndex}" ${local.quiz.questions.length <= 1 ? "disabled" : ""}>Rimuovi</button>
      </div>
      <label class="stack">
        <span>Testo domanda</span>
        <textarea data-question-text data-question-index="${questionIndex}" maxlength="240">${escapeHtml(question.text)}</textarea>
      </label>
      <div class="grid-2">
        <label class="stack">
          <span>Immagine URL</span>
          <input data-question-media="imageUrl" data-question-index="${questionIndex}" value="${escapeAttr(question.imageUrl || "")}" maxlength="500" placeholder="https://..." />
        </label>
        <label class="stack">
          <span>Video URL</span>
          <input data-question-media="videoUrl" data-question-index="${questionIndex}" value="${escapeAttr(question.videoUrl || "")}" maxlength="500" placeholder="https://..." />
        </label>
      </div>
      <div class="grid-3">
        <label class="stack">
          <span>Tipo</span>
          <select data-question-type data-question-index="${questionIndex}">
            ${questionTypes.map((type) => `<option value="${type.value}" ${questionType === type.value ? "selected" : ""}>${type.label}</option>`).join("")}
          </select>
        </label>
        <label class="stack">
          <span>Tempo</span>
          <input data-question-time data-question-index="${questionIndex}" type="number" min="5" max="90" value="${question.timeLimit}" />
        </label>
        <label class="stack">
          <span>${questionType === "multiple_select" ? "Risposte da scegliere" : "Risposta corretta"}</span>
          ${questionType === "multiple_select"
            ? `<div class="readonly-field">${selectedCorrectIndexes.length}</div>`
            : `<select data-question-correct data-question-index="${questionIndex}">
                ${answers.map((answer, answerIndex) => `<option value="${answerIndex}" ${selectedCorrect === answerIndex ? "selected" : ""}>${answerLetters[answerIndex]} ${escapeHtml(answer || "")}</option>`).join("")}
              </select>`}
        </label>
      </div>
      <div class="stack">
        ${answers.map((answer, answerIndex) => `
          <div class="answer-editor">
            <span class="answer-key ${letterClass(answerIndex)}">${answerLetters[answerIndex]}</span>
            <input data-answer-text data-question-index="${questionIndex}" data-answer-index="${answerIndex}" value="${escapeAttr(answer)}" maxlength="160" ${questionType === "true_false" ? "readonly" : ""} />
            <label class="radio-label">
              ${questionType === "multiple_select"
                ? `<input type="checkbox" data-correct-checkbox data-question-index="${questionIndex}" data-answer-index="${answerIndex}" ${selectedCorrectIndexes.includes(answerIndex) ? "checked" : ""} />`
                : `<input type="radio" name="correct-${questionIndex}" data-correct-radio data-question-index="${questionIndex}" data-answer-index="${answerIndex}" ${selectedCorrect === answerIndex ? "checked" : ""} />`}
              Corretta
            </label>
          </div>
        `).join("")}
      </div>
    </article>
  `;
}

function renderImportBox() {
  return `
    <div class="panel flat stack">
      <div>
        <h2 class="mini-title">Importa quiz XLSX</h2>
        <p class="subtle">Usa il modello QuizLive, compila le righe in Excel, Numbers o Google Sheets, poi ricarica il file qui.</p>
      </div>
      <input data-field="import-xlsx" type="file" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" />
      <div class="toolbar">
        <button class="btn teal" data-action="apply-import-xlsx">Importa XLSX</button>
        <button class="btn ghost" data-action="download-template-xlsx">Scarica modello</button>
        <button class="btn ghost" data-action="toggle-import">Chiudi</button>
      </div>
    </div>
  `;
}

function renderArchiveBox() {
  return `
    <div class="panel flat stack archive-panel">
      <div class="archive-head">
        <div>
          <h2 class="section-title">Archivio</h2>
          <p class="subtle">Quiz salvati e risultati storici.</p>
        </div>
        <button class="btn small ghost" data-action="refresh-archive" ${local.archiveLoading ? "disabled" : ""}>Aggiorna</button>
      </div>
      <input data-archive-search value="${escapeAttr(local.archiveSearch)}" placeholder="Cerca titolo, materia, livello, lingua o tag" />
      ${local.archiveLoading ? `<div class="empty compact">Caricamento archivio...</div>` : `
        <div class="archive-grid">
          <section class="stack">
            <h3 class="mini-title">Quiz salvati</h3>
            ${renderSavedQuizzes()}
          </section>
          <section class="stack">
            <h3 class="mini-title">Risultati</h3>
            ${renderSavedResults()}
          </section>
        </div>
      `}
    </div>
  `;
}

function renderSavedQuizzes() {
  const quizzes = filteredSavedQuizzes();
  if (!quizzes.length) return `<div class="empty compact">Nessun quiz salvato</div>`;
  return `
    <div class="archive-list">
      ${quizzes.map((item) => `
        <article class="archive-item">
          <div>
            <strong>${escapeHtml(item.title)}</strong>
            <p class="subtle">${renderQuizMetaLine(item.quiz)}${item.questionCount} domande - ${formatDate(item.updatedAt)}</p>
          </div>
          <div class="toolbar">
            <button class="btn small ghost" data-action="load-saved-quiz" data-quiz-id="${escapeAttr(item.id)}">Carica</button>
            <button class="btn small ghost" data-action="duplicate-saved-quiz" data-quiz-id="${escapeAttr(item.id)}">Duplica</button>
            <button class="btn small ghost danger" data-action="delete-saved-quiz" data-quiz-id="${escapeAttr(item.id)}">Elimina</button>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderSavedResults() {
  if (!local.savedResults.length) return `<div class="empty compact">Nessun risultato salvato</div>`;
  return `
    <div class="archive-list">
      ${local.savedResults.map((item) => `
        <article class="archive-item">
          <div>
            <strong>${escapeHtml(item.title)}</strong>
            <p class="subtle">Stanza ${escapeHtml(item.code)} - ${item.playerCount} giocatori - ${formatDate(item.endedAt)}</p>
          </div>
          <div class="toolbar">
            <a class="btn small ghost" href="/api/archive/results/${escapeAttr(item.id)}.csv">CSV</a>
            <a class="btn small ghost" href="/api/archive/results/${escapeAttr(item.id)}.json">JSON</a>
            <button class="btn small ghost danger" data-action="delete-saved-result" data-result-id="${escapeAttr(item.id)}">Elimina</button>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function filteredSavedQuizzes() {
  const query = normalizeSearch(local.archiveSearch);
  if (!query) return local.savedQuizzes;
  return local.savedQuizzes.filter((item) => normalizeSearch([
    item.title,
    item.quiz && item.quiz.subject,
    item.quiz && item.quiz.level,
    item.quiz && item.quiz.language,
    item.quiz && Array.isArray(item.quiz.tags) ? item.quiz.tags.join(" ") : ""
  ].join(" ")).includes(query));
}

function renderQuizMetaLine(quiz) {
  const parts = [
    quiz && quiz.subject,
    quiz && quiz.level,
    quiz && quiz.language,
    quiz && quiz.teamMode ? "Team mode" : ""
  ].filter(Boolean);
  const tags = quiz && Array.isArray(quiz.tags) ? quiz.tags : [];
  return `${[...parts, ...tags.map((tag) => `#${tag}`)].map(escapeHtml).join(" - ")}${parts.length || tags.length ? " - " : ""}`;
}

function renderHostGame(room) {
  const question = room.question;
  const pendingText = room.pendingInviteCount
    ? `${room.playerCount} in lobby - ${room.pendingInviteCount} inviti in attesa`
    : `${room.playerCount} in lobby o partita`;
  return `
    <section class="game-layout">
      <div class="stage">
        ${room.status === "lobby" ? renderHostLobby(room) : ""}
        ${room.status === "question" && question ? renderHostQuestion(room) : ""}
        ${room.status === "reveal" && question ? renderReveal(room, true) : ""}
        ${room.status === "ended" ? renderEnded(room, true) : ""}
      </div>
      <aside class="panel stack">
        <div class="toolbar">
          ${room.exports ? `<a class="btn ghost" href="${room.exports.csv}">CSV</a><a class="btn ghost" href="${room.exports.json}">JSON</a>` : ""}
          ${room.status === "ended" ? `<button class="btn ghost" data-action="release-screens">Monitor in attesa</button>` : ""}
          <button class="btn ghost" data-action="reset-room">Reset</button>
        </div>
        <div>
          <h2 class="section-title">Giocatori</h2>
          <p class="subtle">${escapeHtml(pendingText)}</p>
        </div>
        ${renderTeamLeaderboard(room)}
        ${renderHostPlayers(room)}
      </aside>
    </section>
  `;
}

function renderHostLobby(room) {
  return `
    <div class="panel stack">
      <div>
        <h1 class="section-title">Codice ${escapeHtml(room.code)}</h1>
        <p class="subtle">${room.pendingInviteCount ? `Inviti inviati: ${room.pendingInviteCount} in attesa.` : `Pronto per ${room.totalQuestions} domande.`}</p>
      </div>
      <div class="qr-panel">
        <img class="qr-code" src="${escapeAttr(qrCodeSrc(room.code))}" alt="QR code ingresso giocatori" />
        <div class="qr-meta">
          <span class="status-pill">Codice ${escapeHtml(room.code)}</span>
          <span class="status-pill ${playerAccessClass()}">${escapeHtml(playerBaseLabel())}</span>
          <button class="btn ghost" data-action="copy-player-link">Copia link</button>
          <button class="btn ghost" data-action="open-player-link">Apri giocatore</button>
          <button class="btn ghost" data-action="copy-screen-link">Copia monitor</button>
          <button class="btn ghost" data-action="open-screen-link">Apri monitor</button>
          ${renderCastScreenButton()}
        </div>
        <p class="qr-note ${playerAccessClass()}">${escapeHtml(playerAccessNotice())}</p>
      </div>
      <div class="toolbar">
        <button class="btn primary" data-action="start-game" ${room.totalQuestions < 1 ? "disabled" : ""}>Avvia quiz</button>
      </div>
    </div>
  `;
}

function renderScreenGame(room) {
  const question = room.question;
  return `
    <section class="screen-layout">
      ${room.status === "lobby" ? renderScreenLobby(room) : ""}
      ${room.status === "question" && question ? renderScreenQuestion(room) : ""}
      ${room.status === "reveal" && question ? renderScreenReveal(room) : ""}
      ${room.status === "ended" ? renderScreenEnded(room) : ""}
    </section>
  `;
}

function renderScreenLobby(room) {
  return `
    <div class="panel screen-panel screen-lobby stack">
      <div>
        <p class="screen-kicker">${escapeHtml(room.title)}</p>
        <h1 class="screen-code">${escapeHtml(room.code)}</h1>
        <p class="subtle">Inquadra il QR o entra con il codice stanza.</p>
      </div>
      <div class="screen-lobby-grid">
        <img class="qr-code screen-qr" src="${escapeAttr(qrCodeSrc(room.code))}" alt="QR code ingresso giocatori" />
        <div class="screen-lobby-meta">
          <span class="status-pill ${playerAccessClass()}">${escapeHtml(playerBaseLabel())}</span>
          <span class="status-pill">${room.playerCount} giocatori</span>
          <span class="status-pill">${room.totalQuestions} domande</span>
          ${room.teamMode ? `<span class="status-pill">Team mode</span>` : ""}
        </div>
      </div>
    </div>
  `;
}

function renderScreenQuestion(room) {
  const question = room.question;
  return `
    <article class="question-card screen-question">
      <div class="question-main">
        <p class="screen-kicker">Domanda ${room.currentIndex + 1}/${room.totalQuestions}</p>
        <h1 class="screen-title">${escapeHtml(question.text)}</h1>
        <div class="meta-row">
          ${renderTimer(room)}
          <span class="status-pill">${escapeHtml(question.typeLabel || questionTypeLabel(question.type))}</span>
          ${renderSelectionPill(question)}
          <span class="status-pill">${room.answerCount}/${room.playerCount} risposte</span>
        </div>
      </div>
      ${renderQuestionMedia(question)}
      <div class="answers-grid screen-answers">
        ${question.answers.map(renderAnswerDisplay).join("")}
      </div>
    </article>
  `;
}

function renderScreenReveal(room) {
  const question = room.question;
  return `
    <article class="question-card screen-question">
      <div class="question-main">
        <p class="screen-kicker">Risultati domanda ${room.currentIndex + 1}/${room.totalQuestions}</p>
        <h1 class="screen-title">${escapeHtml(question.text)}</h1>
        <div class="meta-row">
          <span class="status-pill">${escapeHtml(question.typeLabel || questionTypeLabel(question.type))}</span>
          ${renderSelectionPill(question)}
          <span class="status-pill">${room.answerCount}/${room.playerCount} risposte</span>
        </div>
      </div>
      ${renderQuestionMedia(question)}
      <div class="answers-grid screen-answers">
        ${question.answers.map((answer) => renderAnswerStat(answer, room.playerCount)).join("")}
      </div>
      ${renderTopLeaderboardStrip(room)}
    </article>
  `;
}

function renderScreenEnded(room) {
  return `
    <div class="panel screen-panel screen-final stack">
      <div>
        <p class="screen-kicker">${escapeHtml(room.title)}</p>
        <h1 class="screen-title">Classifica finale</h1>
      </div>
      <div class="screen-podium-wrap">
        ${renderPodium(room)}
      </div>
      <div class="screen-final-board">
        ${renderTeamLeaderboard(room)}
        ${renderLeaderboard(room)}
      </div>
    </div>
  `;
}

function renderQuestionMedia(question) {
  const imageUrl = question && question.imageUrl ? String(question.imageUrl) : "";
  const videoUrl = question && question.videoUrl ? String(question.videoUrl) : "";
  if (!imageUrl && !videoUrl) return "";
  const videoEmbed = videoUrl ? videoEmbedUrl(videoUrl) : "";
  return `
    <div class="question-media">
      ${imageUrl ? `<img src="${escapeAttr(imageUrl)}" alt="" loading="lazy" />` : ""}
      ${videoUrl ? videoEmbed
        ? `<iframe src="${escapeAttr(videoEmbed)}" title="Video domanda" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`
        : `<video src="${escapeAttr(videoUrl)}" controls playsinline></video>` : ""}
    </div>
  `;
}

function videoEmbedUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname.includes("youtube.com")) {
      const id = parsed.searchParams.get("v");
      return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}` : "";
    }
    if (parsed.hostname === "youtu.be") {
      const id = parsed.pathname.replace(/^\//, "");
      return id ? `https://www.youtube.com/embed/${encodeURIComponent(id)}` : "";
    }
  } catch (error) {
    return "";
  }
  return "";
}

function renderTimer(room) {
  const left = secondsLeft(room);
  const percent = timeProgressPercent(room);
  return `
    <div class="countdown ${left <= 5 ? "urgent" : ""}" data-countdown data-ends-at="${escapeAttr(room.questionEndsAt || "")}" data-time-limit="${escapeAttr(room.question ? room.question.timeLimit : 0)}">
      <div class="timer" data-timer>${left}</div>
      <div class="time-track" aria-hidden="true"><span data-time-bar style="width:${percent}%"></span></div>
    </div>
  `;
}

function renderSelectionPill(question) {
  if (!question || question.type !== "multiple_select") return "";
  const count = selectionCount(question);
  return `<span class="status-pill">Scegli ${count} risposte</span>`;
}

function renderSubmitMultiple(question) {
  const required = selectionCount(question);
  const selected = local.selectedAnswers.length;
  const missing = Math.max(0, required - selected);
  return `
    <div class="answer-submit stack">
      <div class="multi-helper">
        <strong>${selected}/${required} selezionate</strong>
        <span>${missing ? `Scegline ancora ${missing}` : "Puoi inviare adesso"}</span>
      </div>
      <div class="toolbar">
        <button class="btn primary" data-action="submit-multiple-answer" ${selected !== required ? "disabled" : ""}>Invia risposte</button>
        <span class="subtle">Tocca una risposta selezionata per deselezionarla.</span>
      </div>
    </div>
  `;
}

function renderHostQuestion(room) {
  const question = room.question;
  return `
    <article class="question-card">
      <div class="question-main">
        <h1 class="question-title">${escapeHtml(question.text)}</h1>
        <div class="meta-row">
          ${renderTimer(room)}
          <span class="status-pill">${escapeHtml(question.typeLabel || questionTypeLabel(question.type))}</span>
          ${renderSelectionPill(question)}
          <span class="status-pill">Domanda ${room.currentIndex + 1}/${room.totalQuestions}</span>
          <span class="status-pill">${room.answerCount}/${room.playerCount} risposte</span>
        </div>
      </div>
      ${renderQuestionMedia(question)}
      <div class="answers-grid">
        ${question.answers.map((answer) => renderAnswerStat(answer, room.playerCount)).join("")}
      </div>
    </article>
    <div class="toolbar">
      <button class="btn gold" data-action="reveal-question">Mostra risposta</button>
    </div>
  `;
}

function renderPlayerGame(room) {
  const question = room.question;
  if (room.player && room.player.rematch === "pending") return renderPlayerRematch(room);
  if (room.player && room.player.active === false) return renderPlayerExcluded(room);
  return `
    <section class="game-layout">
      <div class="stage">
        ${room.status === "lobby" ? renderPlayerWaiting(room) : ""}
        ${room.status === "question" && question ? renderPlayerQuestion(room) : ""}
        ${room.status === "reveal" && question ? renderReveal(room, false) : ""}
        ${room.status === "ended" ? renderEnded(room, false) : ""}
      </div>
      <aside class="panel stack">
        <div>
          <h2 class="section-title">${escapeHtml(room.player ? room.player.nickname : "Player")}</h2>
          <p class="subtle">Punti ${room.player ? room.player.score : 0} - Rank ${room.player && room.player.rank ? room.player.rank : "-"}</p>
        </div>
        ${renderLeaderboard(room)}
      </aside>
    </section>
  `;
}

function renderPlayerRematch(room) {
  return `
    <section class="join-shell">
      <div class="panel join-panel stack">
        <div>
          <h1 class="section-title">Giochi un'altra?</h1>
          <p class="subtle">L'host ha preparato una nuova partita. Conferma per rientrare in lobby.</p>
        </div>
        <div class="toolbar">
          <button class="btn primary" data-action="accept-rematch">Partecipo</button>
          <button class="btn ghost" data-action="decline-rematch">Salto</button>
        </div>
        <p class="subtle">Codice ${escapeHtml(room.code)}</p>
      </div>
    </section>
  `;
}

function renderPlayerExcluded(room) {
  return `
    <section class="join-shell">
      <div class="panel join-panel stack">
        <div>
          <h1 class="section-title">Non sei in questa partita</h1>
          <p class="subtle">La nuova lobby include solo chi ha accettato l'invito.</p>
        </div>
        <button class="btn teal" data-action="leave-room">Torna all'ingresso</button>
        <p class="subtle">Codice ${escapeHtml(room.code)}</p>
      </div>
    </section>
  `;
}

function renderPlayerWaiting(room) {
  return `
    <div class="panel stack">
      <h1 class="section-title">Sei dentro</h1>
      <p class="subtle">Codice ${escapeHtml(room.code)} - in attesa dell'host.</p>
      ${room.player && room.player.team ? `<span class="team-pill">${escapeHtml(room.player.team)}</span>` : ""}
    </div>
  `;
}

function renderPlayerQuestion(room) {
  const question = room.question;
  return `
    <article class="question-card">
      <div class="question-main">
        <h1 class="question-title">${escapeHtml(question.text)}</h1>
        <div class="meta-row">
          ${renderTimer(room)}
          <span class="status-pill">${escapeHtml(question.typeLabel || questionTypeLabel(question.type))}</span>
          ${renderSelectionPill(question)}
          <span class="status-pill">Domanda ${room.currentIndex + 1}/${room.totalQuestions}</span>
          ${question.answered ? `<span class="status-pill">Risposta inviata</span>` : ""}
        </div>
      </div>
      ${renderQuestionMedia(question)}
      <div class="answers-grid">
        ${question.answers.map((answer) => renderAnswerButton(answer, question)).join("")}
      </div>
    </article>
    ${question.type === "multiple_select" && !question.answered ? renderSubmitMultiple(question) : ""}
  `;
}

function renderReveal(room, isHost) {
  const question = room.question;
  const playerAnswer = question.playerAnswer;
  const correct = playerAnswer && playerAnswer.correct;
  const partial = playerAnswer && playerAnswer.partial;
  return `
    <article class="question-card">
      <div class="question-main">
        <h1 class="question-title">${escapeHtml(question.text)}</h1>
        <div class="meta-row">
          <span class="status-pill">${correct ? "Corretta" : partial ? "Parziale" : isHost ? "Risultati" : "Risposta mostrata"}</span>
          <span class="status-pill">${escapeHtml(question.typeLabel || questionTypeLabel(question.type))}</span>
          ${renderSelectionPill(question)}
          ${playerAnswer ? `<span class="status-pill">+${playerAnswer.points} punti</span>` : ""}
          <span class="status-pill">${room.answerCount}/${room.playerCount} risposte</span>
        </div>
      </div>
      ${renderQuestionMedia(question)}
      <div class="answers-grid">
        ${question.answers.map((answer) => isHost ? renderAnswerStat(answer, room.playerCount) : renderAnswerButton(answer, question, true)).join("")}
      </div>
    </article>
    ${isHost ? `<div class="toolbar"><button class="btn primary" data-action="next-question">${room.currentIndex + 1 >= room.totalQuestions ? "Classifica finale" : "Prossima domanda"}</button></div>` : ""}
  `;
}

function renderEnded(room, isHost) {
  return `
    <div class="panel stack">
      <div>
        <h1 class="section-title">Classifica finale</h1>
        <p class="subtle">${escapeHtml(room.title)}</p>
      </div>
      ${renderTeamLeaderboard(room)}
      ${renderPodium(room)}
      ${renderLeaderboard(room)}
      ${isHost ? `<div class="toolbar"><button class="btn ghost" data-action="reset-room">Nuova partita</button></div>` : ""}
    </div>
  `;
}

function renderPodium(room) {
  const top = room.leaderboard.slice(0, 3);
  if (!top.length) return `<div class="empty">Nessun giocatore</div>`;
  return `
    <div class="podium">
      ${top.map((player, index) => `
        <div class="podium-place">
          <div class="podium-rank">${index + 1}</div>
          <strong>${escapeHtml(player.nickname)}</strong>
          <span>${player.score} punti</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderTopLeaderboardStrip(room) {
  const top = room.leaderboard.slice(0, 3);
  if (!top.length) return "";
  return `
    <div class="screen-strip">
      ${top.map((player, index) => `
        <div class="screen-strip-item">
          <span class="rank">${index + 1}</span>
          <strong>${escapeHtml(player.nickname)}</strong>
          <span>${player.score}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderHostPlayers(room) {
  if (!room.players || !room.players.length) return `<div class="empty">Nessun giocatore ancora</div>`;
  return `
    <div class="side-list">
      ${room.players.map((player) => `
        <div class="player-row">
          <span class="dot ${player.answered ? "answered" : player.connected ? "on" : ""}"></span>
          <span class="name">${escapeHtml(player.nickname)} ${player.team ? `<span class="team-pill">${escapeHtml(player.team)}</span>` : ""}</span>
          <span class="score">${player.score}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderLeaderboard(room) {
  if (!room.leaderboard || !room.leaderboard.length) return `<div class="empty">Classifica vuota</div>`;
  const selfId = room.player && room.player.id;
  return `
    <div class="side-list">
      ${room.leaderboard.map((player, index) => `
        <div class="leader-row ${player.id === selfId ? "self" : ""}">
          <span class="rank">${index + 1}</span>
          <span class="name">${escapeHtml(player.nickname)} ${player.team ? `<span class="team-pill">${escapeHtml(player.team)}</span>` : ""}</span>
          <span class="score">${player.score}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderTeamLeaderboard(room) {
  if (!room.teamLeaderboard || !room.teamLeaderboard.length) return "";
  return `
    <div class="team-board">
      ${room.teamLeaderboard.map((item, index) => `
        <div class="team-row">
          <span class="rank">${index + 1}</span>
          <span class="name">${escapeHtml(item.team)} <span class="subtle">${item.playerCount} giocatori</span></span>
          <span class="score">${item.score}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderAnswerButton(answer, question, reveal = false) {
  const playerIndexes = question.playerAnswer && Array.isArray(question.playerAnswer.answerIndexes)
    ? question.playerAnswer.answerIndexes
    : question.playerAnswer
      ? [question.playerAnswer.answerIndex]
      : [];
  const selected = local.selectedAnswer === answer.index ||
    local.selectedAnswers.includes(answer.index) ||
    playerIndexes.includes(answer.index);
  const hasMark = reveal && typeof answer.correct === "boolean";
  const correct = hasMark && answer.correct;
  const wrong = hasMark && !answer.correct;
  return `
    <button class="answer-btn ${answerClasses[answer.index]} ${selected ? "selected" : ""} ${hasMark ? "with-mark" : ""} ${correct ? "correct" : ""} ${wrong ? "wrong" : ""}"
      data-action="answer"
      data-answer-index="${answer.index}"
      ${question.answered || reveal ? "disabled" : ""}>
      <span class="letter">${answerLetters[answer.index]}</span>
      <span class="answer-text">${escapeHtml(answer.text)}</span>
      ${question.type === "multiple_select" && selected && !reveal ? `<span class="answer-selected-label">Selezionata</span>` : ""}
      ${renderAnswerMark(answer.correct, hasMark)}
    </button>
  `;
}

function renderAnswerDisplay(answer) {
  return `
    <div class="answer-stat ${answerClasses[answer.index]}">
      <span class="letter">${answerLetters[answer.index]}</span>
      <span class="answer-text">${escapeHtml(answer.text)}</span>
    </div>
  `;
}

function renderAnswerStat(answer, playerCount) {
  const percent = playerCount ? Math.round((Number(answer.count || 0) / playerCount) * 100) : 0;
  const hasMark = typeof answer.correct === "boolean";
  return `
    <div class="answer-stat ${answerClasses[answer.index]} ${answer.correct ? "correct" : ""} ${hasMark && !answer.correct ? "incorrect" : ""}">
      <span class="letter">${answerLetters[answer.index]}</span>
      <span class="answer-text">${escapeHtml(answer.text)} - ${answer.count || 0}</span>
      ${renderAnswerMark(answer.correct, hasMark)}
      <span class="stat-bar"><span style="width:${percent}%"></span></span>
    </div>
  `;
}

function renderAnswerMark(correct, visible) {
  if (!visible) return "";
  return `<span class="answer-mark ${correct ? "ok" : "no"}" aria-label="${correct ? "Corretta" : "Sbagliata"}">${correct ? "&#10003;" : "&times;"}</span>`;
}

function bindEvents() {
  document.querySelectorAll("[data-action]").forEach((element) => {
    element.addEventListener("click", handleAction);
  });
  document.querySelectorAll("[data-quiz-title]").forEach((element) => {
    element.addEventListener("input", () => {
      local.quiz.title = element.value;
    });
  });
  document.querySelectorAll("[data-quiz-meta]").forEach((element) => {
    element.addEventListener("input", () => {
      local.quiz[element.dataset.quizMeta] = element.value;
    });
  });
  document.querySelectorAll("[data-quiz-tags]").forEach((element) => {
    element.addEventListener("input", () => {
      local.quiz.tags = parseTags(element.value);
    });
  });
  document.querySelectorAll("[data-quiz-team-mode]").forEach((element) => {
    element.addEventListener("change", () => {
      local.quiz.teamMode = element.checked;
    });
  });
  document.querySelectorAll("[data-question-text]").forEach((element) => {
    element.addEventListener("input", () => {
      local.quiz.questions[Number(element.dataset.questionIndex)].text = element.value;
    });
  });
  document.querySelectorAll("[data-question-media]").forEach((element) => {
    element.addEventListener("input", () => {
      const question = local.quiz.questions[Number(element.dataset.questionIndex)];
      question[element.dataset.questionMedia] = element.value;
    });
  });
  document.querySelectorAll("[data-question-time]").forEach((element) => {
    element.addEventListener("input", () => {
      local.quiz.questions[Number(element.dataset.questionIndex)].timeLimit = Number(element.value);
    });
  });
  document.querySelectorAll("[data-archive-search]").forEach((element) => {
    element.addEventListener("input", () => {
      local.archiveSearch = element.value;
      render();
    });
  });
  document.querySelectorAll("[data-question-type]").forEach((element) => {
    element.addEventListener("change", () => {
      const question = local.quiz.questions[Number(element.dataset.questionIndex)];
      question.type = normalizeQuestionType(element.value);
      if (question.type === "true_false") {
        question.answers = ["Vero", "Falso"];
        question.correctIndex = Math.min(Number(question.correctIndex) || 0, 1);
        question.correctIndexes = [question.correctIndex];
      } else if (question.type === "multiple_select") {
        question.answers = question.answers && question.answers.length >= 2 ? question.answers : ["Risposta A", "Risposta B", "Risposta C", "Risposta D"];
        question.correctIndexes = correctIndexesForQuestion(question, editableAnswers(question));
      } else if (!question.answers || question.answers.length < 2) {
        question.answers = ["Risposta A", "Risposta B", "Risposta C", "Risposta D"];
        question.correctIndexes = [Number(question.correctIndex) || 0];
      }
      render();
    });
  });
  document.querySelectorAll("[data-answer-text]").forEach((element) => {
    element.addEventListener("input", () => {
      const question = local.quiz.questions[Number(element.dataset.questionIndex)];
      question.answers[Number(element.dataset.answerIndex)] = element.value;
    });
  });
  document.querySelectorAll("[data-correct-radio], [data-question-correct]").forEach((element) => {
    element.addEventListener("change", () => {
      const question = local.quiz.questions[Number(element.dataset.questionIndex)];
      question.correctIndex = Number(element.dataset.answerIndex || element.value);
      question.correctIndexes = [question.correctIndex];
      render();
    });
  });
  document.querySelectorAll("[data-correct-checkbox]").forEach((element) => {
    element.addEventListener("change", () => {
      const question = local.quiz.questions[Number(element.dataset.questionIndex)];
      const answerIndex = Number(element.dataset.answerIndex);
      const current = correctIndexesForQuestion(question, editableAnswers(question));
      if (element.checked) {
        question.correctIndexes = Array.from(new Set([...current, answerIndex])).sort((a, b) => a - b);
      } else if (current.length > 2) {
        question.correctIndexes = current.filter((index) => index !== answerIndex);
      } else {
        showToast("Servono almeno 2 corrette");
      }
      question.correctIndex = question.correctIndexes[0] || 0;
      render();
    });
  });
  const importField = document.querySelector("[data-field='import-json']");
  if (importField) {
    importField.addEventListener("input", () => {
      local.importText = importField.value;
    });
  }
  const joinCodeField = document.querySelector("[data-field='join-code']");
  if (joinCodeField) {
    joinCodeField.addEventListener("input", () => {
      local.joinCode = joinCodeField.value.replace(/\D/g, "").slice(0, 6);
      joinCodeField.value = local.joinCode;
    });
  }
  const joinNameField = document.querySelector("[data-field='join-name']");
  if (joinNameField) {
    joinNameField.addEventListener("input", () => {
      local.nickname = joinNameField.value;
    });
  }
  const screenCodeField = document.querySelector("[data-field='screen-code']");
  if (screenCodeField) {
    screenCodeField.addEventListener("input", () => {
      local.screenCode = screenCodeField.value.replace(/\D/g, "").slice(0, 6);
      screenCodeField.value = local.screenCode;
    });
    screenCodeField.addEventListener("keydown", (event) => {
      if (event.key === "Enter") joinScreen();
    });
  }
  const hostPasswordField = document.querySelector("[data-field='host-password']");
  if (hostPasswordField) {
    hostPasswordField.addEventListener("input", () => {
      local.hostAuth.password = hostPasswordField.value;
    });
    hostPasswordField.addEventListener("keydown", (event) => {
      if (event.key === "Enter") hostLogin();
    });
  }
}

function handleAction(event) {
  const action = event.currentTarget.dataset.action;
  const target = event.currentTarget;

  if (action === "add-question") addQuestion();
  if (action === "remove-question") removeQuestion(Number(target.dataset.questionIndex));
  if (action === "toggle-import") {
    local.importOpen = !local.importOpen;
    local.importText = local.importText || JSON.stringify(local.quiz, null, 2);
    render();
  }
  if (action === "toggle-archive") toggleArchive();
  if (action === "refresh-archive") loadArchive();
  if (action === "apply-import") applyImport();
  if (action === "apply-import-xlsx") importQuizXlsx();
  if (action === "save-quiz") saveQuiz();
  if (action === "load-saved-quiz") loadSavedQuiz(target.dataset.quizId);
  if (action === "duplicate-saved-quiz") duplicateSavedQuiz(target.dataset.quizId);
  if (action === "delete-saved-quiz") deleteSavedQuiz(target.dataset.quizId);
  if (action === "delete-saved-result") deleteSavedResult(target.dataset.resultId);
  if (action === "download-quiz") downloadJson("quizlive-quiz.json", cleanQuiz(local.quiz));
  if (action === "download-template-xlsx") downloadQuizTemplate();
  if (action === "download-quiz-xlsx") downloadQuizXlsx();
  if (action === "switch-host") {
    switchMode("host");
    loadHostAuth();
  }
  if (action === "switch-join") switchMode("join");
  if (action === "host-login") hostLogin();
  if (action === "host-logout") hostLogout();
  if (action === "copy-player-link") copyPlayerLink();
  if (action === "open-player-link") openPlayerLink();
  if (action === "open-waiting-screen") openWaitingScreen();
  if (action === "copy-screen-link") copyScreenLink();
  if (action === "open-screen-link") openScreenLink();
  if (action === "cast-screen") castScreenToTv();
  if (action === "disconnect-screen-cast") disconnectScreenFromTv();
  if (action === "join-screen") joinScreen();
  if (action === "create-room") createRoom();
  if (action === "quick-start-room") createRoom(true);
  if (action === "join-room") joinRoom();
  if (action === "start-game") emitHost("host:start");
  if (action === "reveal-question") emitHost("host:reveal");
  if (action === "next-question") emitHost("host:next");
  if (action === "reset-room") emitHost("host:reset");
  if (action === "release-screens") releaseScreens();
  if (action === "answer") answer(Number(target.dataset.answerIndex));
  if (action === "submit-multiple-answer") submitMultipleAnswer();
  if (action === "accept-rematch") respondRematch(true);
  if (action === "decline-rematch") respondRematch(false);
  if (action === "leave-room") leaveRoomLocally("Puoi rientrare con codice e nickname");
}

function addQuestion() {
  local.quiz.questions.push({
    type: "multiple",
    text: "Nuova domanda",
    answers: ["Risposta A", "Risposta B", "Risposta C", "Risposta D"],
    correctIndex: 0,
    timeLimit: 20
  });
  render();
}

function removeQuestion(index) {
  if (local.quiz.questions.length <= 1) return;
  local.quiz.questions.splice(index, 1);
  render();
}

function applyImport() {
  try {
    const parsed = JSON.parse(local.importText);
    local.quiz = cleanQuiz(parsed);
    local.currentQuizId = null;
    local.importOpen = false;
    showToast("Quiz importato");
    render();
  } catch (error) {
    showToast("JSON non valido");
  }
}

async function importQuizXlsx() {
  const input = document.querySelector("[data-field='import-xlsx']");
  const file = input && input.files && input.files[0];
  if (!file) {
    showToast("Scegli un file XLSX");
    return;
  }

  try {
    const dataUrl = await readFileAsDataUrl(file);
    const response = await fetch("/api/quiz/import.xlsx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ file: dataUrl })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Import non riuscito");
    local.quiz = cleanQuiz(data.quiz);
    local.currentQuizId = null;
    local.importOpen = false;
    showToast("Quiz XLSX importato");
    render();
  } catch (error) {
    showToast(error.message || "Import XLSX non riuscito");
  }
}

async function downloadQuizTemplate() {
  await downloadUrl("/api/quiz-template.xlsx", "quizlive-modello.xlsx", "Modello XLSX scaricato");
}

async function downloadQuizXlsx() {
  const quiz = cleanQuiz(local.quiz);
  if (!quiz.questions.length) {
    showToast("Aggiungi almeno una domanda");
    return;
  }

  try {
    const response = await fetch("/api/quiz/export.xlsx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ quiz })
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Export non riuscito");
    }
    await downloadBlobResponse(response, "quizlive.xlsx");
    showToast("Quiz XLSX esportato");
  } catch (error) {
    showToast(error.message || "Export XLSX non riuscito");
  }
}

async function downloadUrl(url, fallbackName, successMessage) {
  try {
    const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error("Download non riuscito");
    await downloadBlobResponse(response, fallbackName);
    showToast(successMessage);
  } catch (error) {
    showToast(error.message || "Download non riuscito");
  }
}

async function downloadBlobResponse(response, fallbackName) {
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : fallbackName;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("File non leggibile"));
    reader.readAsDataURL(file);
  });
}

function toggleArchive() {
  local.archiveOpen = !local.archiveOpen;
  render();
  if (local.archiveOpen) loadArchive();
}

async function loadArchive() {
  local.archiveLoading = true;
  render();
  try {
    const [quizResponse, resultResponse] = await Promise.all([
      fetch("/api/archive/quizzes", { cache: "no-store", credentials: "same-origin" }),
      fetch("/api/archive/results", { cache: "no-store", credentials: "same-origin" })
    ]);
    if (!quizResponse.ok || !resultResponse.ok) throw new Error("Archivio non disponibile");
    const quizData = await quizResponse.json();
    const resultData = await resultResponse.json();
    local.savedQuizzes = Array.isArray(quizData.quizzes) ? quizData.quizzes : [];
    local.savedResults = Array.isArray(resultData.results) ? resultData.results : [];
  } catch (error) {
    showToast("Archivio non disponibile");
  } finally {
    local.archiveLoading = false;
    render();
  }
}

async function saveQuiz() {
  const quiz = cleanQuiz(local.quiz);
  if (!quiz.questions.length) {
    showToast("Aggiungi almeno una domanda");
    return;
  }

  try {
    const response = await fetch("/api/archive/quizzes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ id: local.currentQuizId, quiz })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Salvataggio non riuscito");
    local.currentQuizId = data.quiz.id;
    local.quiz = cleanQuiz(data.quiz.quiz);
    showToast("Quiz salvato");
    if (local.archiveOpen) loadArchive();
  } catch (error) {
    showToast(error.message || "Salvataggio non riuscito");
  }
}

function loadSavedQuiz(id) {
  const item = local.savedQuizzes.find((quiz) => quiz.id === id);
  if (!item || !item.quiz) {
    showToast("Quiz non trovato");
    return;
  }
  local.quiz = cleanQuiz(item.quiz);
  local.currentQuizId = item.id;
  showToast("Quiz caricato");
  render();
}

function duplicateSavedQuiz(id) {
  const item = local.savedQuizzes.find((quiz) => quiz.id === id);
  if (!item || !item.quiz) {
    showToast("Quiz non trovato");
    return;
  }
  local.quiz = cleanQuiz({
    ...item.quiz,
    title: `${item.quiz.title || item.title} copia`
  });
  local.currentQuizId = null;
  showToast("Quiz duplicato come bozza");
  render();
}

async function deleteSavedQuiz(id) {
  if (!id) return;
  try {
    const response = await fetch(`/api/archive/quizzes/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "same-origin"
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Eliminazione non riuscita");
    if (local.currentQuizId === id) local.currentQuizId = null;
    showToast("Quiz eliminato");
    loadArchive();
  } catch (error) {
    showToast(error.message || "Eliminazione non riuscita");
  }
}

async function deleteSavedResult(id) {
  if (!id) return;
  try {
    const response = await fetch(`/api/archive/results/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "same-origin"
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Eliminazione non riuscita");
    showToast("Risultato eliminato");
    loadArchive();
  } catch (error) {
    showToast(error.message || "Eliminazione non riuscita");
  }
}

function createRoom(quickStart = false) {
  if (!hostAccessGranted()) {
    showToast("Password host richiesta");
    render();
    return;
  }

  const quiz = cleanQuiz(local.quiz);
  if (!quiz.questions.length) {
    showToast("Aggiungi almeno una domanda");
    return;
  }
  socket.emit("host:create", { quiz }, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Errore creazione stanza");
      return;
    }
    switchMode("host", true);
    showToast(`Stanza ${response.code} creata`);
    if (quickStart) emitHost("host:start");
  });
}

function joinRoom() {
  const codeField = document.querySelector("[data-field='join-code']");
  const nameField = document.querySelector("[data-field='join-name']");
  const code = codeField ? codeField.value : local.joinCode;
  const nickname = nameField ? nameField.value : local.nickname;
  socket.emit("player:join", { code, nickname }, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Impossibile entrare");
      return;
    }
    showToast("Entrato");
  });
}

function joinScreen() {
  const codeField = document.querySelector("[data-field='screen-code']");
  const code = codeField ? codeField.value : local.screenCode;
  const normalizedCode = String(code || "").replace(/\D/g, "").slice(0, 6);
  if (normalizedCode.length !== 6) {
    showToast("Inserisci codice stanza");
    return;
  }

  local.screenCode = normalizedCode;
  local.screenJoining = true;
  local.screenWaiting = false;
  switchMode("screen", true);
  socket.emit("screen:join", { code: normalizedCode }, (response) => {
    local.screenJoining = false;
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Monitor non disponibile");
      render();
      return;
    }
    showToast("Monitor collegato");
  });
  render();
}

function watchScreen() {
  if (local.screenJoining || local.screenWaiting || !socket.connected) return;
  local.screenJoining = true;
  socket.emit("screen:watch", {}, (response) => {
    local.screenJoining = false;
    local.screenWaiting = Boolean(response && response.ok && response.waiting);
    if (!response || !response.ok) showToast("Monitor non disponibile");
    render();
  });
  render();
}

function enterScreenWaiting() {
  local.room = null;
  local.mode = "screen";
  local.screenCode = "";
  local.screenJoining = false;
  local.screenWaiting = true;
  local.selectedAnswer = null;
  window.history.replaceState(null, "", "#screen");
  render();
}

function switchMode(mode, silent = false) {
  local.mode = mode;
  if (mode === "host") {
    window.history.replaceState(null, "", "#host");
  } else if (mode === "screen") {
    const code = local.screenCode ? `=${encodeURIComponent(local.screenCode)}` : "";
    window.history.replaceState(null, "", `#screen${code}`);
  } else {
    const code = local.joinCode ? `=${encodeURIComponent(local.joinCode)}` : "";
    window.history.replaceState(null, "", `#join${code}`);
  }
  if (!silent) render();
}

async function copyPlayerLink() {
  const link = playerLink(local.room && local.room.code);
  const message = local.playerAccessMode === "local" ? "Link locale copiato" : "Link copiato";
  try {
    await navigator.clipboard.writeText(link);
    showToast(message);
  } catch (error) {
    const copied = fallbackCopy(link);
    showToast(copied ? message : "Copia non riuscita");
  }
}

function openPlayerLink() {
  const link = local.room && local.room.code
    ? playerLink(local.room.code)
    : `${playerBaseUrl()}/#join`;
  window.open(link, "_blank", "noopener,noreferrer");
}

async function copyScreenLink() {
  const link = screenLink(local.room && local.room.code);
  try {
    await navigator.clipboard.writeText(link);
    showToast("Link monitor copiato");
  } catch (error) {
    const copied = fallbackCopy(link);
    showToast(copied ? "Link monitor copiato" : "Copia non riuscita");
  }
}

function openScreenLink() {
  const link = screenLink(local.room && local.room.code);
  window.open(link, "_blank", "noopener,noreferrer");
}

async function castScreenToTv() {
  const link = screenLink(local.room && local.room.code);
  if (!supportsScreenPresentation()) {
    showToast("Usa Chrome: menu Trasmetti");
    return;
  }
  if (isScreenPresentationConnected()) {
    showToast("TV collegata");
    return;
  }

  try {
    const request = createScreenPresentationRequest(link);
    const connection = await request.start();
    setScreenPresentationConnection(connection);
    showToast("Monitor inviato alla TV");
    render();
  } catch (error) {
    const name = error && error.name;
    if (name === "NotAllowedError" || name === "AbortError") {
      showToast("Trasmissione annullata");
      return;
    }
    showToast("TV non trovata o non supportata");
  }
}

function disconnectScreenFromTv() {
  const connection = screenPresentationConnection;
  if (!connection) {
    showToast("Nessuna TV collegata");
    render();
    return;
  }

  screenPresentationDisconnecting = true;
  try {
    if (typeof connection.terminate === "function") {
      connection.terminate();
    } else if (typeof connection.close === "function") {
      connection.close();
    }
    showToast("TV scollegata");
  } catch (error) {
    showToast("Connessione TV chiusa");
  } finally {
    clearScreenPresentationConnection();
    screenPresentationDisconnecting = false;
    render();
  }
}

function openWaitingScreen() {
  window.open(`${playerBaseUrl()}/#screen`, "_blank", "noopener,noreferrer");
}

function updateScreenPresentationRequest() {
  if (!supportsScreenPresentation()) return;
  try {
    const link = screenLink(local.room && local.room.code);
    if (link === screenPresentationUrl) return;
    screenPresentationRequest = createScreenPresentationRequest(link);
    screenPresentationUrl = link;
    navigator.presentation.defaultRequest = screenPresentationRequest;
  } catch (error) {
    screenPresentationRequest = null;
    screenPresentationUrl = "";
  }
}

function createScreenPresentationRequest(link) {
  return new PresentationRequest([link]);
}

function supportsScreenPresentation() {
  return typeof window.PresentationRequest === "function" && Boolean(navigator.presentation);
}

function setScreenPresentationConnection(connection) {
  screenPresentationConnection = connection || null;
  screenPresentationDisconnecting = false;
  if (connection && typeof connection.addEventListener === "function") {
    connection.addEventListener("close", handleScreenPresentationEnded);
    connection.addEventListener("terminate", handleScreenPresentationEnded);
  }
}

function clearScreenPresentationConnection() {
  screenPresentationConnection = null;
}

function handleScreenPresentationEnded() {
  const wasConnected = Boolean(screenPresentationConnection);
  clearScreenPresentationConnection();
  if (wasConnected && !screenPresentationDisconnecting) showToast("TV scollegata");
  screenPresentationDisconnecting = false;
  render();
}

function isScreenPresentationConnected() {
  if (!screenPresentationConnection) return false;
  return !screenPresentationConnection.state || screenPresentationConnection.state === "connected";
}

async function loadNetworkConfig() {
  try {
    const response = await fetch("/api/network", { cache: "no-store" });
    if (!response.ok) return;
    const config = await response.json();
    local.playerBaseUrl = choosePlayerBaseUrl(config);
    local.playerAccessMode = choosePlayerAccessMode(config);
    render();
  } catch (error) {
    local.playerBaseUrl = window.location.origin;
    local.playerAccessMode = accessModeForOrigin(window.location.origin);
  }
}

function autoJoinScreen() {
  if (local.mode !== "screen" || local.room || local.screenJoining || !socket.connected) return;
  if (local.screenCode) {
    joinScreen();
    return;
  }
  watchScreen();
}

async function loadHostAuth() {
  try {
    const response = await fetch("/api/host/auth", {
      cache: "no-store",
      credentials: "same-origin"
    });
    if (!response.ok) throw new Error("Accesso host non disponibile");
    const data = await response.json();
    local.hostAuth.checked = true;
    local.hostAuth.enabled = Boolean(data.enabled);
    local.hostAuth.authenticated = !data.enabled || Boolean(data.authenticated);
  } catch (error) {
    local.hostAuth.checked = true;
    local.hostAuth.enabled = true;
    local.hostAuth.authenticated = false;
    if (local.mode === "host") showToast("Accesso host non verificato");
  } finally {
    render();
  }
}

async function hostLogin() {
  if (local.hostAuth.loading) return;
  const field = document.querySelector("[data-field='host-password']");
  const password = field ? field.value : local.hostAuth.password;
  if (!String(password || "").trim()) {
    showToast("Inserisci password host");
    return;
  }

  local.hostAuth.loading = true;
  render();
  try {
    const response = await fetch("/api/host/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ password })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || "Password non corretta");
    local.hostAuth.checked = true;
    local.hostAuth.enabled = Boolean(data.enabled);
    local.hostAuth.authenticated = true;
    local.hostAuth.password = "";
    reconnectSocketForHost();
    showToast("Area host sbloccata");
  } catch (error) {
    local.hostAuth.authenticated = false;
    showToast(error.message || "Password non corretta");
  } finally {
    local.hostAuth.loading = false;
    render();
  }
}

async function hostLogout() {
  try {
    await fetch("/api/host/logout", {
      method: "POST",
      credentials: "same-origin"
    });
  } catch (error) {
    // The local lock still happens even if the network request fails.
  }
  local.hostAuth.authenticated = !local.hostAuth.enabled;
  local.hostAuth.password = "";
  reconnectSocketForHost();
  showToast("Area host bloccata");
  render();
}

function hostAccessGranted() {
  return local.hostAuth.checked && (!local.hostAuth.enabled || local.hostAuth.authenticated);
}

function reconnectSocketForHost() {
  reconnectingForHostAuth = true;
  if (socket.connected) socket.disconnect();
  socket.connect();
}

function emitHost(eventName) {
  socket.emit(eventName, {}, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Comando non riuscito");
    }
  });
}

function releaseScreens() {
  socket.emit("host:release-screens", {}, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Monitor non aggiornato");
      return;
    }
    showToast(response.released ? "Monitor in attesa" : "Nessun monitor collegato");
  });
}

function answer(answerIndex) {
  const question = local.room && local.room.question;
  if (question && question.type === "multiple_select" && !question.answered) {
    const required = selectionCount(question);
    const selected = new Set(local.selectedAnswers);
    if (selected.has(answerIndex)) {
      selected.delete(answerIndex);
    } else if (selected.size < required) {
      selected.add(answerIndex);
    } else {
      showToast(`Scegli solo ${required} risposte`);
    }
    local.selectedAnswers = Array.from(selected).sort((a, b) => a - b);
    render();
    return;
  }

  local.selectedAnswer = answerIndex;
  render();
  socket.emit("player:answer", { answerIndex }, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Risposta non inviata");
    }
  });
}

function submitMultipleAnswer() {
  const question = local.room && local.room.question;
  if (!question || question.type !== "multiple_select") return;
  const required = selectionCount(question);
  if (local.selectedAnswers.length !== required) {
    showToast(`Seleziona ${required} risposte`);
    return;
  }
  socket.emit("player:answer", { answerIndexes: local.selectedAnswers }, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Risposte non inviate");
      return;
    }
    local.selectedAnswers = [];
  });
}

function respondRematch(accept) {
  socket.emit("player:rematch", { accept }, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Invito non valido");
      return;
    }
    if (response.left) {
      leaveRoomLocally("Hai saltato la nuova partita");
      return;
    }
    showToast("Confermato");
  });
}

function leaveRoomLocally(message) {
  const code = local.room && local.room.code;
  local.room = null;
  local.selectedAnswer = null;
  local.selectedAnswers = [];
  if (code) local.joinCode = code;
  switchMode("join", true);
  showToast(message);
  render();
}

function cleanQuiz(input) {
  const source = input && typeof input === "object" ? input : defaultQuiz();
  const questions = Array.isArray(source.questions) ? source.questions : [];
  return {
    title: String(source.title || "QuizLive").trim().slice(0, 80) || "QuizLive",
    subject: String(source.subject || "").trim().slice(0, 40),
    level: String(source.level || "").trim().slice(0, 40),
    language: String(source.language || "Italiano").trim().slice(0, 32) || "Italiano",
    tags: parseTags(source.tags),
    teamMode: Boolean(source.teamMode),
    questions: questions.map((question, index) => {
      const type = normalizeQuestionType(question.type);
      const answers = (type === "true_false" ? ["Vero", "Falso"] : paddedAnswers(question.answers))
        .map((answer) => String(answer || "").trim())
        .filter(Boolean)
        .slice(0, 6);
      const correctIndexes = normalizeCorrectIndexes(question, answers, type);
      return {
        type,
        text: String(question.text || `Domanda ${index + 1}`).trim().slice(0, 240),
        imageUrl: normalizeMediaUrl(question.imageUrl),
        videoUrl: normalizeMediaUrl(question.videoUrl),
        answers,
        correctIndex: correctIndexes[0] || 0,
        correctIndexes,
        timeLimit: Math.min(90, Math.max(5, Math.round(Number(question.timeLimit) || 20)))
      };
    }).filter((question) => question.text && question.answers.length >= 2)
  };
}

function paddedAnswers(answers) {
  const result = Array.isArray(answers) ? answers.slice(0, 6) : [];
  while (result.length < 4) result.push("");
  return result;
}

function editableAnswers(question) {
  if (normalizeQuestionType(question.type) === "true_false") return ["Vero", "Falso"];
  return paddedAnswers(question.answers);
}

function normalizeCorrectIndexes(question, answers, type) {
  const source = Array.isArray(question.correctIndexes) && question.correctIndexes.length
    ? question.correctIndexes
    : [question.correctIndex];
  let indexes = Array.from(new Set(source
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0 && value < answers.length)))
    .sort((a, b) => a - b);
  if (!indexes.length) indexes = [0];
  if (type === "multiple_select" && indexes.length < 2 && answers.length >= 2) {
    const fallback = answers.findIndex((_answer, index) => !indexes.includes(index));
    indexes = Array.from(new Set([...indexes, fallback >= 0 ? fallback : 0])).sort((a, b) => a - b);
  }
  return type === "multiple_select" ? indexes : [indexes[0]];
}

function correctIndexesForQuestion(question, answers) {
  return normalizeCorrectIndexes(question, answers, normalizeQuestionType(question.type));
}

function selectionCount(question) {
  if (Number.isInteger(question.selectionCount) && question.selectionCount > 0) return question.selectionCount;
  const answers = Array.isArray(question.answers) ? question.answers : [];
  return normalizeQuestionType(question.type) === "multiple_select"
    ? correctIndexesForQuestion(question, answers).length
    : 1;
}

function parseTags(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,;]+/);
  return Array.from(new Set(raw
    .map((tag) => String(tag || "").trim().slice(0, 24))
    .filter(Boolean)))
    .slice(0, 8);
}

function normalizeMediaUrl(value) {
  const raw = String(value || "").trim().slice(0, 500);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : "";
  } catch (error) {
    return "";
  }
}

function normalizeSearch(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeQuestionType(type) {
  const key = String(type || "multiple").trim().toLowerCase().replace(/[\/\s]+/g, "_").replace(/-/g, "_");
  if (key === "vero_falso" || key === "verofalso" || key === "true_false" || key === "truefalse") return "true_false";
  if (key === "veloce" || key === "risposta_veloce" || key === "speed" || key === "fast") return "speed";
  if (key === "risposte_multiple" || key === "risposta_multipla" || key === "multiple_select" || key === "multi_select" || key === "multiple_correct") return "multiple_select";
  if (key === "multipla" || key === "scelta_multipla") return "multiple";
  return "multiple";
}

function questionTypeLabel(type) {
  const found = questionTypes.find((item) => item.value === normalizeQuestionType(type));
  return found ? found.label : "Scelta multipla";
}

function secondsLeft(room) {
  if (!room.questionEndsAt) return 0;
  return Math.max(0, Math.ceil((room.questionEndsAt - Date.now()) / 1000));
}

function timeProgressPercent(room) {
  return countdownPercent(room.questionEndsAt, room.question ? room.question.timeLimit : 0);
}

function countdownPercent(endsAt, timeLimit) {
  const duration = Math.max(1, Number(timeLimit) || 1) * 1000;
  const remaining = Math.max(0, Number(endsAt || 0) - Date.now());
  return Math.max(0, Math.min(100, Math.round((remaining / duration) * 1000) / 10));
}

function updateLiveTimers() {
  document.querySelectorAll("[data-countdown]").forEach((element) => {
    const endsAt = Number(element.dataset.endsAt || 0);
    const timeLimit = Number(element.dataset.timeLimit || 0);
    const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    const percent = countdownPercent(endsAt, timeLimit);
    const timer = element.querySelector("[data-timer]");
    const bar = element.querySelector("[data-time-bar]");
    if (timer && timer.textContent !== String(left)) timer.textContent = String(left);
    if (bar) bar.style.width = `${percent}%`;
    element.classList.toggle("urgent", left <= 5);
  });
}

function statusLabel(status) {
  const labels = {
    lobby: "Lobby",
    question: "Domanda",
    reveal: "Risultati",
    ended: "Finale"
  };
  return labels[status] || status;
}

function initialMode() {
  const hash = window.location.hash.replace(/^#/, "");
  if (hash.startsWith("host")) return "host";
  if (hash.startsWith("screen")) return "screen";
  return "join";
}

function initialJoinCode() {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("join") || params.get("code") || "";
  const fromHash = hash.startsWith("join=") ? hash.slice(5) : "";
  return String(fromHash || fromQuery).replace(/\D/g, "").slice(0, 6);
}

function initialScreenCode() {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("screen") || "";
  const fromHash = hash.startsWith("screen=") ? hash.slice(7) : "";
  return String(fromHash || fromQuery).replace(/\D/g, "").slice(0, 6);
}

function playerLink(code) {
  return `${playerBaseUrl()}/#join=${encodeURIComponent(code || "")}`;
}

function screenLink(code) {
  return `${playerBaseUrl()}/#screen=${encodeURIComponent(code || "")}`;
}

function qrCodeSrc(code) {
  return `/api/qr.svg?url=${encodeURIComponent(playerLink(code))}`;
}

function playerBaseUrl() {
  return local.playerBaseUrl || window.location.origin;
}

function playerBaseLabel() {
  try {
    const url = new URL(playerBaseUrl());
    const prefix = local.playerAccessMode === "public" ? "Pubblico" : "Solo Wi-Fi";
    return `${prefix}: ${url.host}`;
  } catch (error) {
    return "Telefono";
  }
}

function playerAccessNotice() {
  if (local.playerAccessMode === "public") {
    return "Questo QR usa un URL pubblico.";
  }
  return "Questo QR funziona solo sulla stessa Wi-Fi.";
}

function playerAccessClass() {
  return local.playerAccessMode === "public" ? "public" : "local";
}

function formatDate(value) {
  if (!value) return "-";
  try {
    return new Intl.DateTimeFormat("it-IT", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(new Date(value));
  } catch (error) {
    return "-";
  }
}

function choosePlayerBaseUrl(config) {
  if (config && config.publicOrigin) {
    return config.publicOrigin;
  }
  if (isLoopbackHost(window.location.hostname) && config && config.preferredOrigin) {
    return config.preferredOrigin;
  }
  return window.location.origin;
}

function choosePlayerAccessMode(config) {
  if (config && config.accessMode) return config.accessMode;
  return accessModeForOrigin(playerBaseUrl());
}

function accessModeForOrigin(origin) {
  try {
    const hostname = new URL(origin).hostname;
    if (isLoopbackHost(hostname) || isPrivateIPv4(hostname) || hostname.endsWith(".local")) {
      return "local";
    }
    return "public";
  } catch (error) {
    return "same-origin";
  }
}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function isPrivateIPv4(address) {
  return /^10\./.test(address) ||
    /^192\.168\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(address);
}

function fallbackCopy(text) {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "readonly");
  field.style.position = "fixed";
  field.style.left = "-9999px";
  document.body.appendChild(field);
  field.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch (error) {
    copied = false;
  }
  document.body.removeChild(field);
  return copied;
}

function letterClass(index) {
  return ["a", "b", "c", "d", "e", "f"][index] || "a";
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function defaultQuiz() {
  return {
    title: "Demo QuizLive",
    subject: "Tecnologia",
    level: "Demo",
    language: "Italiano",
    tags: ["demo", "live"],
    teamMode: false,
    questions: [
      {
        type: "multiple",
        text: "Quale tecnologia permette risposte live tra host e telefoni?",
        answers: ["WebSocket", "Solo email", "PDF", "Bluetooth spento"],
        correctIndex: 0,
        timeLimit: 20
      },
      {
        type: "speed",
        text: "Quale formato e comodo per esportare risultati in un foglio di calcolo?",
        answers: ["XLSX", "PNG", "MP3", "MOV"],
        correctIndex: 0,
        timeLimit: 12
      },
      {
        type: "true_false",
        text: "I giocatori entrano con codice stanza e nickname.",
        answers: ["Vero", "Falso"],
        correctIndex: 0,
        timeLimit: 15
      },
      {
        type: "multiple_select",
        text: "Quali schermate sono pensate per il pubblico?",
        answers: ["Monitor", "Classifica", "Password host", "Domanda live"],
        correctIndexes: [0, 1, 3],
        timeLimit: 18
      }
    ]
  };
}
