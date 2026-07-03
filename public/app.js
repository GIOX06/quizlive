const socket = io();

const answerLetters = ["A", "B", "C", "D", "E", "F"];
const answerClasses = ["answer-a", "answer-b", "answer-c", "answer-d", "answer-e", "answer-f"];
let local = {
  mode: initialMode(),
  room: null,
  quiz: defaultQuiz(),
  selectedAnswer: null,
  importOpen: false,
  importText: "",
  joinCode: initialJoinCode(),
  nickname: "",
  playerBaseUrl: window.location.origin
};

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");

socket.on("connect", () => {
  render();
});

socket.on("disconnect", () => {
  showToast("Connessione persa");
  render();
});

socket.on("room:state", (room) => {
  local.room = room;
  local.mode = room.role;
  if (room.status !== "question") {
    local.selectedAnswer = null;
  }
  render();
});

loadNetworkConfig();

window.addEventListener("hashchange", () => {
  if (local.room) return;
  local.joinCode = initialJoinCode();
  local.mode = initialMode();
  render();
});

setInterval(() => {
  if (local.room && local.room.status === "question") render();
}, 500);

function render() {
  app.innerHTML = shell(renderMain(), renderTopbar());
  bindEvents();
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
  if (!local.room) return local.mode === "host" ? renderHostHome() : renderJoinHome();
  if (local.room.role === "host") return renderHostGame(local.room);
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
          <button class="btn ghost" data-action="switch-host">Area host</button>
        </div>
      </div>
    </section>
  `;
}

function renderHostHome() {
  return `
    <section class="stack">
      <div class="host-header">
        <div>
          <h1 class="section-title">Crea partita</h1>
          <p class="subtle">Quiz, lobby, timer, punteggio e risultati esportabili.</p>
        </div>
        <button class="btn ghost" data-action="switch-join">Area giocatore</button>
      </div>
      <div class="panel stack">
        ${renderQuizBuilder()}
        <div class="toolbar">
          <button class="btn primary" data-action="create-room">Crea stanza</button>
          <button class="btn ghost" data-action="add-question">Aggiungi domanda</button>
          <button class="btn ghost" data-action="toggle-import">Import JSON</button>
          <button class="btn ghost" data-action="download-quiz">Export quiz</button>
        </div>
        ${local.importOpen ? renderImportBox() : ""}
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
      ${local.quiz.questions.map(renderQuestionEditor).join("")}
    </div>
  `;
}

function renderQuestionEditor(question, questionIndex) {
  const answers = paddedAnswers(question.answers);
  return `
    <article class="builder-question stack" data-question-index="${questionIndex}">
      <div class="question-head">
        <strong>Domanda ${questionIndex + 1}</strong>
        <button class="btn small ghost" data-action="remove-question" data-question-index="${questionIndex}" ${local.quiz.questions.length <= 1 ? "disabled" : ""}>Rimuovi</button>
      </div>
      <label class="stack">
        <span>Testo domanda</span>
        <textarea data-question-text data-question-index="${questionIndex}" maxlength="240">${escapeHtml(question.text)}</textarea>
      </label>
      <div class="grid-2">
        <label class="stack">
          <span>Tempo</span>
          <input data-question-time data-question-index="${questionIndex}" type="number" min="5" max="90" value="${question.timeLimit}" />
        </label>
        <label class="stack">
          <span>Risposta corretta</span>
          <select data-question-correct data-question-index="${questionIndex}">
            ${answers.map((answer, answerIndex) => `<option value="${answerIndex}" ${question.correctIndex === answerIndex ? "selected" : ""}>${answerLetters[answerIndex]} ${escapeHtml(answer || "")}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="stack">
        ${answers.map((answer, answerIndex) => `
          <div class="answer-editor">
            <span class="answer-key ${letterClass(answerIndex)}">${answerLetters[answerIndex]}</span>
            <input data-answer-text data-question-index="${questionIndex}" data-answer-index="${answerIndex}" value="${escapeAttr(answer)}" maxlength="160" />
            <label class="radio-label">
              <input type="radio" name="correct-${questionIndex}" data-correct-radio data-question-index="${questionIndex}" data-answer-index="${answerIndex}" ${question.correctIndex === answerIndex ? "checked" : ""} />
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
      <textarea data-field="import-json" placeholder='{"title":"...","questions":[...]}' spellcheck="false">${escapeHtml(local.importText)}</textarea>
      <div class="toolbar">
        <button class="btn teal" data-action="apply-import">Importa</button>
        <button class="btn ghost" data-action="toggle-import">Chiudi</button>
      </div>
    </div>
  `;
}

function renderHostGame(room) {
  const question = room.question;
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
          <button class="btn ghost" data-action="reset-room">Reset</button>
        </div>
        <div>
          <h2 class="section-title">Giocatori</h2>
          <p class="subtle">${room.playerCount} in lobby o partita</p>
        </div>
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
        <p class="subtle">Pronto per ${room.totalQuestions} domande.</p>
      </div>
      <div class="qr-panel">
        <img class="qr-code" src="${escapeAttr(qrCodeSrc(room.code))}" alt="QR code ingresso giocatori" />
        <div class="qr-meta">
          <span class="status-pill">Codice ${escapeHtml(room.code)}</span>
          <span class="status-pill">${escapeHtml(playerBaseLabel())}</span>
          <button class="btn ghost" data-action="copy-player-link">Copia link</button>
        </div>
      </div>
      <div class="toolbar">
        <button class="btn primary" data-action="start-game" ${room.totalQuestions < 1 ? "disabled" : ""}>Avvia quiz</button>
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
          <div class="timer">${secondsLeft(room)}</div>
          <span class="status-pill">Domanda ${room.currentIndex + 1}/${room.totalQuestions}</span>
          <span class="status-pill">${room.answerCount}/${room.playerCount} risposte</span>
        </div>
      </div>
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

function renderPlayerWaiting(room) {
  return `
    <div class="panel stack">
      <h1 class="section-title">Sei dentro</h1>
      <p class="subtle">Codice ${escapeHtml(room.code)} - in attesa dell'host.</p>
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
          <div class="timer">${secondsLeft(room)}</div>
          <span class="status-pill">Domanda ${room.currentIndex + 1}/${room.totalQuestions}</span>
          ${question.answered ? `<span class="status-pill">Risposta inviata</span>` : ""}
        </div>
      </div>
      <div class="answers-grid">
        ${question.answers.map((answer) => renderAnswerButton(answer, question)).join("")}
      </div>
    </article>
  `;
}

function renderReveal(room, isHost) {
  const question = room.question;
  const playerAnswer = question.playerAnswer;
  const correct = playerAnswer && playerAnswer.correct;
  return `
    <article class="question-card">
      <div class="question-main">
        <h1 class="question-title">${escapeHtml(question.text)}</h1>
        <div class="meta-row">
          <span class="status-pill">${correct ? "Corretta" : isHost ? "Risultati" : "Risposta mostrata"}</span>
          ${playerAnswer ? `<span class="status-pill">+${playerAnswer.points} punti</span>` : ""}
          <span class="status-pill">${room.answerCount}/${room.playerCount} risposte</span>
        </div>
      </div>
      <div class="answers-grid">
        ${question.answers.map((answer) => isHost ? renderAnswerStat(answer, room.playerCount) : renderAnswerButton(answer, question, true)).join("")}
      </div>
    </article>
    ${isHost ? `<div class="toolbar"><button class="btn primary" data-action="next-question">${room.currentIndex + 1 >= room.totalQuestions ? "Classifica finale" : "Prossima domanda"}</button></div>` : ""}
  `;
}

function renderEnded(room, isHost) {
  const top = room.leaderboard.slice(0, 3);
  return `
    <div class="panel stack">
      <div>
        <h1 class="section-title">Classifica finale</h1>
        <p class="subtle">${escapeHtml(room.title)}</p>
      </div>
      ${top.length ? `
        <div class="podium">
          ${top.map((player, index) => `
            <div class="podium-place">
              <div class="podium-rank">${index + 1}</div>
              <strong>${escapeHtml(player.nickname)}</strong>
              <span>${player.score} punti</span>
            </div>
          `).join("")}
        </div>
      ` : `<div class="empty">Nessun giocatore</div>`}
      ${renderLeaderboard(room)}
      ${isHost ? `<div class="toolbar"><button class="btn ghost" data-action="reset-room">Nuova partita</button></div>` : ""}
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
          <span class="name">${escapeHtml(player.nickname)}</span>
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
          <span class="name">${escapeHtml(player.nickname)}</span>
          <span class="score">${player.score}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderAnswerButton(answer, question, reveal = false) {
  const selected = local.selectedAnswer === answer.index || (question.playerAnswer && question.playerAnswer.answerIndex === answer.index);
  const correct = reveal && answer.correct;
  const wrong = reveal && selected && !answer.correct;
  return `
    <button class="answer-btn ${answerClasses[answer.index]} ${selected ? "selected" : ""} ${correct ? "correct" : ""} ${wrong ? "wrong" : ""}"
      data-action="answer"
      data-answer-index="${answer.index}"
      ${question.answered || reveal ? "disabled" : ""}>
      <span class="letter">${answerLetters[answer.index]}</span>
      <span class="answer-text">${escapeHtml(answer.text)}</span>
    </button>
  `;
}

function renderAnswerStat(answer, playerCount) {
  const percent = playerCount ? Math.round((Number(answer.count || 0) / playerCount) * 100) : 0;
  return `
    <div class="answer-stat ${answerClasses[answer.index]} ${answer.correct ? "correct" : ""}">
      <span class="letter">${answerLetters[answer.index]}</span>
      <span class="answer-text">${escapeHtml(answer.text)} - ${answer.count || 0}</span>
      <span class="stat-bar"><span style="width:${percent}%"></span></span>
    </div>
  `;
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
  document.querySelectorAll("[data-question-text]").forEach((element) => {
    element.addEventListener("input", () => {
      local.quiz.questions[Number(element.dataset.questionIndex)].text = element.value;
    });
  });
  document.querySelectorAll("[data-question-time]").forEach((element) => {
    element.addEventListener("input", () => {
      local.quiz.questions[Number(element.dataset.questionIndex)].timeLimit = Number(element.value);
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
  if (action === "apply-import") applyImport();
  if (action === "download-quiz") downloadJson("quizlive-quiz.json", cleanQuiz(local.quiz));
  if (action === "switch-host") switchMode("host");
  if (action === "switch-join") switchMode("join");
  if (action === "copy-player-link") copyPlayerLink();
  if (action === "create-room") createRoom();
  if (action === "join-room") joinRoom();
  if (action === "start-game") emitHost("host:start");
  if (action === "reveal-question") emitHost("host:reveal");
  if (action === "next-question") emitHost("host:next");
  if (action === "reset-room") emitHost("host:reset");
  if (action === "answer") answer(Number(target.dataset.answerIndex));
}

function addQuestion() {
  local.quiz.questions.push({
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
    local.importOpen = false;
    showToast("Quiz importato");
    render();
  } catch (error) {
    showToast("JSON non valido");
  }
}

function createRoom() {
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

function switchMode(mode, silent = false) {
  local.mode = mode;
  if (mode === "host") {
    window.history.replaceState(null, "", "#host");
  } else {
    const code = local.joinCode ? `=${encodeURIComponent(local.joinCode)}` : "";
    window.history.replaceState(null, "", `#join${code}`);
  }
  if (!silent) render();
}

async function copyPlayerLink() {
  const link = playerLink(local.room && local.room.code);
  try {
    await navigator.clipboard.writeText(link);
    showToast("Link copiato");
  } catch (error) {
    const copied = fallbackCopy(link);
    showToast(copied ? "Link copiato" : "Copia non riuscita");
  }
}

async function loadNetworkConfig() {
  try {
    const response = await fetch("/api/network", { cache: "no-store" });
    if (!response.ok) return;
    const config = await response.json();
    local.playerBaseUrl = choosePlayerBaseUrl(config);
    render();
  } catch (error) {
    local.playerBaseUrl = window.location.origin;
  }
}

function emitHost(eventName) {
  socket.emit(eventName, {}, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Comando non riuscito");
    }
  });
}

function answer(answerIndex) {
  local.selectedAnswer = answerIndex;
  render();
  socket.emit("player:answer", { answerIndex }, (response) => {
    if (!response || !response.ok) {
      showToast(response && response.error ? response.error : "Risposta non inviata");
    }
  });
}

function cleanQuiz(input) {
  const source = input && typeof input === "object" ? input : defaultQuiz();
  const questions = Array.isArray(source.questions) ? source.questions : [];
  return {
    title: String(source.title || "QuizLive").trim().slice(0, 80) || "QuizLive",
    questions: questions.map((question, index) => {
      const answers = paddedAnswers(question.answers)
        .map((answer) => String(answer || "").trim())
        .filter(Boolean)
        .slice(0, 6);
      return {
        text: String(question.text || `Domanda ${index + 1}`).trim().slice(0, 240),
        answers,
        correctIndex: Math.min(Math.max(Number(question.correctIndex) || 0, 0), Math.max(answers.length - 1, 0)),
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

function secondsLeft(room) {
  if (!room.questionEndsAt) return 0;
  return Math.max(0, Math.ceil((room.questionEndsAt - Date.now()) / 1000));
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
  return "join";
}

function initialJoinCode() {
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get("join") || params.get("code") || "";
  const fromHash = hash.startsWith("join=") ? hash.slice(5) : "";
  return String(fromHash || fromQuery).replace(/\D/g, "").slice(0, 6);
}

function playerLink(code) {
  return `${playerBaseUrl()}/#join=${encodeURIComponent(code || "")}`;
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
    return `Telefono: ${url.host}`;
  } catch (error) {
    return "Telefono";
  }
}

function choosePlayerBaseUrl(config) {
  if (isLoopbackHost(window.location.hostname) && config && config.preferredOrigin) {
    return config.preferredOrigin;
  }
  return window.location.origin;
}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
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
    questions: [
      {
        text: "Quale tecnologia permette risposte live tra host e telefoni?",
        answers: ["WebSocket", "Solo email", "PDF", "Bluetooth spento"],
        correctIndex: 0,
        timeLimit: 20
      },
      {
        text: "Quale formato e comodo per esportare risultati in un foglio di calcolo?",
        answers: ["CSV", "PNG", "MP3", "MOV"],
        correctIndex: 0,
        timeLimit: 18
      },
      {
        text: "Cosa serve ai giocatori per entrare nella partita?",
        answers: ["Codice stanza e nickname", "App store", "Cavo USB", "Account admin"],
        correctIndex: 0,
        timeLimit: 20
      }
    ]
  };
}
