const express = require("express");
const http = require("http");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");
const db = require("./database");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ========================================
// GENERAL CONFIGURATION
// ========================================

app.set("trust proxy", 1);

app.use(express.json({ limit: "20kb" }));

// Protect private project files from public access

app.use((req, res, next) => {
  const blocked = [
    /^\/server\.js$/,
    /^\/server-backup\.js$/,
    /^\/database\.js$/,
    /^\/chessarena\.db(?:-wal|-shm)?$/,
    /^\/sessions\.db(?:-wal|-shm)?$/,
    /^\/package(?:-lock)?\.json$/,
    /^\/node_modules(?:\/|$)/,
    /^\/\.git(?:\/|$)/
  ];

  if (blocked.some(pattern => pattern.test(req.path))) {
    return res.sendStatus(404);
  }

  next();
});

// ========================================
// DATABASE INDEXES
// ========================================

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS
  idx_users_username_nocase
  ON users(username COLLATE NOCASE);

  CREATE UNIQUE INDEX IF NOT EXISTS
  idx_users_email_nocase
  ON users(email COLLATE NOCASE);
`);

// ========================================
// LOGIN SESSIONS
// ========================================

const sessionMiddleware = session({
  store: new SQLiteStore({
    db: "sessions.db",
    dir: __dirname
  }),

  secret: process.env.SESSION_SECRET || "CHANGE_THIS_SECRET_BEFORE_DEPLOYMENT",

  resave: false,
  saveUninitialized: false,

  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);

// Share login sessions with Socket.IO

io.engine.use(sessionMiddleware);

// Serve the website

app.use(express.static(__dirname));

// ========================================
// AUTHENTICATION HELPERS
// ========================================

function getPublicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email
  };
}

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      success: false,
      message: "Please log in to continue."
    });
  }

  next();
}

// ========================================
// HEALTH CHECK
// ========================================

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    message: "ChessArena server is running!"
  });
});

// ========================================
// REGISTER ACCOUNT
// ========================================

app.post("/api/auth/register", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = req.body.password;

    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({
        success: false,
        message: "Username must be 3–20 characters and contain only letters, numbers or underscores."
      });
    }

    if (
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address."
      });
    }

    if (
      typeof password !== "string" ||
      password.length < 8 ||
      password.length > 72
    ) {
      return res.status(400).json({
        success: false,
        message: "Password must contain between 8 and 72 characters."
      });
    }

    const existing = db.prepare(`
      SELECT id FROM users
      WHERE username = ? COLLATE NOCASE
      OR email = ? COLLATE NOCASE
    `).get(username, email);

    if (existing) {
      return res.status(409).json({
        success: false,
        message: "That username or email is already registered."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = db.prepare(`
      INSERT INTO users (username, email, password_hash)
      VALUES (?, ?, ?)
    `).run(username, email, passwordHash);

    const user = {
      id: Number(result.lastInsertRowid),
      username,
      email
    };

    req.session.regenerate((error) => {
      if (error) {
        console.error("Session error:", error);

        return res.status(500).json({
          success: false,
          message: "Account created, but login failed. Please log in."
        });
      }

      req.session.user = user;

      req.session.save((saveError) => {
        if (saveError) {
          console.error("Session save error:", saveError);

          return res.status(500).json({
            success: false,
            message: "Account created, but login failed. Please log in."
          });
        }

        res.status(201).json({
          success: true,
          message: "Your ChessArena account has been created!",
          user: getPublicUser(user)
        });
      });
    });

  } catch (error) {
    console.error("Registration error:", error);

    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({
        success: false,
        message: "Username or email already exists."
      });
    }

    res.status(500).json({
      success: false,
      message: "Unable to create your account right now."
    });
  }
});

// ========================================
// LOGIN
// ========================================

app.post("/api/auth/login", async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = req.body.password;

    if (!email || typeof password !== "string") {
      return res.status(400).json({
        success: false,
        message: "Enter your email and password."
      });
    }

    const user = db.prepare(`
      SELECT id, username, email, password_hash
      FROM users
      WHERE email = ? COLLATE NOCASE
    `).get(email);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Incorrect email or password."
      });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: "Incorrect email or password."
      });
    }

    req.session.regenerate((error) => {
      if (error) {
        console.error("Session regeneration error:", error);

        return res.status(500).json({
          success: false,
          message: "Unable to log in right now."
        });
      }

      req.session.user = getPublicUser(user);

      req.session.save((saveError) => {
        if (saveError) {
          console.error("Session save error:", saveError);

          return res.status(500).json({
            success: false,
            message: "Unable to save your login session."
          });
        }
                res.json({
          success: true,
          message: "Welcome back to ChessArena!",
          user: getPublicUser(user)
        });
      });
    });

  } catch (error) {
    console.error("Login error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to log in right now."
    });
  }
});

// ========================================
// CHECK CURRENT LOGIN
// ========================================

app.get("/api/auth/me", (req, res) => {
  if (!req.session.user) {
    return res.json({
      authenticated: false,
      user: null
    });
  }

  res.json({
    authenticated: true,
    user: req.session.user
  });
});

// ========================================
// LOGOUT
// ========================================

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({
        success: false,
        message: "Unable to log out."
      });
    }

    res.clearCookie("connect.sid", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production"
    });

    res.json({
      success: true,
      message: "You have logged out."
    });
  });
});

// ========================================
// PLAYER GAME HISTORY
// ========================================

app.get("/api/games", requireLogin, (req, res) => {
  const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
  const limit = 20;
  const offset = (page - 1) * limit;

  try {
    const games = db.prepare(`
      SELECT
        g.id,
        g.mode,
        g.time_control,
        g.result,
        g.reason,
        g.played_at,
        g.white_player_id,
        g.black_player_id,
        white.username AS white_username,
        black.username AS black_username
      FROM games g
      LEFT JOIN users white ON white.id = g.white_player_id
      LEFT JOIN users black ON black.id = g.black_player_id
      WHERE g.white_player_id = ?
      OR g.black_player_id = ?
      ORDER BY g.played_at DESC, g.id DESC
      LIMIT ? OFFSET ?
    `).all(
      req.session.user.id,
      req.session.user.id,
      limit,
      offset
    );

    res.json({
      success: true,
      page,
      games
    });

  } catch (error) {
    console.error("Game history error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to load game history."
    });
  }
});

// ========================================
// GET ONE SAVED GAME
// ========================================

app.get("/api/games/:id", requireLogin, (req, res) => {
  const gameId = Number.parseInt(req.params.id, 10);

  if (!Number.isSafeInteger(gameId) || gameId < 1) {
    return res.status(400).json({
      success: false,
      message: "Invalid game ID."
    });
  }

  try {
    const game = db.prepare(`
      SELECT
        g.*,
        white.username AS white_username,
        black.username AS black_username
      FROM games g
      LEFT JOIN users white ON white.id = g.white_player_id
      LEFT JOIN users black ON black.id = g.black_player_id
      WHERE g.id = ?
      AND (
        g.white_player_id = ?
        OR g.black_player_id = ?
      )
    `).get(
      gameId,
      req.session.user.id,
      req.session.user.id
    );

    if (!game) {
      return res.status(404).json({
        success: false,
        message: "Game not found."
      });
    }

    res.json({
      success: true,
      game
    });

  } catch (error) {
    console.error("Saved game error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to load this game."
    });
  }
});

// ========================================
// SAVE COMPLETED GAME
// ========================================

function saveCompletedGame(game, result, reason) {
  if (game.saved) return;

  // Guests can play, but their games are not stored

  if (!game.accounts.white && !game.accounts.black) return;

  game.saved = true;

  try {
    const pgn = game.chess.pgn();
    const finalFen = game.chess.fen();

    db.prepare(`
      INSERT INTO games (
        white_player_id,
        black_player_id,
        mode,
        time_control,
        result,
        reason,
        pgn,
        final_fen
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      game.accounts.white,
      game.accounts.black,
      game.mode,
      game.time,
      result,
      reason,
      pgn,
      finalFen
    );

    console.log("Completed game saved:", game.id);

  } catch (error) {
    game.saved = false;
    console.error("Could not save completed game:", error);
  }
}

