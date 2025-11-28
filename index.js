/**
 * index.js — Multi-group WhatsApp moderation bot (robust read/write)
 *
 * Primary goals:
 *  - Keep your moderation rules EXACT (unchanged)
 *  - Robust, atomic read/write of warnings file
 *  - Back up corrupted JSON if detected
 *  - Queue saves within the process to avoid races
 *  - Graceful fallback to memory-only if disk is not writable
 *
 * Improvements:
 *  - Per-group admin detection (one non-admin group won't disable others)
 *  - Refresh group metadata before admin actions + retry delete
 *  - Robust own-id extraction (no client.getMe dependency)
 *  - Minimal HTTP health/status endpoint for Railway
 */

/** ----------------- Moderation rules (exact snippet requested) ----------------- */
const bannedWords = new Set((process.env.BANNED_WORDS || "fuck,shit,hell,damn,bitch,ass,bastard,femboy,dih,dick,pussy").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
const allowedNumbers = (process.env.ALLOWED_NUMBERS || "6580480362,6585038335").split(",").map(s => s.replace(/\D/g,"")).filter(Boolean);
/* ------------------------------------------------------------------------------ */

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const http = require("http");

// ---------- Configuration from environment ----------
const TARGET_GROUPS = (process.env.TARGET_GROUPS
  ? process.env.TARGET_GROUPS.split(",").map(s => s.trim()).filter(Boolean)
  : ["6-3 of '25", "⭒๋𐙚 6MAJ 2025 ֶָ֢ᯓ★"]
);

const WARNINGS_FILE = path.resolve(process.env.WARNINGS_FILE || path.join(__dirname, "warnings.json"));
const WARNINGS_THRESHOLD = parseInt(process.env.WARNINGS_THRESHOLD || "3", 10);
let moderationActive = (process.env.MODERATION_ACTIVE || "true").toLowerCase() === "true";

const FORCE_QR = (process.env.FORCE_QR || "false").toLowerCase() === "true";
const CLIENT_ID = process.env.CLIENT_ID || "modbot";

const HTTP_PORT = parseInt(process.env.PORT || process.env.HTTP_PORT || "3000", 10);

// Puppeteer options (Railway often needs a specific CHROMIUM_PATH)
const puppeteerArgs = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
  '--disable-gpu'
];
const puppeteerOptions = { headless: true, args: puppeteerArgs };
if (process.env.CHROMIUM_PATH) puppeteerOptions.executablePath = process.env.CHROMIUM_PATH;

// ---------- Utilities ----------
function timestamp() { return (new Date()).toISOString(); }
function log(...args) { console.log(timestamp(), ...args); }
function warn(...args) { console.warn(timestamp(), ...args); }

// If user requested a forced QR, attempt to remove LocalAuth folder (best-effort)
const LOCAL_AUTH_BASE = path.join(process.cwd(), ".wwebjs_auth", CLIENT_ID);
if (FORCE_QR) {
  try {
    if (fs.existsSync(LOCAL_AUTH_BASE)) {
      if (fs.rmSync) fs.rmSync(LOCAL_AUTH_BASE, { recursive: true, force: true });
      else fs.rmdirSync(LOCAL_AUTH_BASE, { recursive: true });
      log(`FORCE_QR enabled — removed LocalAuth folder: ${LOCAL_AUTH_BASE}`);
    } else {
      log("FORCE_QR enabled — no existing LocalAuth folder to remove.");
    }
  } catch (e) {
    warn("FORCE_QR: failed to remove LocalAuth folder:", e?.message || e);
  }
}

// Regex builder (Unicode-aware)
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const bannedArray = Array.from(bannedWords).map(w => escapeRegExp(w)).filter(Boolean);
const bannedRegex = bannedArray.length
  ? new RegExp(`(^|[^\\p{L}\\p{N}])(${bannedArray.join("|")})([^\\p{L}\\p{N}]|$)`, "iu")
  : null;

// Warnings store (in-memory cache)
let warnings = {}; // keys: digits-only string
let diskWritesDisabled = false; // if true, we fall back to memory-only
let saveInProgress = false;
let saveQueued = false;

// Ensure warnings directory exists
async function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  try { await fsp.mkdir(dir, { recursive: true }); } catch (e) { /* ignore */ }
}

