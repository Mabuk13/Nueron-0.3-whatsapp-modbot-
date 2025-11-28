/**
 * index.js — Multi-group WhatsApp moderation bot (robust read/write)
 *
 * Primary goals:
 *  - Keep your moderation rules EXACT (unchanged)
 *  - Robust, atomic read/write of warnings file
 *  - Back up corrupted JSON if detected
 *  - Queue saves within the process to avoid races
 *  - Graceful fallback to memory-only if disk is not writable
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

// MULTI-GROUP SUPPORT (adjust names as required)
const TARGET_GROUPS = [
  "6-3 of '25",
  "⭒๋𐙚 6MAJ 2025 ֶָ֢ᯓ★"
];

const WARNINGS_FILE = path.resolve(process.env.WARNINGS_FILE || path.join(__dirname, "warnings.json"));
const WARNINGS_THRESHOLD = parseInt(process.env.WARNINGS_THRESHOLD || "3", 10);
let moderationActive = (process.env.MODERATION_ACTIVE || "true").toLowerCase() === "true";

const FORCE_QR = (process.env.FORCE_QR || "false").toLowerCase() === "true";
const CLIENT_ID = "modbot";
const LOCAL_AUTH_BASE = path.join(process.cwd(), ".wwebjs_auth", CLIENT_ID);

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

// If user requested a forced QR, attempt to remove LocalAuth folder (best-effort)
if (FORCE_QR) {
  try {
    if (fs.existsSync(LOCAL_AUTH_BASE)) {
      if (fs.rmSync) fs.rmSync(LOCAL_AUTH_BASE, { recursive: true, force: true });
      else fs.rmdirSync(LOCAL_AUTH_BASE, { recursive: true });
      console.log(`FORCE_QR enabled — removed LocalAuth folder: ${LOCAL_AUTH_BASE}`);
    } else {
      console.log("FORCE_QR enabled — no existing LocalAuth folder to remove.");
    }
  } catch (e) {
    console.warn("FORCE_QR: failed to remove LocalAuth folder:", e?.message || e);
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
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (e) {
    // ignore: may fail on readonly FS
  }
}

// Load warnings from disk safely.
// If JSON parse fails, move the corrupted file to a backup and continue with empty store.
async function loadWarnings() {
  try {
    await ensureDirForFile(WARNINGS_FILE);
    const exists = fs.existsSync(WARNINGS_FILE);
    if (!exists) {
      warnings = {};
      return;
    }
    const raw = await fsp.readFile(WARNINGS_FILE, "utf8");
    try {
      const parsed = JSON.parse(raw || "{}");
      // Normalise keys to digits-only (in case old data used serialized IDs)
      const normalised = {};
      for (const key of Object.keys(parsed || {})) {
        const digits = key.replace(/\D/g, "");
        normalised[digits || key] = parsed[key];
      }
      warnings = normalised;
    } catch (parseErr) {
      // Backup corrupted file with timestamp
      const ts = (new Date()).toISOString().replace(/[:.]/g, "-");
      const corruptPath = `${WARNINGS_FILE}.corrupt.${ts}`;
      try {
        await fsp.rename(WARNINGS_FILE, corruptPath);
        console.error(`Warnings file corrupted — moved to ${corruptPath}. Starting with empty warnings store.`);
      } catch (renameErr) {
        console.error("Failed to back up corrupted warnings file:", renameErr?.message || renameErr);
        // try to copy instead
        try { await fsp.copyFile(WARNINGS_FILE, corruptPath); } catch {}
      }
      warnings = {};
    }
  } catch (err) {
    console.error("Failed to load warnings from disk — continuing with in-memory store. Error:", err?.message || err);
    warnings = {};
    // mark disk writes disabled to avoid noisy repeated errors
    diskWritesDisabled = true;
  }
}

// Atomic save function with simple in-process queuing.
// Writes to a temp file then renames into place. On failure sets diskWritesDisabled.
async function saveWarnings() {
  // If disk writes disabled, resolve immediately (in-memory only)
  if (diskWritesDisabled) return;

  // If a save is already in progress, queue another save and return
  if (saveInProgress) {
    saveQueued = true;
    return;
  }
  saveInProgress = true;
  try {
    await ensureDirForFile(WARNINGS_FILE);
    const tmpPath = `${WARNINGS_FILE}.tmp`;
    const data = JSON.stringify(warnings, null, 2);

    // Write to temp file first
    await fsp.writeFile(tmpPath, data, { encoding: "utf8", flag: "w" });

    // fsync is platform-dependent via filehandle; rename is typically atomic on POSIX
    await fsp.rename(tmpPath, WARNINGS_FILE);
  } catch (err) {
    console.error("Failed to save warnings to disk. Disabling disk writes. Error:", err?.message || err);
    diskWritesDisabled = true;
    // Attempt to clean up temp file if present
    try { if (fs.existsSync(`${WARNINGS_FILE}.tmp`)) await fsp.unlink(`${WARNINGS_FILE}.tmp`); } catch {}
  } finally {
    saveInProgress = false;
    if (saveQueued) {
      saveQueued = false;
      // schedule next save (don't await here to avoid re-entrancy)
      saveWarnings().catch(e => console.error("Queued save failed:", e?.message || e));
    }
  }
}

// Normalise id -> digits string (used as key)
function extractDigitsFromId(id) {
  if (!id) return "";
  return id.replace(/\D/g, "");
}

function isAllowedNumberDigits(digits) {
  if (!digits) return false;
  return allowedNumbers.some(n => {
    if (!n) return false;
    return digits === n || digits.endsWith(n) || n.endsWith(digits);
  });
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

let myId = null;

client.on('qr', qr => {
  qrcode.generate(qr, { small: true });
  console.log("Scan the above QR (printed in logs).");
});

client.on('authenticated', () => {
  console.log("Authenticated successfully.");
});

client.on('auth_failure', msg => {
  console.error("Authentication failure:", msg);
});

client.on('ready', async () => {
  try {
    console.log("WhatsApp client is ready.");
    await loadWarnings();

    // cache own id
    try {
      const me = await client.getMe();
      myId = (me && me._serialized) ? me._serialized : null;
    } catch (e) {
      console.warn("Could not fetch own contact id on ready:", e?.message || e);
    }

    console.log(`Moderation ${moderationActive ? "active" : "inactive"}. Target groups: ${TARGET_GROUPS.join(" | ")}`);

    // Inform each found group that bot is online (best-effort)
    try {
      const chats = await client.getChats();
      for (const groupName of TARGET_GROUPS) {
        const targetChat = chats.find(c => c.isGroup && c.name === groupName);
        if (!targetChat) {
          console.warn(`Target group "${groupName}" not found. Startup notification not sent for that group.`);
          continue;
        }
        const startupMsg = [
          "🤖 Moderation Bot ONLINE",
          `Group: "${groupName}"`,
          `Moderation state: ${moderationActive ? "**Active**" : "**Inactive**"}.`,
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
      console.error("Failed to send some startup notifications:", e?.message || e);
    }
  } catch (err) {
    console.error("Error in ready handler:", err?.message || err);
  }
});

// Reconnection handler
client.on('disconnected', reason => {
  console.warn("Client disconnected:", reason);
});

// MAIN MESSAGE HANDLER
client.on('message', async (message) => {
  try {
    // Always log when a message is read
    console.log("MSG's read");

    // Ensure we can process this message
    let chat;
    try {
      chat = await message.getChat();
    } catch (e) {
      console.error("ERROR reading message: failed to get chat:", e?.message || e);
      return;
    }

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

    if (isAllowedNumberDigits(senderDigits)) {
      const startCommands = new Set(["start moderation", "startmod", "start moderation now", "start", "enable moderation", "enable"]);
      const stopCommands  = new Set(["stop moderation", "stopmod", "stop", "disable moderation", "disable"]);
      if (startCommands.has(lowered)) {
        moderationActive = true;
        await client.sendMessage(message.from, "✅ Moderation started.").catch(() => {});
        console.log(`Moderation started by ${senderDigits}`);
        return;
      }
      if (stopCommands.has(lowered)) {
        moderationActive = false;
        await client.sendMessage(message.from, "⛔ Moderation stopped.").catch(() => {});
        console.log(`Moderation stopped by ${senderDigits}`);
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

    console.log(`Banned content detected from ${offenderDigits} in "${chat.name}":`, body);

    // Try to delete the offending message
    try {
      await message.delete(true);
      console.log("Deleted offending message.");
    } catch (e) {
      console.warn("Failed to delete offending message (bot may not be admin):", e?.message || e);
      try {
        await chat.sendMessage("⚠️ I detected banned content but I couldn't delete it. Please set me as group admin to allow moderation actions.");
      } catch {}
    }

    // Increment warning count using digits-only key
    warnings[offenderDigits] = (warnings[offenderDigits] || 0) + 1;
    try {
      await saveWarnings();
    } catch (e) {
      // saveWarnings handles diskErrors and sets diskWritesDisabled; just log here
      console.error("Failed to persist warnings (will continue in-memory):", e?.message || e);
    }

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
        console.warn("Failed to notify offender privately or mention in group:", e2?.message || e2);
      }
    }

    // If threshold reached, attempt removal
    if (warnCount >= WARNINGS_THRESHOLD) {
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
    }

  } catch (err) {
    // If anything unexpected happens while reading/processing message, log a clear error
    console.error("ERROR reading message:", err?.message || err);
  }
});

// Start client
client.initialize().catch(err => {
  console.error("Failed to start WhatsApp client:", err?.message || err);
});
});

client.on('auth_failure', msg => {
  console.error("Authentication failure:", msg);
});

client.on('ready', async () => {
  try {
    console.log("WhatsApp client is ready.");
    loadWarnings();

    // cache my id
    try {
      const me = await client.getMe();
      myId = (me && me._serialized) ? me._serialized : null;
    } catch (e) {
      console.warn("Could not fetch own contact id on ready:", e && e.message ? e.message : e);
    }

    console.log(`Moderation ${moderationActive ? "active" : "inactive"}. Target group: "${TARGET_GROUP_NAME}".`);

    // Attempt to find the target group chat by name
    try {
      const chats = await client.getChats();
      const targetChat = chats.find(c => c.isGroup && c.name === TARGET_GROUP_NAME);
      if (!targetChat) {
        console.warn(`Target group "${TARGET_GROUP_NAME}" not found. Startup notification not sent.`);
        return;
      }

      // Compose startup message — reflect current moderation state and admin control instructions
      const startupMsg = [
        "🤖 Moderation Bot ONLINE",
        `Group: "${TARGET_GROUP_NAME}"`,
        `Moderation state: ${moderationActive ? "**Active**" : "**Inactive**"}.`,
        "",
        "How to control moderation:",
        `• Admins listed in configuration can start moderation by sending the command: "start moderation"`,
        `• To stop moderation send: "stop moderation"`,
        `Configured admin numbers: ${humanListAllowedNumbers()}`,
        "",
        "Note: The bot needs to be a group admin to delete messages or remove participants."
      ].join("\n");

      // Send startup message to the target group
      await targetChat.sendMessage(startupMsg);
      console.log(`Startup notification sent to "${TARGET_GROUP_NAME}".`);
    } catch (e) {
      console.error("Failed to send startup notification:", e && e.message ? e.message : e);
    }
  } catch (err) {
    console.error("Error in ready handler:", err && err.message ? err.message : err);
  }
});

// Automatic reconnection/logging
client.on('disconnected', reason => {
  console.warn("Client disconnected:", reason);
});

// Main message handler
client.on('message', async (message) => {
  try {
    // Accept commands from allowed numbers (either in a personal chat or as the author in any chat)
    const fromDigits = extractDigitsFromId(message.from);
    const authorDigits = extractDigitsFromId(message.author || "");
    const senderDigits = authorDigits || fromDigits; // prefer group author if available

    // Helper to reply in same chat
    const reply = async (text) => {
      try { await client.sendMessage(message.from, text); } catch (e) { console.error("Reply failed:", e && e.message ? e.message : e); }
    };

    // COMMANDS (only from allowedNumbers)
    const lowered = (message.body || "").trim().toLowerCase();

    if (isAllowedNumberDigits(senderDigits)) {
      // recognise multiple variants (short and long forms)
      const normalised = lowered.replace(/\s+/g, " ").trim();
      const startCommands = new Set(["start moderation", "startmod", "start moderation now", "start", "enable moderation", "enable"]);
      const stopCommands  = new Set(["stop moderation", "stopmod", "stop", "disable moderation", "disable"]);
      if (startCommands.has(normalised)) {
        moderationActive = true;
        await reply("✅ Moderation started.");
        console.log(`Moderation started by ${senderDigits}`);
        return;
      }
      if (stopCommands.has(normalised)) {
        moderationActive = false;
        await reply("⛔ Moderation stopped.");
        console.log(`Moderation stopped by ${senderDigits}`);
        return;
      }
      // other admin commands: check warnings for a user
      if (normalised.startsWith("check warnings")) {
        const parts = normalised.split(/\s+/);
        const target = parts[2] || parts[1];
        if (!target) {
          await reply("Usage: check warnings <phoneDigits>");
        } else {
          const targDigits = target.replace(/\D/g,"");
          const count = warnings[targDigits] || 0;
          await reply(`Warnings for ${targDigits}: ${count}`);
        }
        return;
      }
      // allow resetting a user's warnings
      if (normalised.startsWith("reset warnings")) {
        const parts = normalised.split(/\s+/);
        const target = parts[2] || parts[1];
        if (!target) {
          await reply("Usage: reset warnings <phoneDigits>");
        } else {
          const targDigits = target.replace(/\D/g,"");
          delete warnings[targDigits];
          saveWarnings();
          await reply(`Warnings for ${targDigits} reset to 0.`);
        }
        return;
      }
    }

    // If moderation not active, ignore further moderation logic
    if (!moderationActive) return;

    // Only act inside groups that match TARGET_GROUP_NAME
    const chat = await message.getChat();
    if (!chat.isGroup) return; // only moderate groups

    // Check if this is the target group (so bot does not moderate unexpected groups)
    if (chat.name !== TARGET_GROUP_NAME) return;

    // Author of the message in groups should be message.author
    const offenderId = message.author || message.from; // as an id like "659xxxx@c.us" or "659xxxx@g.us"
    const offenderDigits = extractDigitsFromId(offenderId);

    // Ignore messages from the bot itself (compare digits)
    if (myId && extractDigitsFromId(myId) && offenderDigits === extractDigitsFromId(myId)) return;

    // If message has no body (stickers/media) - optionally skip
    const body = (message.body || "").trim();
    if (!body) return;

    // Check for banned words using the robust regex
    let matched = false;
    if (bannedRegex) matched = bannedRegex.test(body);

    if (!matched) return; // nothing to do

    console.log(`Banned content detected from ${offenderDigits} in group "${chat.name}":`, body);

    // Attempt to delete the offending message
    try {
      // delete for everyone (requires admin)
      await message.delete(true);
      console.log("Deleted offending message.");
    } catch (e) {
      console.warn("Failed to delete message (bot may not be admin):", e && e.message ? e.message : e);
      // notify group that bot needs admin for deletion
      try {
        await chat.sendMessage("⚠️ I detected banned content but I couldn't delete it. Please set me as group admin to allow moderation actions.");
      } catch (sendErr) {}
    }

    // Increment warning count
    warnings[offenderDigits] = (warnings[offenderDigits] || 0) + 1;
    saveWarnings();

    // Notify the offender privately and optionally in group (mention)
    const warnCount = warnings[offenderDigits];
    const warnTextPrivate = `You have received a warning for using banned language in "${chat.name}". Warning ${warnCount}/${WARNINGS_THRESHOLD}. Please follow group rules.`;
    try {
      // send private message to the offender
      await client.sendMessage(offenderId, warnTextPrivate);
    } catch (e) {
      // fallback: mention in group
      try {
        const contact = await client.getContactById(offenderId);
        await chat.sendMessage(`@${offenderDigits} ${warnTextPrivate}`, { mentions: contact ? [contact] : [] });
      } catch (e2) {
        console.warn("Failed to notify offender privately or in group:", e2 && e2.message ? e2.message : e2);
      }
    }

    // If threshold reached, try to remove participant
    if (warnCount >= WARNINGS_THRESHOLD) {
      try {
        console.log(`Warnings threshold reached for ${offenderDigits}. Attempting to remove from group.`);
        await chat.removeParticipants([offenderId]);
        await chat.sendMessage(`User removed for repeated use of banned language (warnings: ${warnCount}).`);
        delete warnings[offenderDigits];
        saveWarnings();
      } catch (e) {
        console.error("Failed to remove participant (ensure bot is admin):", e && e.message ? e.message : e);
        try {
          const contact = await client.getContactById(offenderId);
          await chat.sendMessage(`⚠️ I would remove @${offenderDigits} for repeated banned language, but I couldn't — please make me a group admin or remove them manually.`, { mentions: contact ? [contact] : [] });
        } catch (e2) {}
      }
    }

  } catch (err) {
    console.error("Error handling message:", err && err.message ? err.message : err);
  }
});

// Start client
client.initialize().catch(err => {
  console.error("Failed to start WhatsApp client:", err && err.message ? err.message : err);
});
                                
