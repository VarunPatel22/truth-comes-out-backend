import express from "express";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 Firebase Admin from ENV
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ✅ ROOT CHECK (optional but helpful)
app.get("/", (req, res) => {
  res.send("🎭 Truth Comes Out Backend is running");
});

// ✅ QUESTIONS API (THIS WAS MISSING)
app.get("/questions", async (req, res) => {
  try {
    const snapshot = await db.collection("questions").get();
    const questions = snapshot.docs.map(doc => doc.data());
    res.json(questions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch questions" });
  }
});

// ✅ REQUIRED FOR RENDER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Backend running on", PORT);
});