// Load warnings from disk safely.
// If JSON parse fails, move the corrupted file to a backup and continue with empty store.
async function loadWarnings() {
  try {
    await ensureDirForFile(WARNINGS_FILE);
    const exists = fs.existsSync(WARNINGS_FILE);
    if (!exists) { warnings = {}; return; }
    const raw = await fsp.readFile(WARNINGS_FILE, "utf8");
    try {
      const parsed = JSON.parse(raw || "{}");
      const normalised = {};
      for (const key of Object.keys(parsed || {})) {
        const digits = key.replace(/\D/g, "");
        normalised[digits || key] = parsed[key];
      }
      warnings = normalised;
      log("Loaded warnings from disk.");
    } catch (parseErr) {
      const ts = (new Date()).toISOString().replace(/[:.]/g, "-");
      const corruptPath = `${WARNINGS_FILE}.corrupt.${ts}`;
      try { await fsp.rename(WARNINGS_FILE, corruptPath); log(`Corrupted warnings moved to ${corruptPath}`); } catch (renameErr) { warn("Failed to back up corrupted warnings file:", renameErr?.message || renameErr); try { await fsp.copyFile(WARNINGS_FILE, corruptPath); } catch {} }
      warnings = {};
    }
  } catch (err) {
    warn("Failed to load warnings from disk — continuing with in-memory store. Error:", err?.message || err);
    warnings = {};
    diskWritesDisabled = true;
  }
}

// Atomic save function with simple in-process queuing.
// Writes to a temp file then renames into place. On failure sets diskWritesDisabled.
async function saveWarnings() {
  if (diskWritesDisabled) return;
  if (saveInProgress) { saveQueued = true; return; }
  saveInProgress = true;
  try {
    await ensureDirForFile(WARNINGS_FILE);
    const tmpPath = `${WARNINGS_FILE}.tmp`;
    const data = JSON.stringify(warnings, null, 2);
    await fsp.writeFile(tmpPath, data, { encoding: "utf8", flag: "w" });
    await fsp.rename(tmpPath, WARNINGS_FILE);
    log("Saved warnings to disk.");
  } catch (err) {
    console.error("Failed to save warnings to disk. Disabling disk writes. Error:", err?.message || err);
    diskWritesDisabled = true;
    try { if (fs.existsSync(`${WARNINGS_FILE}.tmp`)) await fsp.unlink(`${WARNINGS_FILE}.tmp`); } catch {}
  } finally {
    saveInProgress = false;
    if (saveQueued) { saveQueued = false; saveWarnings().catch(e => warn("Queued save failed:", e?.message || e)); }
  }
}

// Normalise id -> digits string (used as key)
function extractDigitsFromId(id) { if (!id) return ""; return id.replace(/\D/g, ""); }

function isAllowedNumberDigits(digits) {
  if (!digits) return false;
  return allowedNumbers.some(n => { if (!n) return false; return digits === n || digits.endsWith(n) || n.endsWith(digits); });
}

function humanListAllowedNumbers() {
  if (!allowedNumbers.length) return "No admin numbers configured.";
  return allowedNumbers.map(n => (n.length > 6 ? "+" + n : n)).join(", ");
}

// Initialise WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth({ clientId: CLIENT_ID }),
  puppeteer: puppeteerOptions
});

let myId = null;           // serialized id like "659xxxxxxxx@c.us"
let clientReady = false;

// Robust extractor for the client's own ID — works across wwebjs versions & shapes
function serializeWidObject(wid) {
  if (!wid) return null;
  // If it's already a serialized string
  if (typeof wid === "string") return wid;
  // Known shapes: { _serialized: '659...@c.us' } or { id: '659...', server: 'c.us' } or { user: '659...', server: 'c.us' }
  if (wid._serialized) return wid._serialized;
  if (wid.id && typeof wid.id === "string") return wid.id;
  if (wid.user) {
    const server = wid.server || (wid.domain ? wid.domain : "c.us");
    return `${wid.user}@${server}`;
  }
  // fallback: try toString
  try {
    if (typeof wid.toString === "function") return wid.toString();
  } catch (e) {}
  return null;
}

