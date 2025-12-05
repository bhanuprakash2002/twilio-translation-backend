
const fs = require("fs");
const GC_PATH = "/tmp/google-credentials.json";

// If GOOGLE_CREDENTIALS_JSON exists in Render env,
// write it into a file so Google SDK can read it.
if (process.env.GOOGLE_CREDENTIALS_JSON) {
  try {
    fs.writeFileSync(GC_PATH, process.env.GOOGLE_CREDENTIALS_JSON);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = GC_PATH;
    console.log("✅ Google credentials loaded for Render");
  } catch (err) {
    console.error("❌ Failed writing Google credentials:", err);
  }
}

console.log("🚀 Starting Twilio Voice SDK v2 Translation Server...\n");

require("dotenv").config();

console.log("🚀 Starting Twilio Voice SDK v2 Translation Server...\n");

require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const WebSocket = require("ws");
const twilio = require("twilio");

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.sendStatus(200);

  next();
});

// =====================================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));



// Active sessions storage
const activeSessions = new Map();

// =====================================
// ENVIRONMENT VALIDATION
// =====================================
const requiredEnvVars = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_API_KEY",
  "TWILIO_API_SECRET",
  "TWILIO_APP_SID"
];

console.log("📋 Validating environment variables:");
let hasError = false;
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ ${envVar} is NOT set`);
    hasError = true;
  } else {
    console.log(`✅ ${envVar}`);
  }
}

if (hasError) {
  console.error("\n❌ Missing required environment variables!");
  console.error("Please check your .env file");
  process.exit(1);
}

console.log("\n✅ All environment variables validated\n");

// =====================================
// ROUTES
// =====================================

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    version: "2.0.0",
    sdk: "Twilio Voice SDK v2",
    timestamp: new Date().toISOString(),
    activeRooms: activeSessions.size
  });
});

// Serve main page
app.get("/", (req, res) => {
  res.json({ message: "Twilio Backend Running" });
});

app.get("/join", (req, res) => {
  res.json({ message: "Join endpoint active" });
});


// =====================================
// VOICE TOKEN (SDK v2 Compatible)
// =====================================
app.get("/voice-token", (req, res) => {
  try {
    const identity = "user_" + uuidv4();

    // Use Twilio's AccessToken class (SDK v2 compatible)
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    // Create access token with identity
    const accessToken = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY,
      process.env.TWILIO_API_SECRET,
      { 
        identity: identity,
        ttl: 3600 // 1 hour
      }
    );

    // Create voice grant
    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_APP_SID,
      incomingAllow: true
    });

    // Add grant to token
    accessToken.addGrant(voiceGrant);

    // Generate JWT
    const token = accessToken.toJwt();

    console.log("✅ Token generated:", identity);

    res.json({ 
      token: token,
      identity: identity 
    });

  } catch (error) {
    console.error("❌ Token generation error:", error.message);
    res.status(500).json({ 
      error: "Failed to generate token",
      message: error.message 
    });
  }
});

// =====================================
// ROOM MANAGEMENT
// =====================================

// Create room
app.post("/create-room", async (req, res) => {
  try {
    const { creatorLanguage } = req.body;
    const roomId = uuidv4().substring(0, 8);

    activeSessions.set(roomId, {
      creatorLanguage: creatorLanguage,
      participantLanguage: null,
      creatorConnection: null,
      participantConnection: null,
      createdAt: Date.now()
    });

    // Build join URL
    const protocol = req.get("x-forwarded-proto") || req.protocol || "https";
    const host = req.get("host");
    const joinUrl = `${protocol}://${host}/join?room=${roomId}`;

    console.log("✅ Room created:", roomId);
    console.log("   Language:", creatorLanguage);
    console.log("   Join URL:", joinUrl);

    res.json({ 
      roomId: roomId,
      joinUrl: joinUrl 
    });

  } catch (error) {
    console.error("❌ Room creation error:", error.message);
    res.status(500).json({ error: "Failed to create room" });
  }
});

// Join room
app.post("/join-room", (req, res) => {
  try {
    const { roomId, participantLanguage } = req.body;

    const session = activeSessions.get(roomId);
    
    if (!session) {
      console.error("❌ Room not found:", roomId);
      return res.status(404).json({ error: "Room not found" });
    }

    if (session.participantLanguage) {
      console.error("❌ Room full:", roomId);
      return res.status(400).json({ error: "Room is full (2 participants max)" });
    }

    session.participantLanguage = participantLanguage;
    activeSessions.set(roomId, session);

    console.log("✅ User joined room:", roomId);
    console.log("   Language:", participantLanguage);

    res.json({ 
      success: true,
      creatorLanguage: session.creatorLanguage 
    });

  } catch (error) {
    console.error("❌ Join room error:", error.message);
    res.status(500).json({ error: "Failed to join room" });
  }
});


