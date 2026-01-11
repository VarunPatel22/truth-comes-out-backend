import "dotenv/config";
import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import admin from "firebase-admin";
import path from "path";
import fs from "fs";

// ---------------- BASIC SETUP ----------------
const app = express();
app.use(cors());
app.use(express.json());

// Serve static 'public' so admin.html can be placed in ./public/admin.html
app.use(express.static(path.join(process.cwd(), 'public')));

// Serve static assets (icons)
app.use('/icons', express.static(path.join(process.cwd(), 'public', 'icons')));
app.use('/icons', express.static(path.join(process.cwd(), 'frontend', 'icons')));

// Health route
app.get('/', (req, res) => res.send('Socket server running'));

// ---------------- HTTP + SOCKET.IO ----------------
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ---------------- FIREBASE INIT (ENV BASED) ----------------
let db = null;

try {
  if (
    !process.env.FIREBASE_PROJECT_ID ||
    !process.env.FIREBASE_CLIENT_EMAIL ||
    !process.env.FIREBASE_PRIVATE_KEY
  ) {
    throw new Error("Missing Firebase ENV variables");
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });

  db = admin.firestore();
  console.log("✅ Firebase connected using ENV credentials");
} catch (err) {
  console.error("❌ Firebase init failed:", err.message);
}

// ---------- ADMIN AUTH MIDDLEWARE ----------
function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ---------------- GAME STATE ----------------
const rooms = {};

// 🔹 ADDED: Fisher–Yates shuffle (SAFE & FAIR)
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Helper to broadcast name->score mapping
function emitScores(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const mapping = {};
  Object.keys(room.players).forEach(id => {
    const playerObj = room.players[id];
    const displayName = playerObj?.name || String(id);
    mapping[displayName] = room.scores[id] || 0;
  });
  io.to(roomCode).emit("scores-update", mapping);
}