// ========================================
// CHESS MATCHMAKING
// ========================================

const queues = {
  bullet: [],
  blitz: [],
  rapid: []
};

const games = new Map();
const RECONNECT_GRACE_MS = 30 * 1000;

function createReconnectToken() {
  return crypto.randomBytes(32).toString("hex");
}

function parseTimeControl(time) {
  const match = /^(\d+)\+(\d+)$/.exec(time || "");

  if (!match) return null;

  const base = Number(match[1]);
  const increment = Number(match[2]);

  if (
    !Number.isInteger(base) ||
    !Number.isInteger(increment) ||
    base < 1 ||
    base > 7200 ||
    increment < 0 ||
    increment > 60
  ) {
    return null;
  }

  return { base, increment };
}

function getPlayerColor(game, socketId) {
  if (game.players.white === socketId) return "white";
  if (game.players.black === socketId) return "black";
  return null;
}

// ========================================
// FINISH GAME
// ========================================

function finishGame(game, result, reason, saveToHistory = true) {
  if (!game.active) return;

  game.active = false;
  game.finalResult = result;
  game.finalReason = reason;

  if (game.disconnectTimer) {
    clearTimeout(game.disconnectTimer);
    game.disconnectTimer = null;
  }

  game.disconnectedColor = null;
  game.disconnectDeadline = null;

  // Aborted games should not be saved to history.

  if (saveToHistory) {
    saveCompletedGame(game, result, reason);
  }

  io.to(game.id).emit("game-over", {
    gameId: game.id,
    mode: game.mode,
    time: game.time,
    result,
    reason,
    clocks: game.clocks
  });

  console.log("Game finished:", game.id, result, reason);
}
// ========================================
// SERVER CLOCK
// ========================================

