/* global io */

const socket = io();

const joinSection = document.getElementById("joinSection");
const gameSection = document.getElementById("gameSection");

const nameInput = document.getElementById("nameInput");
const codeInput = document.getElementById("codeInput");
const quickMatchBtn = document.getElementById("quickMatchBtn");
const customRoomBtn = document.getElementById("customRoomBtn");
const joinBtn = document.getElementById("joinBtn");
const backBtn = document.getElementById("backBtn");
const statusText = document.getElementById("statusText");
const hintText = document.getElementById("hintText");

const playerCountSection = document.getElementById("playerCountSection");
const customRoomSection = document.getElementById("customRoomSection");
const roomInfoBox = document.getElementById("roomInfoBox");
const roomCodeText = document.getElementById("roomCodeText");
const statusTag = document.getElementById("statusTag");
const startBtn = document.getElementById("startBtn");
const callNumberInput = document.getElementById("callNumberInput");
const callBtn = document.getElementById("callBtn");
const randomBtn = document.getElementById("randomBtn");
const playerCountDisplay = document.getElementById("playerCountDisplay");

const cardEl = document.getElementById("card");
const calledEl = document.getElementById("called");
const winnerBox = document.getElementById("winnerBox");
const playersEl = document.getElementById("players");

let myPlayerId = null;
let isHost = false;
let status = "waiting";
let myCard = null;
let calledSet = new Set();
let calledNumbers = [];
let activePlayerId = null;
let selectedPlayerCount = 2;
let isQuickMatch = false;
let currentMaxPlayers = 2;

function setStatusTag(nextStatus) {
  statusTag.textContent = nextStatus;
  statusTag.dataset.status = nextStatus;
}

function renderCard() {
  cardEl.innerHTML = "";
  if (!myCard) return;

  for (let i = 0; i < 25; i++) {
    const n = myCard[i];
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.textContent = String(n);
    if (calledSet.has(n)) cell.classList.add("called");
    cardEl.appendChild(cell);
  }
}

function renderCalledNumbers() {
  calledEl.innerHTML = "";
  if (!calledNumbers.length) {
    calledEl.textContent = "None yet.";
    return;
  }
  for (const n of calledNumbers) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = String(n);
    calledEl.appendChild(chip);
  }
}

function updateButtons() {
  const canCall = status === "playing" && myPlayerId && activePlayerId === myPlayerId;

  // Show start button only for custom rooms
  startBtn.style.display = isQuickMatch ? "none" : "block";
  startBtn.disabled = !(status === "waiting" || status === "finished") || !isHost;
  callNumberInput.disabled = !canCall;
  callBtn.disabled = !canCall;
  randomBtn.disabled = !canCall;
}

function setWinnerBox(winnerId, winnerName) {
  if (winnerId && winnerId === myPlayerId) {
    winnerBox.textContent = "🎉 BINGO! You win! 🎉";
    return;
  }

  if (winnerName) {
    winnerBox.textContent = `🏆 ${winnerName} wins! 🏆`;
    return;
  }

  winnerBox.textContent = "Game ended (no winner).";
}

function renderPlayers(players) {
  playersEl.innerHTML = "";
  if (!players || players.length === 0) {
    playersEl.textContent = "No players yet.";
    return;
  }

  for (const p of players) {
    const row = document.createElement("div");
    row.className = "playerRow";
    row.textContent = p.id === myPlayerId ? `${p.name} (You)` : p.name;
    if (p.id === myPlayerId) row.classList.add("me");
    playersEl.appendChild(row);
  }
}

function hideJoinShowGame() {
  joinSection.classList.add("hidden");
  gameSection.classList.remove("hidden");
}

function showJoinHideGame() {
  joinSection.classList.remove("hidden");
  gameSection.classList.add("hidden");
}

function setQuickMatchMode() {
  playerCountSection.classList.remove("hidden");
  customRoomSection.classList.add("hidden");
  quickMatchBtn.classList.add("hidden");
  customRoomBtn.classList.add("hidden");
  joinBtn.classList.add("hidden");
  backBtn.classList.remove("hidden");
  hintText.textContent = "Select the number of players and click Join to find an opponent.";
  statusText.textContent = "";
  selectedPlayerCount = 2;
  updatePlayerCountButtons();
}

function setCustomRoomMode() {
  playerCountSection.classList.add("hidden");
  customRoomSection.classList.remove("hidden");
  quickMatchBtn.classList.add("hidden");
  customRoomBtn.classList.add("hidden");
  joinBtn.classList.remove("hidden");
  backBtn.classList.remove("hidden");
  hintText.textContent = "Enter a room code and select player count, then click Join Room.";
  statusText.textContent = "";
  selectedPlayerCount = 2;
  updatePlayerCountButtons();
}

function setInitialMode() {
  playerCountSection.classList.add("hidden");
  customRoomSection.classList.add("hidden");
  quickMatchBtn.classList.remove("hidden");
  customRoomBtn.classList.remove("hidden");
  joinBtn.classList.add("hidden");
  backBtn.classList.add("hidden");
}

function updatePlayerCountButtons() {
  const isCustom = !playerCountSection.classList.contains("hidden");
  const buttons = isCustom
    ? document.querySelectorAll("#playerCountSection .playerCountBtn")
    : document.querySelectorAll(".customCountBtn");

  buttons.forEach((btn) => {
    btn.classList.remove("selected");
    if (Number(btn.dataset.count) === selectedPlayerCount) {
      btn.classList.add("selected");
    }
  });
}

// Player count selection for Quick Match
document.getElementById("players2Btn").addEventListener("click", () => {
  selectedPlayerCount = 2;
  updatePlayerCountButtons();
});

