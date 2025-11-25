/**
 * moderator_whitelist_full.js
 *
 * Robust WhatsApp group moderator that only allows certain phone numbers
 * to start/stop moderation. Keeps the long form commands too.
 *
 * - Save as moderator_whitelist_full.js
 * - Install: npm install whatsapp-web.js qrcode-terminal
 * - Run: node moderator_whitelist_full.js
 *
 * Behaviour:
 * - Reuses previous LocalAuth session by default (so it keeps the logged-in account)
 * - If the session appears corrupted (Evaluation failed / stale / invalid), it
 *   automatically wipes the session folder and creates a fresh one (shows a new QR)
 * - Warnings are persisted to warnings.json in the same directory
 */

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

// ---------------- CONFIG ----------------
const TARGET_GROUP_NAME = "6-3 of '25";        // group name the bot monitors
const VISIBLE = true;                            // true => Chrome window visible; false => headless
const POLL_INTERVAL_MS = 5000;                   // how often to poll as a fallback
const POLL_LIMIT = 500;                          // how many messages to fetch per poll
const PROCESSED_TTL_SECONDS = 24 * 3600;         // how long to keep processed IDs before trimming
const STATE_SAVE_INTERVAL_MS = 15000;            // autosave warnings/trim every 15 seconds
const WARNINGS_FILE = path.join(__dirname, "warnings.json");

// Session auto-heal config
const SESSION_ID = "default"; // change if you want distinct session folders for multiple bots
const SESSION_PATH = path.join(__dirname, ".wwebjs_auth", SESSION_ID);

// ----------------------------------------
// Banned words list (your list)
const bannedWords = [
  "fuck", "shit", "hell", "damn", "bitch",
  "ass", "bastard", "femboy", "dih",
  "dick", "pussy", "Walao", "vagina", "penis", "sus", "Harish"
];

// Whitelist: numbers allowed to start/stop moderation
// Store as plain digits with country code (no +, no spaces).
// You asked for: +65 80480362 and +65 85038335
const allowedNumbers = ["6580480362", "6585038335"];

// -------- runtime state ----------
let moderationActive = false;
let warnings = loadWarnings(); // persisted map { participantId: count }
let processed = new Map();     // Map<msgId, timestampSeconds>
let processedOrder = [];       // array of msgId for trimming
let targetChat = null;
// queue worker to serialize processing and avoid race conditions
const messageQueue = [];
let workerRunning = false;

// ---------- helper functions ----------
function loadWarnings() {
  try {
    if (fs.existsSync(WARNINGS_FILE)) {
      return JSON.parse(fs.readFileSync(WARNINGS_FILE, "utf8"));
    }
  } catch (e) {
    console.error("Failed to load warnings:", e);
  }
  return {};
}

function saveWarnings() {
  try {
    fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnings, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save warnings:", e);
  }
}

function getNowSec() {
  return Math.floor(Date.now() / 1000);
}

// processed message tracking functions (dedupe)
function markProcessed(id, tsSec) {
  if (!id) return;
  const now = tsSec || getNowSec();
  if (!processed.has(id)) {
    processed.set(id, now);
    processedOrder.push(id);
  }
  if (processed.size > 30000) trimProcessed();
}

function isProcessed(id) {
  return id && processed.has(id);
}

function trimProcessed() {
  const cutoff = getNowSec() - PROCESSED_TTL_SECONDS;
  while (processedOrder.length > 0) {
    const oldest = processedOrder[0];
    const ts = processed.get(oldest);
    if (!ts || ts < cutoff || processed.size > 20000) {
      processed.delete(oldest);
      processedOrder.shift();
    } else break;
  }
  if (processed.size > 25000) {
    const keep = processedOrder.slice(-15000);
    const newMap = new Map();
    for (const id of keep) newMap.set(id, processed.get(id));
    processed = newMap;
    processedOrder = keep;
  }
}