// ---------------- SOCKET LOGIC ----------------
io.on("connection", socket => {
  console.log("🔌 client connected", socket.id);

  socket.on("create-room", ({ name, avatar }) => {
    const roomCode = generateRoomCode();

    rooms[roomCode] = {
      host: socket.id,
      players: {
        [socket.id]: { name: name || "Host", avatar: avatar || "/icons/icon-1.jpg" }
      },
      scores: { [socket.id]: 0 },

      // 🔹 ADDED: name rotation system
      nameQueue: [],
      usedNames: [],

      answers: [],
      submitted: new Set(),
      phase: "lobby",
      round: 0,
      maxRounds: 10,
      timer: null,
      voteStarted: false,
      votes: {}
    };

    socket.join(roomCode);

    socket.emit("room-created", {
      roomCode,
      players: Object.values(rooms[roomCode].players),
      host: rooms[roomCode].host
    });

    io.to(roomCode).emit("player-update", {
      players: Object.values(rooms[roomCode].players),
      host: rooms[roomCode].host
    });

    emitScores(roomCode);
  });

  socket.on("join-room", ({ roomCode, name, avatar }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.players[socket.id] = { name: name || "Player", avatar: avatar || "/icons/icon-1.jpg" };
    room.scores[socket.id] = 0;

    // 🔹 RESET queue so new player is included
    room.nameQueue = [];
    room.usedNames = [];

    socket.join(roomCode);

    io.to(roomCode).emit("player-update", {
      players: Object.values(room.players),
      host: room.host
    });

    emitScores(roomCode);
  });

  socket.on("set-rounds", ({ roomCode, rounds }) => {
    if (rooms[roomCode]?.host === socket.id) {
      rooms[roomCode].maxRounds = rounds;
      io.to(roomCode).emit("rounds-updated", { maxRounds: rounds });
    }
  });

  socket.on("start-game", roomCode => {
    if (rooms[roomCode]?.host !== socket.id) return;
    rooms[roomCode].round = 0;
    startRound(roomCode);
  });

  async function startRound(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.phase = "answer";
    room.voteStarted = false;
    room.answers = [];
    room.submitted.clear();
    room.votes = {};

    let questionText = "Say something funny 😄";

    // 🔹 INITIALIZE / REFILL NAME QUEUE FAIRLY
    if (!room.nameQueue || room.nameQueue.length === 0) {
      const allNames = Object.values(room.players).map(p => p.name);
      room.nameQueue = shuffleArray([...allNames]);
      room.usedNames = [];
    }

    // 🔹 TAKE NEXT NAME (NO REPEAT UNTIL ALL USED)
    const chosenName = room.nameQueue.shift();
    room.usedNames.push(chosenName);

    if (db) {
      try {
        const snap = await db.collection("questions").get();
        const valid = snap.docs.map(d => d.data()).filter(q => q?.text);

        if (valid.length) {
          const q = valid[Math.floor(Math.random() * valid.length)];

          if (q.text.includes("{{name}}")) {
            questionText = q.text.replace(/\{\{name\}\}/gi, chosenName);
          } else {
            questionText = `About ${chosenName}: ${q.text}`;
          }
        }
      } catch (e) {
        console.warn("⚠ Error fetching questions from Firestore:", e.message);
      }
    }

    io.to(roomCode).emit("new-question", { text: questionText });
    emitScores(roomCode);

    clearTimeout(room.timer);
    room.timer = setTimeout(() => forceVote(roomCode), 60000);
  }

  socket.on("submit-answer", ({ roomCode, answer }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== "answer") return;
    if (room.submitted.has(socket.id)) return;

    room.submitted.add(socket.id);
    room.answers.push({ author: socket.id, text: answer || "🤡" });

    io.to(roomCode).emit("submission-update", {
      submitted: room.submitted.size,
      total: Object.keys(room.players).length
    });

    if (room.submitted.size === Object.keys(room.players).length) {
      forceVote(roomCode);
    }
  });

  function forceVote(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.voteStarted) return;

    room.voteStarted = true;
    room.phase = "vote";
    clearTimeout(room.timer);

    io.to(roomCode).emit("phase-vote", room.answers);
    emitScores(roomCode);
  }

  socket.on("vote", ({ roomCode, votedFor }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== "vote") return;
    if (room.votes[socket.id]) return;
    if (votedFor === socket.id) return;

    room.votes[socket.id] = votedFor;
    if (room.scores[votedFor] !== undefined) {
      room.scores[votedFor]++;
    }

    emitScores(roomCode);

    const totalPlayers = Object.keys(room.players).length;
    const votesCount = Object.keys(room.votes).length;

    if (votesCount >= totalPlayers) {
      room.round++;
      if (room.round >= room.maxRounds) {
        setTimeout(() => endGame(roomCode), 2000);
      } else {
        setTimeout(() => startRound(roomCode), 2000);
      }
    }
  });

  function endGame(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    const scores = {};
    Object.keys(room.players).forEach(id => {
      const displayName = room.players[id].name;
      scores[displayName] = room.scores[id];
    });
    io.to(roomCode).emit("game-over", scores);
  }

  socket.on("disconnect", () => {
    Object.keys(rooms).forEach(rc => {
      const room = rooms[rc];
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        delete room.scores[socket.id];

        // 🔹 RESET queue on player leave
        room.nameQueue = [];
        room.usedNames = [];

        if (room.host === socket.id) {
          const remaining = Object.keys(room.players);
          room.host = remaining.length ? remaining[0] : null;
        }

        io.to(rc).emit("player-update", {
          players: Object.values(room.players),
          host: room.host
        });

        emitScores(rc);
      }
    });
    console.log("🔌 client disconnected", socket.id);
  });
});

// ---------- ADMIN ROUTES (UNCHANGED) ----------
app.get("/admin/questions", adminAuth, async (req, res) => {
  const snap = await db.collection("questions").orderBy("createdAt", "desc").get();
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
});

app.post("/admin/questions", adminAuth, async (req, res) => {
  const doc = await db.collection("questions").add({
    text: req.body.text,
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  res.json({ success: true, id: doc.id });
});

app.delete("/admin/questions/:id", adminAuth, async (req, res) => {
  await db.collection("questions").doc(req.params.id).delete();
  res.json({ success: true });
});

server.listen(process.env.PORT || 3000, () =>
  console.log("🚀 Server running on port", process.env.PORT || 3000)
);
