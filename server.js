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

// Serve static 'public' for admin page if present
app.use(express.static(path.join(process.cwd(), 'public')));

// Serve icons
app.use('/icons', express.static(path.join(process.cwd(), 'public', 'icons')));
app.use('/icons', express.static(path.join(process.cwd(), 'frontend', 'icons')));

// Health route
app.get('/', (req, res) => res.send('Socket server running'));

// ---------------- HTTP + SOCKET.IO ----------------
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
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
  db = null;
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

// Small internal fallback questions if Firestore is empty / unavailable
const FALLBACK_QUESTIONS = [
  "Say something funny 😄",
  "What's your most embarrassing moment?",
  "Share a weird habit you have",
  "Describe your dream vacation in one sentence"
];

// ---------------- SOCKET LOGIC ----------------


  socket.on("create-room", ({ name, avatar }) => {
    const roomCode = generateRoomCode();

    rooms[roomCode] = {
      host: socket.id,
      players: {
        [socket.id]: { name: name || "Host", avatar: avatar || "/icons/icon-1.jpg" }
      },
      scores: { [socket.id]: 0 },
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

  let questionText =
    FALLBACK_QUESTIONS[Math.floor(Math.random() * FALLBACK_QUESTIONS.length)];

  if (db) {
    try {
      console.log("📡 Fetching questions from Firestore...");
      const snap = await db.collection("questions")
        .where("active", "==", true)
        .get();

      const valid = snap.docs
        .map(d => d.data())
        .filter(q => typeof q.text === "string" && q.text.trim().length > 0);

      console.log(`📄 Firestore returned ${valid.length} valid questions`);

      if (valid.length > 0) {
        const q = valid[Math.floor(Math.random() * valid.length)];

        const names = Object.values(room.players).map(p => p.name);
        const randomName = names.length
          ? names[Math.floor(Math.random() * names.length)]
          : "friend";

        if (q.text.includes("{{name}}")) {
          questionText = q.text.replace(/\{\{name\}\}/gi, randomName);
        } else {
          questionText = `About ${randomName}: ${q.text}`;
        }

        console.log("✅ Selected Firestore question:", questionText);
      } else {
        console.log("⚠ No valid Firestore questions. Using fallback.");
      }
    } catch (e) {
      console.warn("⚠ Firestore error:", e.message);
    }
  }

  io.to(roomCode).emit("new-question", { text: questionText });
  emitScores(roomCode);

  clearTimeout(room.timer);
  room.timer = setTimeout(() => forceVote(roomCode), 60000);
}


// ---------- ADMIN ROUTES ----------
app.get("/admin/questions", adminAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: "Database not initialized" });
    const snap = await db.collection("questions").orderBy("createdAt", "desc").get();
    const questions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json(questions);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/admin/questions", adminAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: "Database not initialized" });
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "Question text required" });

    const doc = await db.collection("questions").add({
      text,
      active: true,
     createdAt: Date.now()

    });

    res.json({ success: true, id: doc.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/admin/questions/:id", adminAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: "Database not initialized" });
    await db.collection("questions").doc(req.params.id).delete();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Protected debug route to inspect what server sees (admin key required)
app.get("/_debug/questions", adminAuth, async (req, res) => {
  try {
    if (!db) return res.status(503).json({ error: "DB not ready" });

    const snap = await db.collection("questions")
      .where("active", "==", true)
      .get();

    const valid = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(q => typeof q.text === "string" && q.text.trim().length > 0);

    res.json({
      total: snap.size,
      validCount: valid.length,
      questions: valid
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

server.listen(process.env.PORT || 3000, () =>
  console.log("🚀 Server running on port", process.env.PORT || 3000)
);