// Leave room
// --- Leave room endpoint (replace existing /leave-room) ---
app.post("/leave-room", (req, res) => {
  try {
    const { roomId, userType } = req.body;

    const session = activeSessions.get(roomId);
    if (!session) {
      // If room not found, behave idempotently
      return res.json({ success: true });
    }

    console.log(`🚪 User leaving room ${roomId}: ${userType}`);

    // If we have an associated processor objects stored (creatorConnection/participantConnection)
    // they should have a .ws reference to the websocket to send force-disconnect.
    let otherSide = null;
    if (userType === "caller") {
      otherSide = session.participantConnection;
    } else {
      otherSide = session.creatorConnection;
    }

    // If other side present and its websocket is open, instruct it to disconnect
    try {
      if (otherSide && otherSide.ws && otherSide.ws.readyState === 1) {
        otherSide.ws.send(JSON.stringify({
          event: "force-disconnect",
          reason: "Other participant left the room"
        }));
      }
    } catch (err) {
      console.warn("Could not send force-disconnect to other side:", err?.message || err);
    }

    // Immediately delete the room to make join/rejoin safe (frontend will detect 404)
    activeSessions.delete(roomId);
    console.log("🧹 Room deleted on leave:", roomId);

    return res.json({ success: true });
  } catch (error) {
    console.error("❌ Leave-room error:", error);
    return res.status(500).json({ error: "Failed to leave room" });
  }
});


// Get room info (languages + status)
app.get("/room-info", (req, res) => {
  const roomId = req.query.roomId;
  const session = activeSessions.get(roomId);

  if (!session) {
    return res.status(404).json({ error: "Room not found" });
  }

  res.json({
    creatorLanguage: session.creatorLanguage,
    participantLanguage: session.participantLanguage
  });
});

// =====================================
// TWIML ENDPOINT (SDK v2 Compatible)
// =====================================
app.post("/twiml/voice", (req, res) => {
  try {
    console.log("\n📞 TwiML endpoint called");
    console.log("   Body:", req.body);

    // Extract parameters from the request body
    const roomId = req.body.roomId || "unknown";
    const userType = req.body.userType || "unknown";
    const myLanguage = req.body.myLanguage;

    console.log("   Room:", roomId);
    console.log("   User:", userType);
    console.log("   Language:", myLanguage);

    // Validate required parameters
    if (!myLanguage) {
      console.error("❌ ERROR: myLanguage parameter is missing!");
      console.error("   This will cause transcription to fail!");
    }

    // WebSocket URL
    const wsUrl = process.env.PUBLIC_WS_URL || `wss://${req.get("host")}/media-stream`;
    console.log("   WS URL:", wsUrl);

    // Generate TwiML using Twilio helper library
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();

    // Connect to media stream immediately (no voice prompt)
    const connect = response.connect();
    const stream = connect.stream({ url: wsUrl });

    // Add parameters - These will be available in WebSocket 'start' event
    stream.parameter({ name: "roomId", value: roomId });
    stream.parameter({ name: "userType", value: userType });
    stream.parameter({ name: "myLanguage", value: myLanguage });

    const twimlString = response.toString();
    console.log("   TwiML generated successfully");
    console.log("   Parameters sent to stream:", { roomId, userType, myLanguage });

    res.type("text/xml");
    res.send(twimlString);

  } catch (error) {
    console.error("❌ TwiML error:", error.message);

    // Fallback TwiML
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    response.say("An error occurred. Please try again later.");

    res.type("text/xml");
    res.send(response.toString());
  }
});

// =====================================
// TRANSLATION ENDPOINT
// =====================================

// Store recent translations for each room
const recentTranslations = new Map();

// Get translations endpoint (for UI updates)
app.get("/get-translations", (req, res) => {
  try {
    const { roomId, userType, since } = req.query;
    
    if (!roomId) {
      console.log("❌ Get translations: Missing roomId");
      return res.status(400).json({ error: "Missing roomId" });
    }

    const sinceTime = parseInt(since) || 0;
    const roomKey = `${roomId}:${userType}`;
    const translations = recentTranslations.get(roomKey) || [];

    // Filter translations newer than 'since' timestamp
    const newTranslations = translations.filter(t => t.timestamp > sinceTime);

    // Debug logging
    if (newTranslations.length > 0) {
      console.log(`📤 Sending ${newTranslations.length} translations to ${userType} in room ${roomId}`);
    }

    res.json({
      translations: newTranslations,
      count: newTranslations.length
    });

  } catch (error) {
    console.error("❌ Get translations error:", error.message);
    res.status(500).json({ error: "Failed to get translations" });
  }
});