function updateClock(game, now = Date.now()) {
  if (!game.active) return false;

  // Freeze both players' clocks while a player is reconnecting.
  if (game.disconnectedColor) {
    game.lastClockUpdate = now;
    return true;
  }

  const elapsed = (now - game.lastClockUpdate) / 1000;
  const color = game.chess.turn() === "w" ? "white" : "black";

  game.clocks[color] = Math.max(
    0,
    game.clocks[color] - elapsed
  );

  game.lastClockUpdate = now;

  if (game.clocks[color] <= 0) {
    const winner = color === "white" ? "Black" : "White";

    finishGame(
      game,
      winner + " wins",
      color.charAt(0).toUpperCase() +
        color.slice(1) + " ran out of time"
    );

    return false;
  }

  return true;
}

function sendClocks(game) {
  io.to(game.id).emit("clock-update", {
    clocks: game.clocks,
    activeColor: game.disconnectedColor
      ? null
      : (game.chess.turn() === "w" ? "white" : "black"),
    paused: Boolean(game.disconnectedColor)
  });
}

// ========================================
// QUEUE MANAGEMENT
// ========================================

function removeFromQueues(socketId) {
  for (const queue of Object.values(queues)) {
    const index = queue.findIndex(player => player.id === socketId);

    if (index !== -1) {
      queue.splice(index, 1);
    }
  }
}

// ========================================
// CREATE CHESS GAME
// ========================================

