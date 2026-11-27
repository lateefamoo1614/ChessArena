// ========================================
// CHESSARENA - MAIN JAVASCRIPT
// ========================================

const socket = io();

let currentGame = null;
let currentMode = null;
let currentTimeControl = null;

let clockValues = { white: 0, black: 0 };
let activeClock = null;
let clockLastUpdated = Date.now();
let clockTimer = null;

const RECONNECT_STORAGE_KEY = "chessarena-active-game";

function readReconnectInfo() {
  try {
    const raw = sessionStorage.getItem(RECONNECT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn("Could not read reconnect information:", error);
    return null;
  }
}

function saveReconnectInfo(data) {
  if (!data || !data.gameId || !data.reconnectToken) return;

  const info = {
    gameId: data.gameId,
    token: data.reconnectToken
  };

  try {
    sessionStorage.setItem(RECONNECT_STORAGE_KEY, JSON.stringify(info));
  } catch (error) {
    console.warn("Could not save reconnect information:", error);
  }

  window.chessArenaHasReconnectData = true;
}

function clearReconnectInfo() {
  try {
    sessionStorage.removeItem(RECONNECT_STORAGE_KEY);
  } catch (error) {
    console.warn("Could not clear reconnect information:", error);
  }

  window.chessArenaHasReconnectData = false;
}

window.chessArenaClearReconnectInfo = clearReconnectInfo;

const isChessArenaPlayPage =
  window.location.pathname.endsWith("/play.html");

if (!isChessArenaPlayPage) clearReconnectInfo();

window.chessArenaHasReconnectData =
  isChessArenaPlayPage && !!readReconnectInfo();

// ========================================
// HELPER FUNCTIONS
// ========================================

function updateMatchStatus(message) {
  const status = document.getElementById("match-status");
  if (status) status.textContent = message;
}

function getClockValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function updateClockValues(clocks) {
  if (!clocks) return;

  clockValues.white = getClockValue(clocks.white);
  clockValues.black = getClockValue(clocks.black);
}

function stopClockDisplay() {
  if (clockTimer) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
}

// ========================================
// SERVER CONNECTION AND RECONNECTION
// ========================================

socket.on("connect", () => {
  console.log("Connected to ChessArena server:", socket.id);

  const reconnectInfo =
    isChessArenaPlayPage ? readReconnectInfo() : null;

  if (reconnectInfo?.gameId && reconnectInfo?.token) {
    window.chessArenaHasReconnectData = true;

    updateMatchStatus("Restoring your previous game...");

    socket.emit("rejoin-game", reconnectInfo);
  }
});

socket.on("disconnect", () => {
  console.log("Disconnected from ChessArena server.");

  stopClockDisplay();
  activeClock = null;

  updateMatchStatus("Connection lost. Reconnecting...");
});

socket.on("connect_error", (error) => {
  console.error("Server connection error:", error.message);

  updateMatchStatus("Unable to connect. Retrying...");
});

socket.on("rejoin-failed", (data = {}) => {
  clearReconnectInfo();

  currentGame = null;

  stopClockDisplay();
  activeClock = null;

  updateMatchStatus(
    data.message || "Could not restore your previous game."
  );

  window.dispatchEvent(
    new CustomEvent("chessarena-rejoin-failed", {
      detail: data
    })
  );
});

// ========================================
// GAME MODE SELECTION
// ========================================

function startSelectedGame(mode) {
  const timeSelect = document.getElementById(mode + "-time");

  if (!timeSelect) {
    alert("Time control could not be found.");
    return;
  }

  const timeControl = timeSelect.value;

  if (!timeControl) {
    alert("Please select a time control.");
    return;
  }

  const params = new URLSearchParams({
    mode,
    time: timeControl
  });

  window.location.href = "/play.html?" + params.toString();
}

// ========================================
// MATCHMAKING
// ========================================

function findOpponent(mode) {
  if (!socket.connected) {
    alert("Connecting to ChessArena server. Please try again.");
    return;
  }

  if (!currentTimeControl) {
    const params = new URLSearchParams(window.location.search);
    currentTimeControl = params.get("time");
  }

  if (!currentTimeControl) {
    alert("Please select a valid time control.");
    return;
  }

  currentMode = mode;

  updateMatchStatus("Searching for an opponent...");

  socket.emit("find-match", {
    mode,
    time: currentTimeControl
  });
}

socket.on("waiting-for-opponent", (data) => {
  updateMatchStatus(
    data?.message || "Waiting for an opponent..."
  );
});

socket.on("search-cancelled", () => {
  updateMatchStatus("Search cancelled.");
});

socket.on("match-error", (message) => {
  updateMatchStatus(message);
  alert(message);
});

function cancelMatchSearch() {
  if (socket.connected) {
    socket.emit("cancel-search");
  }
}
// ========================================
// GAME START AND RESUME
// ========================================

socket.on("game-start", (data) => {
  if (!data) return;

  currentGame = data;
  currentMode = data.mode;
  currentTimeControl = data.time;
  saveReconnectInfo(data);

  updateClockValues(data.clocks);
  activeClock = "white";
  clockLastUpdated = Date.now();

  console.log("Game started:", data);
  stopClockDisplay();
  startClockDisplay();
  updateMatchStatus("Opponent found! Game started.");

  window.dispatchEvent(
    new CustomEvent("chessarena-game-start", { detail: data })
  );
});

socket.on("game-resumed", (data) => {
  if (!data) return;

  currentGame = data;
  currentMode = data.mode;
  currentTimeControl = data.time;
  saveReconnectInfo(data);

  updateClockValues(data.clocks);
  activeClock = data.activeColor || null;
  clockLastUpdated = Date.now();

  stopClockDisplay();
  startClockDisplay();
  updateMatchStatus("Game reconnected. Continue playing.");

  window.dispatchEvent(
    new CustomEvent("chessarena-game-resumed", { detail: data })
  );
});

// ========================================
// CLOCK DISPLAY
// ========================================

function startClockDisplay() {
  updateClockDisplay();
  stopClockDisplay();

  clockTimer = setInterval(() => {
    if (!currentGame || !activeClock) return;

    const elapsed = (Date.now() - clockLastUpdated) / 1000;

    const displayedWhite = Math.max(
      0,
      clockValues.white - (activeClock === "white" ? elapsed : 0)
    );

    const displayedBlack = Math.max(
      0,
      clockValues.black - (activeClock === "black" ? elapsed : 0)
    );

    setClockText("white-clock", displayedWhite);
    setClockText("black-clock", displayedBlack);
  }, 100);
}

function setClockText(elementId, seconds) {
  const element = document.getElementById(elementId);
  if (!element) return;

  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = Math.floor(safeSeconds % 60);

  element.textContent =
    String(minutes).padStart(2, "0") + ":" +
    String(remainingSeconds).padStart(2, "0");
}

function updateClockDisplay() {
  setClockText("white-clock", clockValues.white);
  setClockText("black-clock", clockValues.black);
}

// ========================================
// SERVER CLOCK UPDATES
// ========================================

socket.on("clock-update", (data) => {
  if (!data) return;

  updateClockValues(data.clocks);
  activeClock = data.activeColor || null;
  clockLastUpdated = Date.now();
  updateClockDisplay();
});

// ========================================
// MOVE UPDATES
// ========================================

socket.on("move-made", (data) => {
  if (!data) return;

  updateClockValues(data.clocks);
  activeClock = data.activeColor || null;
  clockLastUpdated = Date.now();
  updateClockDisplay();

  window.dispatchEvent(
    new CustomEvent("chessarena-move-made", { detail: data })
  );
});

socket.on("move-error", (message) => {
  updateMatchStatus(message);

  window.dispatchEvent(
    new CustomEvent("chessarena-move-error", { detail: message })
  );
});

// ========================================
// GAME OVER
// ========================================

socket.on("game-over", (data) => {
  if (!data) return;

  clearReconnectInfo();
  stopClockDisplay();
  updateClockValues(data.clocks);
  activeClock = null;
  updateClockDisplay();

  updateMatchStatus(
    (data.result || "Game finished") + " — " + (data.reason || "")
  );

  window.dispatchEvent(
    new CustomEvent("chessarena-game-over", { detail: data })
  );
});

// ========================================
// OPPONENT DISCONNECT / RECONNECT
// ========================================

socket.on("opponent-disconnected", (data = {}) => {
  stopClockDisplay();
  updateClockValues(data.clocks);
  activeClock = null;
  updateClockDisplay();

  updateMatchStatus("Opponent disconnected. Waiting for them to return...");

  window.dispatchEvent(
    new CustomEvent("chessarena-opponent-disconnected", { detail: data })
  );
});

socket.on("opponent-reconnected", (data = {}) => {
  updateClockValues(data.clocks);
  activeClock = data.activeColor || null;
  clockLastUpdated = Date.now();

  stopClockDisplay();
  startClockDisplay();

  updateMatchStatus("Your opponent has reconnected. Game resumed.");

  window.dispatchEvent(
    new CustomEvent("chessarena-opponent-reconnected", { detail: data })
  );
});

// ========================================
// SEND CHESS MOVE
// ========================================

function sendChessMove(move) {
  if (!currentGame || !currentGame.gameId) {
    updateMatchStatus("No active game.");
    return;
  }

  if (!socket.connected) {
    updateMatchStatus("Connection lost. Please wait...");
    return;
  }

  socket.emit("make-move", { gameId: currentGame.gameId, move });
}
// ========================================
// CHALLENGE A FRIEND
// ========================================

const createChallengeBtn = document.getElementById("createChallengeBtn");

if (createChallengeBtn) {
  createChallengeBtn.addEventListener("click", () => {
    const modeElement = document.getElementById("challenge-mode");
    const timeElement = document.getElementById("challenge-time");
    const result = document.getElementById("challenge-result");

    if (!modeElement || !timeElement || !result) return;

    const mode = modeElement.value;
    const time = timeElement.value;

    const inviteCode =
      "CA-" + Math.random().toString(36).substring(2, 8).toUpperCase();

    const inviteURL = new URL(window.location.href);

    inviteURL.searchParams.set("challenge", "friend");
    inviteURL.searchParams.set("code", inviteCode);
    inviteURL.searchParams.set("mode", mode);
    inviteURL.searchParams.set("time", time);

    result.innerHTML = "";

    const heading = document.createElement("h3");
    heading.textContent = "Friend Challenge Created!";

    const details = document.createElement("p");
    details.textContent =
      mode.toUpperCase() + " | " + time.replace("+", " + ");

    const code = document.createElement("p");
    code.textContent = "Invitation code: " + inviteCode;

    const link = document.createElement("a");
    link.href = inviteURL.toString();
    link.textContent = "Open Invitation Link";
    link.target = "_blank";
    link.rel = "noopener noreferrer";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy Invitation Link";

    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(inviteURL.toString());
        copy.textContent = "Link Copied!";
      } catch {
        window.prompt(
          "Copy this invitation link:",
          inviteURL.toString()
        );
      }
    });

    const notice = document.createElement("p");
    notice.textContent = "Invite a friend and enjoy a free chess match.";

    result.append(heading, details, code, link, copy, notice);
  });
}

