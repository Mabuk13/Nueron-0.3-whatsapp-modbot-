/**
 * whatsapp_mod_render.js
 *
 * WhatsApp group moderation bot compatible with Render.
 *
 * Features:
 * - Whitelist-controlled moderation (start/stop)
 * - Banned words enforcement with 3-strike removal
 * - Persistent warnings.json
 * - Lightweight queue & dedupe for performance
 * - Headless on Render, optional QR for local dev
 */

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

// ---------------- CONFIG ----------------
const TARGET_GROUP_NAME = process.env.TARGET_GROUP_NAME || "6-3 of '25";
const DATA_PATH = process.env.WWEBJS_DATA_PATH || path.join(__dirname, ".wwebjs_auth");
const WARNINGS_FILE = path.join(__dirname, "warnings.json");
const START_ACTIVE = process.env.START_ACTIVE ? process.env.START_ACTIVE === "true" : true;
const SHOW_QR = process.env.SHOW_QR === "true";
const FORCE_QR = process.env.FORCE_QR === "true";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 8000);
const POLL_LIMIT = Number(process.env.POLL_LIMIT || 100);

// Moderation rules
const bannedWords = new Set((process.env.BANNED_WORDS || "fuck,shit,hell,damn,bitch,ass,bastard,femboy,dih,dick,pussy").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
const allowedNumbers = (process.env.ALLOWED_NUMBERS || "6580480362,6585038335").split(",").map(s => s.replace(/\D/g,"")).filter(Boolean);

// ---------------- STATE ----------------
let moderationActive = START_ACTIVE;
let warnings = {};
let warningsDirty = false;
let saveTimer = null;
let client = null;
let targetChatId = null;
const processed = new Set();
const MAX_PROCESSED = 30000;
const messageQueue = [];
let workerRunning = false;

// ---------------- HELPERS ----------------
const log = (...args) => console.log(new Date().toISOString(), ...args);

function safeLoadWarnings() {
  try {
    if (fs.existsSync(WARNINGS_FILE)) {
      warnings = JSON.parse(fs.readFileSync(WARNINGS_FILE, "utf8")) || {};
      log("Loaded warnings:", Object.keys(warnings).length);
    }
  } catch (e) { log("Failed to load warnings:", e.message || e); }
}

function scheduleSaveWarnings() {
  if (!warningsDirty) return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnings, null, 2), "utf8");
      log("Saved warnings.json");
      warningsDirty = false;
    } catch (e) { log("Failed to save warnings:", e.message || e); }
    saveTimer = null;
  }, 5000);
}

function markWarningsDirty() { warningsDirty = true; scheduleSaveWarnings(); }

function markProcessed(id) {
  if (!id) return;
  processed.add(id);
  if (processed.size > MAX_PROCESSED) {
    const keep = Array.from(processed).slice(-15000);
    processed.clear();
    for (const idd of keep) processed.add(idd);
  }
}

function isProcessed(id) { return id && processed.has(id); }

function getNormalizedNumberFromMsg(msg) {
  const raw = msg.author || msg.from || "";
  const digits = raw.replace(/\D/g, "");
  return digits.length === 8 ? "65" + digits : digits;
}

function containsBannedWord(text) {
  if (!text) return false;
  for (const w of bannedWords) if (text.includes(w)) return w;
  return false;
}

function enqueue(msg) {
  const id = msg.id && (msg.id._serialized || msg.id.id) || "<noid>";
  if (isProcessed(id)) return;
  messageQueue.push(msg);
  if (!workerRunning) runWorker();
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  while (messageQueue.length) {
    const msg = messageQueue.shift();
    try { await handleMessage(msg); } catch (e) { log("handleMessage error:", e.message || e); }
  }
  workerRunning = false;
}