// get a normalized digits-only phone number for a message sender
// try to use sender contact's number field; fallback to extracting digits from message author/from
function getNormalizedSenderNumber(msg, senderContact) {
  // senderContact.number often contains digits already (e.g. "6580480362")
  let num = null;
  if (senderContact && senderContact.number) {
    num = String(senderContact.number);
  } else {
    // try msg.author (group messages) or msg.from
    const raw = (msg.author || msg.from || "") + "";
    // raw sometimes like "6580480362@c.us" -> extract digits
    const digits = raw.replace(/\D/g, "");
    if (digits) num = digits;
  }
  if (!num) return null;
  // strip non-digit chars and leading plus
  num = num.replace(/\D/g, "");
  // Some systems store 0-leading local numbers; user provided +65 numbers, so assume full international form.
  // If the number is 8 digits (local Singapore without country code), prefix 65:
  if (num.length === 8) {
    num = "65" + num;
  }
  return num;
}

// send a message safely (catching errors)
async function safeSend(chat, text, opts = {}) {
  try {
    await chat.sendMessage(text, opts);
    return true;
  } catch (e) {
    console.log("⚠️ sendMessage failed:", e?.message || e);
    return false;
  }
}

// try to delete a message, log failure
async function safeDelete(msg) {
  try {
    await msg.delete(true);
    return true;
  } catch (e) {
    console.log("⚠️ msg.delete failed:", e?.message || e);
    return false;
  }
}

// try to remove participant, log failure
async function safeRemoveParticipant(chat, participantId) {
  try {
    await chat.removeParticipants([participantId]);
    return true;
  } catch (e) {
    console.log("❌ removeParticipants failed:", e?.message || e);
    return false;
  }
}

// enqueue message for serialized processing
function enqueueMessage(msg) {
  messageQueue.push(msg);
  if (!workerRunning) runQueueWorker();
}

async function runQueueWorker() {
  if (workerRunning) return;
  workerRunning = true;
  while (messageQueue.length > 0) {
    const msg = messageQueue.shift();
    try {
      await processSingleMessage(msg);
    } catch (e) {
      console.log("⚠️ Error processing queued message:", e?.message || e);
    }
  }
  workerRunning = false;
}

// Extract a unique id string for the message
function getMessageId(msg) {
  if (!msg || !msg.id) return null;
  return msg.id._serialized || msg.id.id || null;
}