function determineOwnIdFromClientInfo(info) {
  try {
    if (!info) return null;
    // preferred: info.wid
    if (info.wid) {
      const s = serializeWidObject(info.wid);
      if (s) return s;
    }
    // older: info.me (deprecated)
    if (info.me) {
      const s = serializeWidObject(info.me);
      if (s) return s;
    }
    // fallback: info.phone ? (rare)
    if (info.phone && info.phone.wa_version) {
      // not an id, ignore
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Small helper to refresh chat/participants — best effort
async function refreshChatParticipants(chat) {
  try {
    if (typeof client.getChatById === "function") {
      const fresh = await client.getChatById(chat.id._serialized);
      return fresh || chat;
    } else {
      const chats = await client.getChats();
      const found = chats.find(c => c.id._serialized === chat.id._serialized);
      return found || chat;
    }
  } catch (e) {
    return chat;
  }
}

// Per-group admin check (returns boolean)
async function isBotAdminIn(chat) {
  try {
    const refreshed = await refreshChatParticipants(chat);
    const participant = (refreshed.participants || []).find(p => (p.id && p.id._serialized) === myId);
    return !!(participant && (participant.isAdmin || participant.isSuperAdmin));
  } catch (e) {
    return false;
  }
}

// HTTP health/status server (no external deps)
function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ready: clientReady }));
      return;
    }
    if (req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        ready: clientReady,
        moderationActive,
        targetGroups: TARGET_GROUPS,
        warningsCount: Object.keys(warnings).length
      }));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  server.listen(HTTP_PORT, () => {
    log(`HTTP health/status server listening on port ${HTTP_PORT}`);
  });

  server.on("error", (e) => {
    warn("HTTP server error:", e?.message || e);
  });
}

// Event handlers
client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
  log("QR generated — scan it in your terminal logs.");
});

client.on('authenticated', () => {
  log("Authenticated successfully.");
});

client.on('auth_failure', msg => {
  console.error("Authentication failure:", msg);
});

client.on('ready', async () => {
  try {
    clientReady = true;
    log("WhatsApp client is ready.");
    await loadWarnings();

    // determine own id robustly from client.info
    try {
      const info = client.info || null; // client.info is the supported property
      const deduced = determineOwnIdFromClientInfo(info);
      if (deduced) {
        myId = deduced;
        log("Determined own id from client.info:", myId);
      } else {
        // last-resort: try to inspect any exposed properties
        try {
          // Some versions may expose pupBrowser/pupPage; avoid evaluating in page here.
          log("Warning: could not deduce own id from client.info; some admin features may not work until metadata is available.");
        } catch {}
      }
    } catch (e) {
      warn("Could not fetch own contact id on ready (info extraction failed):", e?.message || e);
    }

    log(`Moderation ${moderationActive ? "active" : "inactive"}. Target groups: ${TARGET_GROUPS.join(" | ")}`);

    // Inform each found group that bot is online (best-effort) and log admin status
    try {
      const chats = await client.getChats();
      for (const groupName of TARGET_GROUPS) {
        const targetChat = chats.find(c => c.isGroup && c.name === groupName);
        if (!targetChat) {
          warn(`Target group "${groupName}" not found. Startup notification not sent for that group.`);
          continue;
        }
        // Per-group admin detection
        let amAdmin = false;
        try {
          const refreshed = await refreshChatParticipants(targetChat);
          const participant = (refreshed.participants || []).find(p => (p.id && p.id._serialized) === myId);
          amAdmin = !!(participant && (participant.isAdmin || participant.isSuperAdmin));
        } catch (e) {
          // ignore
        }

        const startupMsg = [
          "🤖 Moderation Bot ONLINE",
          `Group: "${groupName}"`,
          `Moderation state: ${moderationActive ? "**Active**" : "**Inactive**"}.`,
          `Bot admin: ${amAdmin ? "Yes" : "No (please make me admin to allow delete/remove actions)"}`,
          "",
          "How to control moderation:",
          `• Admins listed in configuration can start moderation by sending the command: "start moderation"`,
          `• To stop moderation send: "stop moderation"`,
          `Configured admin numbers: ${humanListAllowedNumbers()}`,
          "",
          "Note: The bot needs to be a group admin to delete messages or remove participants."
        ].join("\n");
        await targetChat.sendMessage(startupMsg).catch(() => {});
      }
    } catch (e) {
      warn("Failed to send some startup notifications:", e?.message || e);
    }
  } catch (err) {
    console.error("Error in ready handler:", err?.message || err);
  }
});