document.getElementById("players3Btn").addEventListener("click", () => {
  selectedPlayerCount = 3;
  updatePlayerCountButtons();
});

document.getElementById("players4Btn").addEventListener("click", () => {
  selectedPlayerCount = 4;
  updatePlayerCountButtons();
});

// Player count selection for Custom Room
document.getElementById("customPlayers2Btn").addEventListener("click", () => {
  selectedPlayerCount = 2;
  updatePlayerCountButtons();
});

document.getElementById("customPlayers3Btn").addEventListener("click", () => {
  selectedPlayerCount = 3;
  updatePlayerCountButtons();
});

document.getElementById("customPlayers4Btn").addEventListener("click", () => {
  selectedPlayerCount = 4;
  updatePlayerCountButtons();
});

customRoomBtn.addEventListener("click", () => {
  setCustomRoomMode();
});

quickMatchBtn.addEventListener("click", () => {
  setQuickMatchMode();
});

backBtn.addEventListener("click", () => {
  setInitialMode();
  codeInput.value = "";
});

// Find opponent for Quick Match
document.querySelectorAll("#playerCountSection .playerCountBtn").forEach((btn) => {
  btn.addEventListener("click", function () {
    // This button double serves to select count and join
    setTimeout(() => {
      const name = nameInput.value.trim();
      if (!name) {
        statusText.textContent = "Enter your name first.";
        return;
      }

      statusText.textContent = `Searching for ${selectedPlayerCount} players...`;

      socket.emit(
        "room:join",
        { name, code: null, maxPlayers: selectedPlayerCount },
        (resp) => {
          if (!resp?.ok) statusText.textContent = "Failed to join.";
          else statusText.textContent = "Connected!";
        }
      );
    }, 50);
  });
});

joinBtn.addEventListener("click", () => {
  const name = nameInput.value.trim();
  const code = codeInput.value.trim().toUpperCase();

  if (!name) {
    statusText.textContent = "Enter your name first.";
    return;
  }
  if (!code) {
    statusText.textContent = "Enter room code.";
    return;
  }

  statusText.textContent = "Joining custom room...";

  socket.emit(
    "room:join",
    { name, code, maxPlayers: selectedPlayerCount },
    (resp) => {
      if (!resp?.ok) statusText.textContent = "Failed to join.";
      else statusText.textContent = "Connected!";
    }
  );
});

startBtn.addEventListener("click", () => {
  socket.emit("host:start");
});

callBtn.addEventListener("click", () => {
  const n = Number(callNumberInput.value);
  if (!Number.isInteger(n)) return;
  socket.emit("game:callNumber", { number: n });
  callNumberInput.value = "";
});

randomBtn.addEventListener("click", () => {
  socket.emit("game:callRandom");
});

socket.on("room:joined", (payload) => {
  myPlayerId = payload.playerId;
  isHost = Boolean(payload.isHost);
  status = payload.status || "waiting";
  activePlayerId = payload.activePlayerId || null;
  isQuickMatch = Boolean(payload.quickMatchRoom);
  currentMaxPlayers = payload.maxPlayers || 2;

  // Hide room code for quick match games
  if (isQuickMatch) {
    roomInfoBox.classList.add("hidden");
  } else {
    roomInfoBox.classList.remove("hidden");
    roomCodeText.textContent = payload.roomCode;
  }

  playerCountDisplay.textContent = currentMaxPlayers;
  setStatusTag(status);
  
  // Update start button visibility
  startBtn.style.display = isQuickMatch ? "none" : "block";
  
  updateButtons();

  calledNumbers = Array.isArray(payload.calledNumbers) ? payload.calledNumbers.slice() : [];
  calledSet = new Set(calledNumbers);

  myCard = payload.card || null;
  renderCard();
  renderCalledNumbers();
  winnerBox.textContent = "";
  if (payload.winnerName || payload.winnerId) {
    setWinnerBox(payload.winnerId, payload.winnerName);
  }

  renderPlayers([{ id: payload.playerId, name: nameInput.value.trim() || "Player" }]);

  hideJoinShowGame();
});

socket.on("room:players", (payload) => {
  renderPlayers(payload.players);
});

socket.on("room:hostChanged", (payload) => {
  isHost = payload.hostId === myPlayerId;
  updateButtons();
});

socket.on("player:card", (payload) => {
  myCard = payload.card;

  // Called numbers are shared room state, so just re-render highlights.
  // (If host:start already emitted game:started, we will re-sync anyway.)
  renderCard();
});

socket.on("game:started", (payload) => {
  status = payload.status || "playing";
  setStatusTag(status);
  calledNumbers = [];
  calledSet = new Set();
  activePlayerId = null;
  winnerBox.textContent = "";
  renderCalledNumbers();
  renderCard();
  updateButtons();
});

socket.on("game:turn", (payload) => {
  activePlayerId = payload?.activePlayerId || null;
  updateButtons();
});

socket.on("game:called", (payload) => {
  status = payload.status || status;
  setStatusTag(status);

  const number = payload.number;
  if (typeof number === "number" && !calledSet.has(number)) {
    calledSet.add(number);
    calledNumbers.push(number);
  } else if (Array.isArray(payload.calledNumbers)) {
    // If we got a full list, trust it.
    calledNumbers = payload.calledNumbers.slice();
    calledSet = new Set(calledNumbers);
  }

  renderCalledNumbers();
  renderCard();
  updateButtons();
});

socket.on("game:finished", (payload) => {
  status = payload.status || "finished";
  setStatusTag(status);
  activePlayerId = null;
  updateButtons();
  setWinnerBox(payload.winnerId, payload.winnerName);
});

// Initialize UI
setInitialMode();