// Helper function to add translation (call this from processor)
function addTranslation(roomId, userType, translationData) {
  const roomKey = `${roomId}:${userType}`;
  
  if (!recentTranslations.has(roomKey)) {
    recentTranslations.set(roomKey, []);
  }

  const translations = recentTranslations.get(roomKey);
  translations.push(translationData);

  // Keep only last 50 translations per room
  if (translations.length > 50) {
    translations.shift();
  }

  recentTranslations.set(roomKey, translations);
  
  // Debug log
  console.log(`💾 Stored translation for ${userType} in room ${roomId}: "${translationData.translatedText}"`);
}

// Export for use in processor
global.addTranslation = addTranslation;

// Clean up old translations periodically
setInterval(() => {
  const now = Date.now();
  const maxAge = 600000; // 10 minutes

  for (const [key, translations] of recentTranslations.entries()) {
    const filtered = translations.filter(t => (now - t.timestamp) < maxAge);
    if (filtered.length === 0) {
      recentTranslations.delete(key);
    } else {
      recentTranslations.set(key, filtered);
    }
  }
}, 60000); // Run every minute

// =====================================
// WEBSOCKET SERVER
// =====================================
const BidirectionalProcessor = require("./bidirectional-processor");

const wss = new WebSocket.Server({ noServer: true });

wss.on("connection", (ws, req) => {
  console.log("🔗 WebSocket connection established");

  const processor = new BidirectionalProcessor(ws, activeSessions);

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message);
      await processor.handleMessage(data);
    } catch (error) {
      console.error("❌ Message error:", error.message);
    }
  });

  ws.on("close", () => {
    console.log("❌ WebSocket closed for", processor.userType);

    const roomId = processor.roomId;
    const userType = processor.userType;

    // If missing metadata, still clean the processor
    if (!roomId || !userType) {
      processor.cleanup();
      return;
    }

    const session = activeSessions.get(roomId);
    if (!session) {
      processor.cleanup();
      return;
    }

    // Notify other side if connected
    const otherSide = userType === "caller" ? session.participantConnection : session.creatorConnection;
    try {
      if (otherSide && otherSide.ws && otherSide.ws.readyState === 1) {
        otherSide.ws.send(JSON.stringify({
          event: "force-disconnect",
          reason: "Other participant disconnected (ws close)"
        }));
      }
    } catch (err) {
      console.warn("Failed to notify other side on ws close:", err?.message || err);
    }

    // Remove the room completely so future joins see a clean state
    activeSessions.delete(roomId);
    console.log("🗑️ Room deleted because participant WS closed:", roomId);

    processor.cleanup();
  });



  ws.on("error", (error) => {
    console.error("❌ WebSocket error:", error.message);
    processor.cleanup();
  });
});

// =====================================
// START SERVER
// =====================================
const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  const publicUrl = process.env.PUBLIC_WS_URL 
    ? process.env.PUBLIC_WS_URL.replace("wss://", "https://").replace("/media-stream", "")
    : "Not configured";

  console.log(`
╔════════════════════════════════════════════════╗
║  🚀 Twilio Voice SDK v2 Server Running         ║
║  📡 Port: ${PORT}                               ║
║  🌐 Local: http://localhost:${PORT}            ║
║  🌍 Public: ${publicUrl}                        ║
╚════════════════════════════════════════════════╝
  `);

  console.log(`
🔍 Endpoints:
  • ${publicUrl || 'http://localhost:' + PORT}/ - Main page
  • ${publicUrl || 'http://localhost:' + PORT}/join?room=xxx - Join page
  • ${publicUrl || 'http://localhost:' + PORT}/health - Health check
  • ${publicUrl || 'http://localhost:' + PORT}/voice-token - Get token
  • ${publicUrl || 'http://localhost:' + PORT}/get-translations - Translation updates
  
📱 Ready to accept connections!
  `);
});

// WebSocket upgrade handler
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/media-stream") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    console.log("❌ Invalid WebSocket path:", req.url);
    socket.destroy();
  }
});

// Clean up old sessions (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  const oneHour = 3600000;
  
  for (const [roomId, session] of activeSessions.entries()) {
    if (now - session.createdAt > oneHour) {
      activeSessions.delete(roomId);
      console.log("🧹 Cleaned up expired room:", roomId);
    }
  }
}, 300000);

// Graceful shutdown
const shutdown = () => {
  console.log("\n🛑 Shutting down gracefully...");
  server.close(() => {
    console.log("✓ Server closed");
    process.exit(0);
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);