function createGame(player1, player2, mode, time) {
  const control = parseTimeControl(time);

  if (!control || !player1.connected || !player2.connected) return;

  // Extra safety: never allow one account to play against itself.

  const user1 = player1.data.player || null;
  const user2 = player2.data.player || null;

  if (user1 && user2 && user1.id === user2.id) {
    console.log("Self-match blocked:", user1.username);
    return;
  }

  const gameId = `${Date.now()}-${player1.id}-${player2.id}`;

  const game = {
    id: gameId,
    mode,
    time,
    increment: control.increment,
    chess: new Chess(),

    players: {
      white: player1.id,
      black: player2.id
    },

    accounts: {
      white: user1?.id || null,
      black: user2?.id || null
    },

    playerNames: {
      white: user1?.username || "Guest",
      black: user2?.username || "Guest"
    },

    playerSockets: {
      white: player1,
      black: player2
    },

    clocks: {
      white: control.base,
      black: control.base
    },

    lastClockUpdate: Date.now(),
    startedAt: Date.now(),
    drawOfferBy: null,
    rematchOfferBy: null,
    saved: false,
    active: true,

    reconnectTokens: {
      white: createReconnectToken(),
      black: createReconnectToken()
    },

    disconnectedColor: null,
    disconnectDeadline: null,
    disconnectTimer: null,
    finalResult: null,
    finalReason: null
  };

  games.set(gameId, game);

  player1.join(gameId);
  player2.join(gameId);

  player1.emit("game-start", {
    gameId,
    mode,
    time,
    fen: game.chess.fen(),
    color: "white",
    opponent: game.playerNames.black,
    clocks: game.clocks,
    increment: game.increment,
    reconnectToken: game.reconnectTokens.white
  });

  player2.emit("game-start", {
    gameId,
    mode,
    time,
    fen: game.chess.fen(),
    color: "black",
    opponent: game.playerNames.white,
    clocks: game.clocks,
    increment: game.increment,
    reconnectToken: game.reconnectTokens.black
  });

  console.log("Game started:", gameId, mode, time);
}

// ========================================
// SERVER CLOCK LOOP
// ========================================

setInterval(() => {
  for (const game of games.values()) {
    if (game.active && updateClock(game)) {
      sendClocks(game);
    }
  }
}, 250);

// ========================================
// SOCKET.IO CONNECTION
// ========================================

