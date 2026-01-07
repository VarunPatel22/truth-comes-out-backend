import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_KEY)
  )
});

const db = admin.firestore();
const rooms = {};

function generateRoomCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

io.on("connection", socket => {

  socket.on("create-room", ({ name }) => {
    const roomCode = generateRoomCode();

    rooms[roomCode] = {
      host: socket.id,
      players: { [socket.id]: name },
      scores: { [socket.id]: 0 },
      answers: [],
      submitted: new Set(),
      phase: "lobby",
      round: 0,
      maxRounds: 10,
      timer: null
    };

    socket.join(roomCode);
    socket.emit("room-created", {
      roomCode,
      players: Object.values(rooms[roomCode].players)
    });
  });

  socket.on("join-room", ({ roomCode, name }) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.players[socket.id] = name;
    room.scores[socket.id] = 0;
    socket.join(roomCode);

    io.to(roomCode).emit("player-update", Object.values(room.players));
  });

  socket.on("set-rounds", ({ roomCode, rounds }) => {
    if (rooms[roomCode]?.host === socket.id) {
      rooms[roomCode].maxRounds = rounds;
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

  room.answers = [];

  const snap = await db.collection("questions").get();
  if (snap.empty) {
    console.log("❌ No questions found");
    return;
  }

  const questions = snap.docs
    .map(d => d.data())
    .filter(q => typeof q.text === "string" && q.text.trim() !== "");

  if (questions.length === 0) {
    console.log("❌ No valid questions with text field");
    return;
  }

  const q = questions[Math.floor(Math.random() * questions.length)];

  const players = Object.values(room.players);
  const randomName =
    players[Math.floor(Math.random() * players.length)] || "someone";

  const questionText = q.text.replace(/\{\{name\}\}/gi, randomName);

  io.to(roomCode).emit("new-question", {
    text: questionText
  });

  console.log("✅ Question sent:", questionText);
}


    clearTimeout(room.timer);
    room.timer = setTimeout(() => {
      forceVote(roomCode);
    }, 60000);
  }

  socket.on("submit-answer", ({ roomCode, answer }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== "answer") return;
    if (room.submitted.has(socket.id)) return;

    room.submitted.add(socket.id);
    room.answers.push({
      author: socket.id,
      text: answer || "🤡"
    });

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
    if (!room || room.phase !== "answer") return;

    clearTimeout(room.timer);
    room.phase = "vote";

    if (Object.keys(room.players).length <= 1) {
      room.round++;
      startRound(roomCode);
      return;
    }

    io.to(roomCode).emit("phase-vote", room.answers);
  }

  socket.on("vote", ({ roomCode, votedFor }) => {
    const room = rooms[roomCode];
    if (!room || room.phase !== "vote") return;

    room.scores[votedFor]++;
    room.round++;

    if (room.round >= room.maxRounds) {
      endGame(roomCode);
    } else {
      startRound(roomCode);
    }
  });

  function endGame(roomCode) {
    const room = rooms[roomCode];
    const scores = {};
    Object.keys(room.players).forEach(id => {
      scores[room.players[id]] = room.scores[id];
    });
    io.to(roomCode).emit("game-over", scores);
  }

  socket.on("disconnect", () => {
    for (const code in rooms) {
      const room = rooms[code];
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        delete room.scores[socket.id];
        room.submitted.delete(socket.id);
        io.to(code).emit("player-update", Object.values(room.players));
      }
    }
  });
});

server.listen(3000, () => console.log("Server running"));