// ---------- core processing for a single message ----------
async function processSingleMessage(msg) {
  if (!msg) return;

  const id = getMessageId(msg);
  if (!id) return;

  // skip if already processed
  if (isProcessed(id)) return;

  // mark early to avoid double-queueing; acceptable tradeoff
  markProcessed(id, msg.timestamp || getNowSec());

  // get chat
  let chat;
  try {
    chat = await msg.getChat();
  } catch (e) {
    console.log("⚠️ Could not get chat for message:", e?.message || e);
    return;
  }

  if (!chat.isGroup) return;
  if (chat.name !== TARGET_GROUP_NAME) return;

  const text = (msg.body || "").toString().trim().toLowerCase();
  const senderContact = await msg.getContact().catch(()=>null);
  const senderId = (msg.author && msg.author) || (msg.from && msg.from) || null;
  const senderNumber = getNormalizedSenderNumber(msg, senderContact);

  // normalize whitespace for command recognition
  const normalized = text.replace(/\s+/g, " ").trim();

  // ----- START commands (long & short): only allowedNumbers can start moderation -----
  if (normalized === "start moderation" || normalized === "!mod on" || normalized === "!modon") {
    // check allowed numbers
    if (!senderNumber || !allowedNumbers.includes(senderNumber)) {
      try {
        await safeSend(chat, `❌ You are not authorized to start moderation.`, { mentions: senderContact ? [senderContact] : [] });
      } catch (e) {}
      // For debugging, log the attempted number in terminal
      console.log("Unauthorized start attempt by:", senderNumber || senderId);
      return;
    }

    // allowed -> start moderation if not active
    if (!moderationActive) {
      moderationActive = true;
      warnings = {}; // reset warnings as in original behaviour
      saveWarnings();
      try { await safeSend(chat, "✅ Moderation active."); } catch (e) {}
      console.log("Moderation started by allowed number:", senderNumber);
    } else {
      // already active -> do nothing to avoid spam
    }
    return;
  }

  // ----- STOP commands (long & short): only allowedNumbers can stop moderation -----
  if (normalized === "stop moderation" || normalized === "!mod off" || normalized === "!modoff") {
    if (!senderNumber || !allowedNumbers.includes(senderNumber)) {
      try {
        await safeSend(chat, `❌ You are not authorized to stop moderation.`, { mentions: senderContact ? [senderContact] : [] });
      } catch (e) {}
      console.log("Unauthorized stop attempt by:", senderNumber || senderId);
      return;
    }

    if (moderationActive) {
      moderationActive = false;
      saveWarnings();
      try { await safeSend(chat, "🛑 Moderation stopped."); } catch (e) {}
      console.log("Moderation stopped by allowed number:", senderNumber);
    }
    return;
  }

  // If moderation not active, ignore everything else
  if (!moderationActive) return;

  // ----- BANNED WORDS moderation -----
  // simple substring match on lowercased text
  for (const w of bannedWords) {
    if (!w) continue;
    if (text.includes(w)) {
      // try delete
      await safeDelete(msg);

      // warn / kick logic
      if (!senderId) return;

      warnings[senderId] = (warnings[senderId] || 0) + 1;
      saveWarnings();

      const strikes = warnings[senderId];

      // send warning (1 & 2)
      if (strikes < 3) {
        try {
          await chat.sendMessage(`⚠️ @${senderNumber}, warning ${strikes}/3 — avoid banned words.`, { mentions: [senderContact] });
        } catch (e) {
          console.log("⚠️ Could not send warning:", e?.message || e);
        }
        return;
      }

      // strike 3 -> announce + kick
      if (strikes === 3) {
        try {
          await chat.sendMessage(`🚫 @${senderNumber} reached 3 warnings and will be removed.`, { mentions: [senderContact] });
        } catch (e) {
          console.log("⚠️ Could not announce removal:", e?.message || e);
        }

        // try remove participant
        await safeRemoveParticipant(chat, senderId);
        return;
      }

      return;
    }
  }
}

// ---------- WhatsApp client & event wiring ----------
// Wrapper functions that create a client and attach the handlers so we can safely
// destroy/recreate the client if the session is corrupted.

function wipeSession() {
  console.log("⚠️ Wiping corrupted session:", SESSION_PATH);
  try {
    fs.rmSync(SESSION_PATH, { recursive: true, force: true });
  } catch (e) {
    console.log("Failed deleting session folder:", e.message);
  }
}

function createClientInstance() {
  return new Client({
    authStrategy: new LocalAuth({ clientId: SESSION_ID }),
    puppeteer: {
      headless: !VISIBLE,
      defaultViewport: null,
      args: VISIBLE
        ? ["--start-maximized", "--no-sandbox", "--disable-setuid-sandbox"]
        : [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--window-size=1920,1080",
            `--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117 Safari/537.36`
          ],
      ignoreDefaultArgs: ["--enable-automation"]
    }
  });
}

let client = null;
let pollRunning = false;