io.on("connection", (socket) => {
  const sessionUser = socket.request.session?.user;

  socket.data.player = sessionUser
    ? {
        id: sessionUser.id,
        username: sessionUser.username
      }
    : null;

  console.log(
    "Player connected:",
    socket.data.player?.username || socket.id
  );

  // ========================================
  // REJOIN AN EXISTING GAME
  // ========================================

  socket.on("rejoin-game", ({ gameId, token } = {}) => {
    const game = games.get(gameId);

    if (!game || typeof token !== "string") {
      socket.emit("rejoin-failed", {
        message: "Your previous game could not be found. Please find a new opponent."
      });
      return;
    }

    const color = ["white", "black"].find(
      side => game.reconnectTokens[side] === token
    );

    if (!color) {
      socket.emit("rejoin-failed", {
        message: "Your reconnect session is no longer valid. Please find a new opponent."
      });
      return;
    }

    if (game.accounts[color] && socket.data.player?.id !== game.accounts[color]) {
      socket.emit("rejoin-failed", {
        message: "Please sign in with the account that started this game."
      });
      return;
    }

    if (!game.active) {
      socket.emit("rejoin-failed", {
        message: "This game has already ended.",
        result: game.finalResult,
        reason: game.finalReason
      });
      return;
    }

    // Do not allow a late reconnect if the 60-second deadline has passed,
    // even if Node.js has not run the timeout callback yet.
    if (
      game.disconnectedColor &&
      game.disconnectDeadline &&
      Date.now() >= game.disconnectDeadline
    ) {
      const abandonedColor = game.disconnectedColor;
      const winner = abandonedColor === "white" ? "Black" : "White";
      const leftColor = abandonedColor.charAt(0).toUpperCase() + abandonedColor.slice(1);
      const result = winner + " wins by abandonment";
      const reason = leftColor + " left the game and did not reconnect in time.";

      finishGame(game, result, reason);
      socket.emit("rejoin-failed", { message: "The reconnect time has expired.", result, reason });
      return;
    }

    const previousSocket = game.playerSockets[color];

    if (previousSocket?.connected && previousSocket.id !== socket.id) {
      socket.emit("rejoin-failed", {
        message: "This game is already open in another connected tab."
      });
      return;
    }

    if (game.disconnectedColor && game.disconnectedColor !== color) {
      socket.emit("rejoin-failed", {
        message: "The other player is currently reconnecting. Please wait."
      });
      return;
    }

    if (game.disconnectTimer) {
      clearTimeout(game.disconnectTimer);
      game.disconnectTimer = null;
    }

    const opponentColor = color === "white" ? "black" : "white";

    game.players[color] = socket.id;
    game.playerSockets[color] = socket;
    game.disconnectedColor = null;
    game.disconnectDeadline = null;
    game.lastClockUpdate = Date.now();

    // Rotate the token after successful use.
    game.reconnectTokens[color] = createReconnectToken();

    socket.join(game.id);

    const activeColor = game.chess.turn() === "w" ? "white" : "black";
    const resumeData = {
      gameId: game.id,
      mode: game.mode,
      time: game.time,
      fen: game.chess.fen(),
      history: game.chess.history(),
      color,
      opponent: game.playerNames[opponentColor],
      clocks: { ...game.clocks },
      activeColor,
      increment: game.increment,
      reconnectToken: game.reconnectTokens[color]
    };
        socket.emit("game-resumed", resumeData);

    const opponentSocket = game.playerSockets[opponentColor];
    if (opponentSocket?.connected) {
      opponentSocket.emit("opponent-reconnected", {
        color,
        clocks: { ...game.clocks },
        activeColor
      });
    }

    io.to(game.id).emit("clock-update", {
      clocks: { ...game.clocks },
      activeColor
    });

    console.log("Player rejoined game:", game.id, color);
  });

  // ========================================
  // FIND OPPONENT
  // ========================================

  socket.on("find-match", (data) => {
    const mode = data?.mode;
    const time = data?.time;
    const control = parseTimeControl(time);

    if (!queues[mode] || !control) {
      socket.emit("match-error", "Invalid game mode or time control.");
      return;
    }

    removeFromQueues(socket.id);

    // Do not match two sockets belonging to the same account.

    const opponentIndex = queues[mode].findIndex(player => {
      if (!player.socket.connected || player.time !== time) {
        return false;
      }

      const currentUser = socket.data.player;
      const waitingUser = player.socket.data.player;

      if (
        currentUser &&
        waitingUser &&
        currentUser.id === waitingUser.id
      ) {
        return false;
      }

      return true;
    });

    if (opponentIndex !== -1) {
      const opponent = queues[mode].splice(opponentIndex, 1)[0];

      createGame(opponent.socket, socket, mode, time);

    } else {
      queues[mode].push({
        id: socket.id,
        socket,
        time
      });

      socket.emit("waiting-for-opponent", {
        mode,
        time,
        message: "Searching for an opponent..."
      });
    }
  });

  // ========================================
  // CANCEL SEARCH
  // ========================================

  socket.on("cancel-search", () => {
    removeFromQueues(socket.id);
    socket.emit("search-cancelled");
  });

  // ========================================
  // MAKE MOVE
  // ========================================

  socket.on("make-move", ({ gameId, move } = {}) => {
    const game = games.get(gameId);

    if (!game || !game.active) return;

    if (game.disconnectedColor) return;

    const color = getPlayerColor(game, socket.id);

    if (!color || !updateClock(game)) return;

    const activeColor =
      game.chess.turn() === "w" ? "white" : "black";

    if (color !== activeColor) return;

    try {
      const result = game.chess.move(move);

      if (!result) {
        socket.emit("move-error", "That move is not legal.");
        return;
      }

      game.clocks[color] += game.increment;
      game.lastClockUpdate = Date.now();
      game.drawOfferBy = null;

      io.to(gameId).emit("move-made", {
        move: result,
        fen: game.chess.fen(),
        clocks: game.clocks,
        activeColor: game.chess.turn() === "w" ? "white" : "black",
        history: game.chess.history()
      });

      if (game.chess.isGameOver()) {
        let resultText = "Draw";

        if (game.chess.isCheckmate()) {
          resultText = color === "white" ? "White wins" : "Black wins";
        }

        finishGame(game, resultText, "Game completed");
      }

    } catch (error) {
      socket.emit("move-error", "Invalid move.");
    }
  });

  // ========================================
  // RESIGN
  // ========================================

  socket.on("resign-game", ({ gameId } = {}) => {
    const game = games.get(gameId);

    if (!game || !game.active) return;

    if (game.disconnectedColor) return;

    const color = getPlayerColor(game, socket.id);

    if (!color || !updateClock(game)) return;

    const winner = color === "white" ? "Black" : "White";

    finishGame(
      game,
      winner + " wins",
      color.charAt(0).toUpperCase() + color.slice(1) + " resigned"
    );
  });

  // ========================================
  // OFFER DRAW
  // ========================================

  socket.on("offer-draw", ({ gameId } = {}) => {
    const game = games.get(gameId);

    if (!game || !game.active) return;

    if (game.disconnectedColor) return;

    const color = getPlayerColor(game, socket.id);

    if (!color || !updateClock(game)) return;

    if (game.drawOfferBy) {
      socket.emit("game-action-error", "A draw offer is already pending.");
      return;
    }

    game.drawOfferBy = socket.id;

    const opponentId =
      color === "white" ? game.players.black : game.players.white;

    io.to(opponentId).emit("draw-offered", {
      from: color
    });

    // Confirm to the player who sent the offer.

    socket.emit("draw-offer-sent");
  });

  // ========================================
  // ACCEPT DRAW
  // ========================================

  socket.on("accept-draw", ({ gameId } = {}) => {
    const game = games.get(gameId);

    if (!game || !game.active || !game.drawOfferBy) return;

    if (game.disconnectedColor) return;

    const color = getPlayerColor(game, socket.id);

    if (!color || game.drawOfferBy === socket.id) return;
    if (!updateClock(game)) return;

    finishGame(game, "Draw", "Draw agreed");
  });

  // ========================================
  // DECLINE DRAW
  // ========================================

  socket.on("decline-draw", ({ gameId } = {}) => {
    const game = games.get(gameId);

    if (!game || !game.active || !game.drawOfferBy) return;

    if (game.disconnectedColor) return;

    const color = getPlayerColor(game, socket.id);

    if (!color || game.drawOfferBy === socket.id) return;

    const offerer = game.drawOfferBy;

    game.drawOfferBy = null;

    io.to(offerer).emit("draw-declined");
  });

  // ========================================
  // ABORT GAME
  // ========================================

  socket.on("abort-game", ({ gameId } = {}) => {
    const game = games.get(gameId);

    if (!game || !game.active) return;

    if (game.disconnectedColor) return;

    const color = getPlayerColor(game, socket.id);

    if (!color || !updateClock(game)) return;

    const movesPlayed = game.chess.history().length;

    // A game can only be aborted before the first move.

    if (movesPlayed > 0) {
      socket.emit(
        "game-action-error",
        "A game can only be aborted before the first move."
      );

      return;
    }

    // Aborted games are not saved to player history.

    finishGame(game, "Game aborted", "Game aborted", false);
  });

  // ========================================
  // REQUEST REMATCH
  // ========================================

  socket.on("request-rematch", ({ gameId } = {}) => {
    const game = games.get(gameId);

    if (!game || game.active) return;

    const color = getPlayerColor(game, socket.id);

    if (!color) return;

    if (game.rematchOfferBy) {
      socket.emit("game-action-error", "A rematch request is already pending.");
      return;
    }

    const opponentColor = color === "white" ? "black" : "white";
    const opponent = game.playerSockets[opponentColor];

    if (!opponent || !opponent.connected) {
      socket.emit("game-action-error", "Your opponent is no longer connected.");
      return;
    }

    game.rematchOfferBy = socket.id;

    opponent.emit("rematch-offered", {
      gameId,
      mode: game.mode,
      time: game.time
    });

    socket.emit("rematch-waiting");
  });

  // ========================================
  // ACCEPT REMATCH
  // ========================================

  socket.on("accept-rematch", ({ gameId } = {}) => {
    const game = games.get(gameId);

    if (!game || game.active || !game.rematchOfferBy) return;

    const color = getPlayerColor(game, socket.id);

    if (!color || game.rematchOfferBy === socket.id) return;

    const white = game.playerSockets.white;
    const black = game.playerSockets.black;

    if (!white?.connected || !black?.connected) {
      socket.emit("game-action-error", "Both players must be connected.");
      return;
    }

    // Extra protection against a self-match during rematches.

    const whiteUser = white.data.player;
    const blackUser = black.data.player;

    if (
      whiteUser &&
      blackUser &&
      whiteUser.id === blackUser.id
    ) {
      socket.emit("game-action-error", "The same account cannot play against itself.");
      return;
    }

    game.rematchOfferBy = null;

    createGame(white, black, game.mode, game.time);
  });

  // ========================================
  // DECLINE REMATCH
  // ========================================

  socket.on("decline-rematch", ({ gameId } = {}) => {
    const game = games.get(gameId);

    if (!game || game.active || !game.rematchOfferBy) return;

    const color = getPlayerColor(game, socket.id);

    if (!color || game.rematchOfferBy === socket.id) return;

    const requester = game.rematchOfferBy;

    game.rematchOfferBy = null;

    io.to(requester).emit("rematch-declined");
  });

  // ========================================
  // GAME CHAT
  // ========================================

  socket.on("game-chat", ({ gameId, message } = {}) => {
    const game = games.get(gameId);

    if (!game || !game.active) return;

    if (game.disconnectedColor) return;

    const color = getPlayerColor(game, socket.id);

    if (!color || typeof message !== "string") return;

    const cleanMessage = message.trim();

    if (!cleanMessage || cleanMessage.length > 300) return;

    io.to(gameId).emit("game-chat", {
      name: color === "white"
        ? game.playerNames.white
        : game.playerNames.black,

      message: cleanMessage,

      time: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      })
    });
  });

  // ========================================
  // PLAYER DISCONNECTS
  // ========================================

  socket.on("disconnect", () => {
    removeFromQueues(socket.id);

    for (const game of games.values()) {
      const color = getPlayerColor(game, socket.id);

      if (!color || !game.active || game.disconnectedColor) continue;

      // Capture the exact clock time before pausing the game.
      if (!updateClock(game)) continue;

      const opponentColor = color === "white" ? "black" : "white";
      const opponentSocket = game.playerSockets[opponentColor];

      game.disconnectedColor = color;
      game.disconnectDeadline = Date.now() + RECONNECT_GRACE_MS;
      game.lastClockUpdate = Date.now();

      if (opponentSocket?.connected) {
        opponentSocket.emit("opponent-disconnected", {
          color,
          playerName: game.playerNames[color],
          seconds: 60,
          deadline: game.disconnectDeadline,
          clocks: { ...game.clocks }
        });
      }

      game.disconnectTimer = setTimeout(() => {
        if (!game.active || game.disconnectedColor !== color) return;

        const winner = color === "white" ? "Black" : "White";
        const leftColor = color.charAt(0).toUpperCase() + color.slice(1);

        finishGame(
          game,
          winner + " wins by abandonment",
          leftColor + " left the game and did not reconnect in time."
        );
      }, RECONNECT_GRACE_MS);

      console.log("Player disconnected; reconnect countdown started:", game.id, color);
    }

    console.log("Player disconnected:", socket.id);
  });
});

// ========================================
// START SERVER
// ========================================

const PORT = process.env.PORT || 3000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ChessArena server running on port ${PORT}`);
});