client.on('disconnected', reason => {
  warn("Client disconnected:", reason);
});

// MAIN MESSAGE HANDLER
client.on('message', async (message) => {
  try {
    log("MSG received");

    // Ensure we can process this message
    let chat;
    try { chat = await message.getChat(); } catch (e) { console.error("ERROR reading message: failed to get chat:", e?.message || e); return; }

    if (!chat.isGroup) return; // only moderate groups
    if (!TARGET_GROUPS.includes(chat.name)) return; // ignore other groups

    // Determine author (in groups message.author is set)
    const offenderId = message.author || message.from;
    const offenderDigits = extractDigitsFromId(offenderId);

    // Ignore messages from the bot itself
    if (myId && extractDigitsFromId(myId) && offenderDigits === extractDigitsFromId(myId)) return;

    // skip non-text
    const body = (message.body || "").trim();
    if (!body) return;

    // Accept commands from allowed numbers (author or sender)
    const fromDigits = extractDigitsFromId(message.from);
    const authorDigits = extractDigitsFromId(message.author || "");
    const senderDigits = authorDigits || fromDigits;
    const lowered = body.toLowerCase().replace(/\s+/g, " ").trim();

    // ADMIN COMMANDS (from allowedNumbers)
    if (isAllowedNumberDigits(senderDigits)) {
      const startCommands = new Set(["start moderation", "startmod", "start moderation now", "start", "enable moderation", "enable"]);
      const stopCommands  = new Set(["stop moderation", "stopmod", "stop", "disable moderation", "disable"]);
      if (startCommands.has(lowered)) {
        moderationActive = true;
        await client.sendMessage(message.from, "✅ Moderation started.").catch(() => {});
        log(`Moderation started by ${senderDigits}`);
        return;
      }
      if (stopCommands.has(lowered)) {
        moderationActive = false;
        await client.sendMessage(message.from, "⛔ Moderation stopped.").catch(() => {});
        log(`Moderation stopped by ${senderDigits}`);
        return;
      }
      if (lowered === "check admin") {
        const am = await isBotAdminIn(chat);
        await client.sendMessage(message.from, `Bot admin in this group: ${am ? "Yes" : "No"}`).catch(() => {});
        return;
      }
      if (lowered.startsWith("check warnings")) {
        const parts = lowered.split(/\s+/);
        const target = parts[2] || parts[1];
        if (!target) {
          await client.sendMessage(message.from, "Usage: check warnings <phoneDigits>").catch(() => {});
        } else {
          const targDigits = target.replace(/\D/g,"");
          const count = warnings[targDigits] || 0;
          await client.sendMessage(message.from, `Warnings for ${targDigits}: ${count}`).catch(() => {});
        }
        return;
      }
      if (lowered.startsWith("reset warnings")) {
        const parts = lowered.split(/\s+/);
        const target = parts[2] || parts[1];
        if (!target) {
          await client.sendMessage(message.from, "Usage: reset warnings <phoneDigits>").catch(() => {});
        } else {
          const targDigits = target.replace(/\D/g,"");
          delete warnings[targDigits];
          await saveWarnings();
          await client.sendMessage(message.from, `Warnings for ${targDigits} reset to 0.`).catch(() => {});
        }
        return;
      }
    }

    if (!moderationActive) return;

    // Check banned words
    let matched = false;
    if (bannedRegex) matched = bannedRegex.test(body);
    if (!matched) return;

    log(`Banned content detected from ${offenderDigits} in "${chat.name}":`, body);

    // Per-group admin check (refresh participants)
    let amAdmin = false;
    try { amAdmin = await isBotAdminIn(chat); } catch (e) { warn("Could not determine admin status:", e?.message || e); }

    // Try to delete the offending message (prefer everyone). If not admin, skip and notify.
    if (amAdmin) {
      try {
        await message.delete(true);
        log("Deleted offending message for everyone.");
      } catch (e) {
        warn("Failed to delete for everyone on first attempt:", e?.message || e);
        // Try one refresh + retry
        try {
          const refreshed = await refreshChatParticipants(chat);
          const participant = (refreshed.participants || []).find(p => (p.id && p.id._serialized) === myId);
          const nowAdmin = !!(participant && (participant.isAdmin || participant.isSuperAdmin));
          if (nowAdmin) {
            try { await message.delete(true); log("Deleted offending message for everyone on retry after refresh."); }
            catch (e2) { warn("Retry delete-for-everyone failed:", e2?.message || e2); await chat.sendMessage("⚠️ I detected banned content but I couldn't delete it for everyone even though I'm an admin. There may be a WhatsApp deletion limit or throttling in effect.").catch(()=>{}); }
          } else {
            await chat.sendMessage("⚠️ I detected banned content but I couldn't delete it for everyone — I am not an admin. Please make me a group admin to enable full moderation.").catch(()=>{});
          }
        } catch (refreshErr) {
          warn("Failed to refresh participants after delete failure:", refreshErr?.message || refreshErr);
          await chat.sendMessage("⚠️ I detected banned content but couldn't delete the message. Please ensure I am a group admin.").catch(()=>{});
        }
      }
    } else {
      // Not admin — attempt delete for me (best-effort) and notify group
      try { await message.delete(); log("Deleted message for me (bot not admin)."); } catch (e) { /* ignore */ }
      try { await chat.sendMessage("⚠️ I detected banned content but I couldn't delete it for everyone in this group. Please set me as group admin to allow moderation actions.").catch(()=>{}); } catch {}
    }

    // Increment warning count using digits-only key
    warnings[offenderDigits] = (warnings[offenderDigits] || 0) + 1;
    try { await saveWarnings(); } catch (e) { warn("Failed to persist warnings (will continue in-memory):", e?.message || e); }

    // Notify offender privately (best-effort)
    const warnCount = warnings[offenderDigits];
    const warnTextPrivate = `You have received a warning for using banned language in "${chat.name}". Warning ${warnCount}/${WARNINGS_THRESHOLD}. Please follow group rules.`;
    try {
      await client.sendMessage(offenderId, warnTextPrivate);
    } catch (e) {
      try {
        const contact = await client.getContactById(offenderId);
        await chat.sendMessage(`@${offenderDigits} ${warnTextPrivate}`, { mentions: contact ? [contact] : [] });
      } catch (e2) {
        warn("Failed to notify offender privately or mention in group:", e2?.message || e2);
      }
    }

    // If threshold reached, attempt removal (per-group admin check again)
    if (warnCount >= WARNINGS_THRESHOLD) {
      let canRemove = amAdmin;
      if (!canRemove) {
        try {
          const refreshed = await refreshChatParticipants(chat);
          const participant = (refreshed.participants || []).find(p => (p.id && p.id._serialized) === myId);
          canRemove = !!(participant && (participant.isAdmin || participant.isSuperAdmin));
        } catch (e) { /* ignore */ }
      }

      if (canRemove) {
        try {
          await chat.removeParticipants([offenderId]);
          await chat.sendMessage(`User removed for repeated use of banned language (warnings: ${warnCount}).`);
          delete warnings[offenderDigits];
          await saveWarnings();
        } catch (e) {
          console.error("Failed to remove participant (ensure bot is admin):", e?.message || e);
          try {
            const contact = await client.getContactById(offenderId);
            await chat.sendMessage(`⚠️ I would remove @${offenderDigits} for repeated banned language, but I couldn't — please make me a group admin or remove them manually.`, { mentions: contact ? [contact] : [] });
          } catch {}
        }
      } else {
        try {
          const contact = await client.getContactById(offenderId);
          await chat.sendMessage(`⚠️ User has reached ${warnCount} warnings and should be removed, but I cannot remove participants because I'm not an admin. Please remove @${offenderDigits} manually.`, { mentions: contact ? [contact] : [] });
        } catch {
          await chat.sendMessage(`⚠️ User has reached ${warnCount} warnings and should be removed, but I cannot remove participants because I'm not an admin. Please remove them manually.`);
        }
      }
    }

  } catch (err) {
    console.error("ERROR reading message:", err?.message || err);
  }
});

// Start HTTP server for health/status and start WhatsApp client
startHttpServer();
client.initialize().catch(err => {
  console.error("Failed to start WhatsApp client:", err?.message || err);
});