// ========================================
// HOMEPAGE NAVIGATION
// ========================================

const playNow = document.getElementById("playNow");

if (playNow) {
  playNow.addEventListener("click", () => {
    document.getElementById("arena")?.scrollIntoView({
      behavior: "smooth"
    });
  });
}

// ========================================
// LOGIN / SIGNUP BUTTONS
// ========================================

const loginBtn = document.getElementById("login-btn");

if (loginBtn) {
  loginBtn.addEventListener("click", () => {
    window.location.href = "/login.html";
  });
}

const signupBtn = document.getElementById("signup-btn");

if (signupBtn) {
  signupBtn.addEventListener("click", () => {
    window.location.href = "/signup.html";
  });
}

// ========================================
// PLAY PAGE SETTINGS
// ========================================

const pageParams = new URLSearchParams(window.location.search);

const selectedMode = pageParams.get("mode");
const selectedTime = pageParams.get("time");

if (["bullet", "blitz", "rapid"].includes(selectedMode)) {
  currentMode = selectedMode;
  currentTimeControl = selectedTime;

  document.addEventListener("DOMContentLoaded", () => {
    const title = document.getElementById("game-title");

    if (title) {
      title.textContent =
        selectedMode.charAt(0).toUpperCase() +
        selectedMode.slice(1) +
        " Chess";
    }

    const time = document.getElementById("game-time");

    if (time && selectedTime) {
      time.textContent = selectedTime.replace("+", " + ");
    }
  });
}

console.log("ChessArena website loaded successfully!");