const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

app.use(express.static(path.join(__dirname, "public")));

function shuffle(array) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateRoomCode() {
  let out = "";
  for (let i = 0; i < 6; i++) out += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return out;
}

function generateCard25() {
  // 5x5 grid, numbers 1..25 each exactly once (no FREE tile).
  return shuffle(Array.from({ length: 25 }, (_, i) => i + 1));
}

const LINES_5X5 = (() => {
  const lines = [];
  // rows
  for (let r = 0; r < 5; r++) {
    lines.push(Array.from({ length: 5 }, (_, c) => r * 5 + c));
  }
  // cols
  for (let c = 0; c < 5; c++) {
    lines.push(Array.from({ length: 5 }, (_, r) => r * 5 + c));
  }
  // diag TL->BR
  lines.push(Array.from({ length: 5 }, (_, i) => i * 5 + i));
  // diag TR->BL
  lines.push(Array.from({ length: 5 }, (_, i) => i * 5 + (4 - i)));
  return lines;
})();

function hasBingoForCard(card, calledSet) {
  for (const idxs of LINES_5X5) {
    let ok = true;
    for (const idx of idxs) {
      const n = card[idx];
      if (!calledSet.has(n)) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function callNumberForRoom(room, number) {
  room.calledNumbers.push(number);
  room.calledSet.add(number);

  io.to(room.code).emit("game:called", {
    number,
    calledNumbers: room.calledNumbers,
    status: room.status,
  });

  // Check winners.
  let winner = null;
  for (const p of room.players.values()) {
    if (hasBingoForCard(p.card, room.calledSet)) {
      winner = p;
      break;
    }
  }

  if (winner) {
    room.status = "finished";
    room.winnerId = winner.id;
    room.winnerName = winner.name;
    io.to(room.code).emit("game:finished", {
      winnerId: room.winnerId,
      winnerName: room.winnerName,
      status: room.status,
    });
    return true;
  }

  // If all 1..25 are called and nobody won, finish the game.
  if (room.calledSet.size >= 25) {
    room.status = "finished";
    room.winnerId = null;
    room.winnerName = null;
    io.to(room.code).emit("game:finished", {
      winnerId: null,
      winnerName: null,
      status: room.status,
    });
    return true;
  }

  return false;
}

function getRemainingNumbers(room) {
  const remaining = [];
  for (let n = 1; n <= 25; n++) {
    if (!room.calledSet.has(n)) remaining.push(n);
  }
  return remaining;
}

function setNewTurnOrder(room, starterSocketId) {
  // Preserve join order (Map insertion order) as the turn order.
  room.turnOrder = Array.from(room.players.values()).map((p) => p.id);
  if (room.turnOrder.length === 0) {
    room.activePlayerId = null;
    return;
  }

  const startIdx = room.turnOrder.indexOf(starterSocketId);
  room.activePlayerId = startIdx >= 0 ? room.turnOrder[startIdx] : room.turnOrder[0];
}

function advanceTurn(room) {
  if (!room.turnOrder || room.turnOrder.length === 0) return;
  const idx = room.turnOrder.indexOf(room.activePlayerId);
  const nextIdx = idx >= 0 ? (idx + 1) % room.turnOrder.length : 0;
  room.activePlayerId = room.turnOrder[nextIdx];
}

function startGame(room, starterSocketId) {
  room.status = "playing";
  room.calledNumbers = [];
  room.calledSet = new Set();
  room.winnerId = null;
  room.winnerName = null;

  setNewTurnOrder(room, starterSocketId);

  // Re-roll cards for this game.
  for (const p of room.players.values()) {
    p.card = generateCard25();
    io.to(p.id).emit("player:card", { card: p.card, status: room.status, calledNumbers: room.calledNumbers });
  }

  io.to(room.code).emit("game:started", { calledNumbers: room.calledNumbers, status: room.status });
  io.to(room.code).emit("game:turn", { activePlayerId: room.activePlayerId });
  emitPlayersList(room);
}

/**
 * Room state shape:
 * {
 *  code, hostId, hostName,
 *  players: Map<socketId, {id, name, card: number[]}>,
 *  status: 'waiting'|'playing'|'finished',
 *  calledNumbers: number[],
 *  calledSet: Set<number>,
 *  winnerId: string|null,
 *  winnerName: string|null
 * }
 */
const rooms = new Map();

function getOrCreateRoom(code, hostSocket, quickMatchRoom = false, maxPlayers = 2) {
  if (code && rooms.has(code)) return rooms.get(code);

  let finalCode = code;
  if (!finalCode) {
    do {
      finalCode = generateRoomCode();
    } while (rooms.has(finalCode));
  }

  const room = {
    code: finalCode,
    hostId: hostSocket.id,
    hostName: hostSocket.data?.playerName || "Host",
    quickMatchRoom,
    maxPlayers: Math.max(2, Math.min(4, maxPlayers)),
    players: new Map(),
    status: "waiting",
    calledNumbers: [],
    calledSet: new Set(),
    winnerId: null,
    winnerName: null,
    turnOrder: [],
    activePlayerId: null,
  };

  rooms.set(finalCode, room);
  return room;
}

function findAutoMatchRoom(maxPlayers) {
  // Join any "waiting" room with same maxPlayers that's not full.
  for (const room of rooms.values()) {
    if (
      room.quickMatchRoom &&
      room.status === "waiting" &&
      room.maxPlayers === maxPlayers &&
      room.players.size < room.maxPlayers
    ) {
      return room;
    }
  }
  return null;
}

function emitPlayersList(room) {
  const players = Array.from(room.players.values()).map((p) => ({ id: p.id, name: p.name }));
  io.to(room.code).emit("room:players", { players });
}

io.on("connection", (socket) => {
  socket.on("room:join", (payload, ack) => {
    const name = String(payload?.name || "").trim().slice(0, 30) || "Player";
    const requestedCode = payload?.code ? String(payload.code).trim().toUpperCase() : null;
    const maxPlayers = payload?.maxPlayers ? Number(payload.maxPlayers) : 2;

    socket.data.playerName = name;

    // If no room code is provided, auto-match into an existing waiting QUICK-MATCH room.
    // If none exists, create a new one.
    const room = requestedCode
      ? getOrCreateRoom(requestedCode, socket, false, maxPlayers)
      : findAutoMatchRoom(maxPlayers) || getOrCreateRoom(null, socket, true, maxPlayers);
    const code = room.code;

    socket.data.roomCode = code;
    socket.join(code);

    // Add or update player.
    let player = room.players.get(socket.id);
    if (!player) {
      player = { id: socket.id, name, card: generateCard25() };
      room.players.set(socket.id, player);
    } else {
      player.name = name;
    }

    // If host and room was just created with different hostName, keep it aligned.
    if (!room.hostId) room.hostId = socket.id;
    if (room.hostId === socket.id) room.hostName = name;

    // If room was created earlier with a different host, keep existing hostName.
    // (No-op if host already correct.)

    emitPlayersList(room);

    // Auto-start quick-match games once max players are reached.
    if (room.quickMatchRoom && room.status === "waiting" && room.players.size >= room.maxPlayers) {
      console.log(`Auto-starting quick match room ${code} with ${room.players.size} players`);
      startGame(room, room.hostId);
    }

    const isHost = socket.id === room.hostId;
    ack?.({
      ok: true,
      roomCode: room.code,
      playerId: socket.id,
      isHost,
    });

    // Initial state sync for this player.
    socket.emit("room:joined", {
      roomCode: room.code,
      playerId: socket.id,
      hostId: room.hostId,
      hostName: room.hostName,
      isHost,
      status: room.status,
      calledNumbers: room.calledNumbers,
      card: player.card,
      activePlayerId: room.activePlayerId,
      winnerId: room.winnerId,
      winnerName: room.winnerName,
      quickMatchRoom: room.quickMatchRoom,
      maxPlayers: room.maxPlayers,
      currentPlayers: room.players.size,
    });

    // If someone joins mid-game and they already have a bingo, declare it immediately.
    if (room.status === "playing" && !room.winnerId) {
      if (hasBingoForCard(player.card, room.calledSet)) {
        room.status = "finished";
        room.winnerId = player.id;
        room.winnerName = player.name;
        io.to(room.code).emit("game:finished", {
          winnerId: room.winnerId,
          winnerName: room.winnerName,
          status: room.status,
        });
      }
    }
  });

  socket.on("host:start", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    // Any player can start the game; starterSocketId becomes the first caller in turn order.
    startGame(room, socket.id);
  });

  socket.on("game:callNumber", (payload, ack) => {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;
    if (room.status !== "playing" || room.winnerId) {
      ack?.({ ok: false, error: "Game not active." });
      return;
    }

    if (room.activePlayerId && socket.id !== room.activePlayerId) {
      ack?.({ ok: false, error: "Not your turn." });
      return;
    }

    const number = Number(payload?.number);
    if (!Number.isInteger(number) || number < 1 || number > 25) {
      ack?.({ ok: false, error: "Number must be 1-25." });
      return;
    }

    if (room.calledSet.has(number)) {
      ack?.({ ok: false, error: "Already called." });
      return;
    }

    const finished = callNumberForRoom(room, number);
    if (!finished) {
      advanceTurn(room);
      io.to(room.code).emit("game:turn", { activePlayerId: room.activePlayerId });
    }
    ack?.({ ok: true });
  });

  socket.on("game:callRandom", (ack) => {
    const code = socket.data.roomCode;
    if (!code) return;

    const room = rooms.get(code);
    if (!room) return;
    if (room.status !== "playing" || room.winnerId) {
      ack?.({ ok: false, error: "Game not active." });
      return;
    }

    if (room.activePlayerId && socket.id !== room.activePlayerId) {
      ack?.({ ok: false, error: "Not your turn." });
      return;
    }

    const remaining = getRemainingNumbers(room);
    if (remaining.length === 0) {
      ack?.({ ok: false, error: "No numbers left." });
      return;
    }

    const randomNumber = remaining[Math.floor(Math.random() * remaining.length)];
    const finished = callNumberForRoom(room, randomNumber);
    if (!finished) {
      advanceTurn(room);
      io.to(room.code).emit("game:turn", { activePlayerId: room.activePlayerId });
    }
    ack?.({ ok: true, number: randomNumber });
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const wasPlaying = room.status === "playing";
    const oldTurnOrder = room.turnOrder ? room.turnOrder.slice() : [];
    const oldActiveId = room.activePlayerId;
    const oldActiveIndex = oldTurnOrder.indexOf(oldActiveId);

    room.players.delete(socket.id);

    if (room.players.size === 0) {
      rooms.delete(code);
      return;
    }

    // If it was someone's turn who disconnected, advance to the next remaining player.
    if (wasPlaying) {
      const newTurnOrder = Array.from(room.players.values()).map((p) => p.id);
      room.turnOrder = newTurnOrder;

      if (room.activePlayerId === socket.id || oldActiveIndex !== -1) {
        const nextOldIdx = oldTurnOrder.length > 0 ? (oldActiveIndex + 1) % oldTurnOrder.length : 0;
        const candidate = oldTurnOrder[nextOldIdx];
        room.activePlayerId = newTurnOrder.length > 0 ? (newTurnOrder.includes(candidate) ? candidate : newTurnOrder[0]) : null;
        io.to(code).emit("game:turn", { activePlayerId: room.activePlayerId });
      }
    }

    // Host promotion if needed.
    if (room.hostId === socket.id) {
      const remaining = Array.from(room.players.values());
      const nextHost = remaining[0];
      room.hostId = nextHost.id;
      room.hostName = nextHost.name;
      io.to(code).emit("room:hostChanged", { hostId: room.hostId, hostName: room.hostName });
    }

    emitPlayersList(room);
  });
});

const START_PORT = Number(process.env.PORT) || 3000;

function listenWithFallback(port) {
  server.once("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.warn(`Port ${port} is in use; trying ${port + 1}...`);
      listenWithFallback(port + 1);
      return;
    }
    throw err;
  });

  server.listen(port, () => {
    console.log(`Bingo server listening on http://localhost:${port}`);
  });
}

listenWithFallback(START_PORT);