// ---------------- MESSAGE HANDLING ----------------
async function handleMessage(msg) {
  const id = msg.id && (msg.id._serialized || msg.id.id);
  if (!id || isProcessed(id)) return;
  markProcessed(id);
  if (!targetChatId || msg.from !== targetChatId) return;

  const body = (msg.body || "").toLowerCase().trim();
  const senderNum = getNormalizedNumberFromMsg(msg);
  const senderId = msg.author || msg.from;

  const normalized = body.replace(/\s+/g, " ").trim();

  // ----- MODERATION COMMANDS -----
  if (["start moderation","!mod on","!modon"].includes(normalized)) {
    if (!senderNum || !allowedNumbers.includes(senderNum)) {
      await msg.getChat().then(c => c.sendMessage("❌ You are not authorized to start moderation")).catch(()=>null);
      log("Unauthorized start attempt by:", senderNum);
      return;
    }
    if (!moderationActive) { moderationActive = true; warnings = {}; markWarningsDirty(); await msg.getChat().then(c => c.sendMessage("✅ Moderation active")).catch(()=>null); log("Moderation started by:", senderNum); }
    return;
  }

  if (["stop moderation","!mod off","!modoff"].includes(normalized)) {
    if (!senderNum || !allowedNumbers.includes(senderNum)) {
      await msg.getChat().then(c => c.sendMessage("❌ You are not authorized to stop moderation")).catch(()=>null);
      log("Unauthorized stop attempt by:", senderNum);
      return;
    }
    if (moderationActive) { moderationActive = false; markWarningsDirty(); await msg.getChat().then(c => c.sendMessage("🛑 Moderation stopped")).catch(()=>null); log("Moderation stopped by:", senderNum); }
    return;
  }

  if (!moderationActive) return;

  // ----- BANNED WORDS -----
  const hit = containsBannedWord(body);
  if (!hit) return;

  log(`Banned word "${hit}" detected from ${senderNum}`);
  try { await msg.delete(true); log("Deleted message id:", id); } catch (e) { log("Delete failed:", e.message || e); }

  if (!senderId) return;
  warnings[senderId] = (warnings[senderId] || 0) + 1;
  markWarningsDirty();
  const strikes = warnings[senderId];

  try {
    const chat = await msg.getChat();
    if (strikes < 3) {
      await chat.sendMessage(`⚠️ ${senderNum}, warning ${strikes}/3 — avoid banned words.`);
    } else if (strikes === 3) {
      await chat.sendMessage(`🚫 ${senderNum} reached 3 warnings and will be removed.`);
      try { await chat.removeParticipants([senderId]); log("Removed participant:", senderId); } catch (e) { log("Remove failed:", e.message || e); }
    }
  } catch (e) { log("Warning/Removal failed:", e.message || e); }
}

// ---------------- CLIENT SETUP ----------------
function makeClient() {
  try { fs.mkdirSync(DATA_PATH, { recursive: true }); } catch(e){}
  return new Client({
    authStrategy: new LocalAuth({ clientId: "modbot", dataPath: DATA_PATH }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--single-process","--no-first-run","--no-default-browser-check","--disable-extensions","--window-size=1920,1080"],
      ignoreDefaultArgs: ["--enable-automation"]
    },
    takeoverOnConflict: true
  });
}

async function findTargetChatId() {
  try {
    const chats = await client.getChats();
    const found = chats.find(c => c.isGroup && String(c.name).trim() === TARGET_GROUP_NAME.trim());
    if (found && found.id && found.id._serialized) {
      targetChatId = found.id._serialized;
      log("Found target group id:", targetChatId);
    }
  } catch (e) { log("getChats failed:", e.message || e); }
}

async function initClient() {
  client = makeClient();
  let ready = false;

  client.on("qr", qr => {
    if (SHOW_QR) { qrcode.generate(qr, { small: true }); log("Scan QR to authenticate"); } 
    else { log("QR received (not displayed)"); }
  });

  client.on("ready", async () => {
    ready = true;
    log("Client ready. Finding target group...");
    await findTargetChatId();
  });

  client.on("message", msg => {
    if (targetChatId && msg.from === targetChatId) enqueue(msg);
  });

  client.on("disconnected", reason => {
    log("Disconnected:", reason, "Reinit in 8s...");
    setTimeout(() => { client.destroy(); client = null; targetChatId = null; initClient().catch(e => log("Re-init error:", e)); }, 8000);
  });

  client.on("error", err => log("Client error:", err && err.message ? err.message : err));

  client.initialize();
}

// ---------------- START ----------------
safeLoadWarnings();
log("Starting WhatsApp mod bot", { DATA_PATH, SHOW_QR, FORCE_QR, START_ACTIVE });
initClient().catch(e => log("initClient failed:", e));

process.on("SIGINT", () => {
  log("SIGINT received — saving warnings and exiting");
  try { fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnings, null, 2), "utf8"); } catch(e) { log("Failed saving:", e.message || e); }
  process.exit(0);
});
process.on("unhandledRejection", r => log("Unhandled rejection:", r && r.message ? r.message : r));
process.on("uncaughtException", err => log("Uncaught exception:", err && err.message ? err.message : err));