function attachClientHandlers(c) {
  // show QR in terminal
  c.on("qr", qr => {
    console.log("QR received. Scan with your phone:");
    qrcode.generate(qr, { small: true });
  });

  // ready handler: find target group, say ready, start polling fallback
  c.on("ready", async () => {
    console.log("Client ready. Locating target group:", TARGET_GROUP_NAME);
    try {
      const chats = await c.getChats();
      targetChat = chats.find(ch => ch.isGroup && ch.name === TARGET_GROUP_NAME);
      if (!targetChat) {
        console.log(`❌ Group "${TARGET_GROUP_NAME}" not found. Add the bot account to the group and restart.`);
        return;
      }

      // small wait for web UI to stabilise
      await new Promise(r => setTimeout(r, 1500));

      // send the initial message once
      try {
        await targetChat.sendMessage('Bot is now active. Send "start moderation" to start moderation.');
        console.log("Start message sent to target group.");
      } catch (e) {
        console.log("⚠️ Could not send start message:", e?.message || e);
      }

      // start polling fallback
      startPollingFallback();
    } catch (e) {
      console.log("Error in ready handler:", e?.message || e);
    }
  });

  // primary real-time listener: enqueue messages for processing
  c.on("message", msg => {
    try {
      enqueueMessage(msg);
    } catch (e) {
      console.log("enqueue error:", e?.message || e);
    }
  });

  // handle client auth failures/events that might indicate a bad session
  c.on("auth_failure", msg => {
    console.log("⚠️ auth_failure event:", msg);
    // wipe session and restart
    wipeSession();
    safeRestartClient();
  });

  c.on("disconnected", reason => {
    console.log("Client disconnected:", reason);
    // If disconnected for session reasons, try healing
    if (String(reason || "").toLowerCase().includes("invalid") || String(reason || "").toLowerCase().includes("stale")) {
      wipeSession();
      safeRestartClient();
    }
  });
}

async function safeRestartClient() {
  try {
    if (client) {
      try { await client.destroy(); } catch (e) { /* ignore */ }
    }
  } catch (e) {
    // ignore
  }

  // small delay to let filesystem settle
  await new Promise(r => setTimeout(r, 800));

  // re-init (one attempt)
  try {
    await initClient(1); // allow one retry attempt
  } catch (e) {
    console.log("Failed to restart client:", e?.message || e);
  }
}

// polling fallback — fetch last messages, enqueue unseen ones
async function startPollingFallback() {
  if (pollRunning) return;
  pollRunning = true;

  while (true) {
    if (!targetChat) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    try {
      const msgs = await targetChat.fetchMessages({ limit: POLL_LIMIT });
      // ensure chronological order (old -> new)
      msgs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      for (const m of msgs) {
        const id = (m.id && (m.id._serialized || m.id.id)) || null;
        if (!id) continue;
        if (isProcessed(id)) continue;
        // enqueue and mark early to avoid duplicates from quick successive polls
        enqueueMessage(m);
        markProcessed(id, m.timestamp || getNowSec());
      }
    } catch (err) {
      console.log("⚠️ Poll fetch failed:", err?.message || err);
    }

    // useful heartbeat log — can remove if noisy
    console.log("Messages read.");
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// periodic save & trim
setInterval(() => {
  saveWarnings();
  trimProcessed();
}, STATE_SAVE_INTERVAL_MS);

// graceful shutdown handling
process.on("SIGINT", () => {
  console.log("SIGINT received — saving state and exiting...");
  saveWarnings();
  try { if (client) client.destroy(); } catch(e){}
  process.exit(0);
});

// ---------- client init + auto-heal logic ----------
async function initClient(retryCount = 0) {
  client = createClientInstance();
  attachClientHandlers(client);

  try {
    console.log("Client initializing. Visible browser:", VISIBLE);
    await client.initialize();
  } catch (err) {
    console.log("❌ Session initialization failed:", err?.message || err);

    const msg = String(err || "").toLowerCase();
    // heuristics for session corruption
    if ((msg.includes("evaluation failed") || msg.includes("stale") || msg.includes("invalid") || msg.includes("timed out") || msg.includes("auth failure")) && retryCount < 1) {
      console.log("Attempting session auto-heal: wiping session and retrying...");
      wipeSession();

      try { await client.destroy(); } catch (e) {}

      // small delay then retry once
      await new Promise(r => setTimeout(r, 800));
      return initClient(retryCount + 1);
    }

    // unrecoverable / repeated failure: rethrow so operator notices
    throw err;
  }
}

// Start client
initClient().catch(err => {
  console.log("Fatal init error:", err?.message || err);
});

console.log("Moderator script loaded — will reuse previous session if present. If a session problem occurs the script will automatically create a new one.");
