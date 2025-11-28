/**
 * index.js
 * Railway-compatible WhatsApp moderation bot using whatsapp-web.js
 *
 * Environment vars (added/changed options):
 *   BANNED_WORDS         (optional) comma separated list of banned words
 *   ALLOWED_NUMBERS      (optional) comma separated numbers (digits only or with +)
 *   TARGET_GROUP_NAME    (optional) group name to moderate (default: "6RL3 of 2025")
 *   WARNINGS_THRESHOLD   (optional) number of warnings before removing (default: 3)
 *   MODERATION_ACTIVE    (optional) "true" or "false" starting state (default: true)
 *   FORCE_QR             (optional) "true" to delete existing LocalAuth session and force QR on startup
 *   CHROMIUM_PATH        (optional) path to Chromium/Chrome binary if needed on the host
 *
 * Requires:
 *   npm install whatsapp-web.js qrcode-terminal
 *
 * Notes:
 * - Bot must be admin in target group to delete messages / remove participants.
 * - Railway ephemeral disk will lose LocalAuth on redeploy; use FORCE_QR=true to force fresh QR.
 */

// ----------------- Moderation rules (exact snippet requested) -----------------
const bannedWords = new Set((process.env.BANNED_WORDS || "fuck,shit,hell,damn,bitch,ass,bastard,femboy,dih,dick,pussy").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
const allowedNumbers = (process.env.ALLOWED_NUMBERS || "6580480362,6585038335").split(",").map(s => s.replace(/\D/g,"")).filter(Boolean);
// ------------------------------------------------------------------------------

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

const WARNINGS_FILE = path.join(__dirname, "warnings.json");
const TARGET_GROUP_NAME = process.env.TARGET_GROUP_NAME || "6RL3 of 2025";
const WARNINGS_THRESHOLD = parseInt(process.env.WARNINGS_THRESHOLD || "3", 10);
let moderationActive = (process.env.MODERATION_ACTIVE || "true").toLowerCase() === "true";

// Option to force QR by removing existing LocalAuth store for this clientId
const FORCE_QR = (process.env.FORCE_QR || "false").toLowerCase() === "true";
const CLIENT_ID = "modbot"; // used by LocalAuth (and to locate its folder if forcing QR)
const LOCAL_AUTH_BASE = path.join(process.cwd(), ".wwebjs_auth", CLIENT_ID);

if (FORCE_QR) {
  try {
    if (fs.existsSync(LOCAL_AUTH_BASE)) {
      // Node versions differ; try rmSync, else rmdirSync as fallback
      if (fs.rmSync) {
        fs.rmSync(LOCAL_AUTH_BASE, { recursive: true, force: true });
      } else {
        fs.rmdirSync(LOCAL_AUTH_BASE, { recursive: true });
      }
      console.log(`FORCE_QR enabled — removed LocalAuth folder: ${LOCAL_AUTH_BASE}`);
    } else {
      console.log("FORCE_QR enabled — no existing LocalAuth folder to remove.");
    }
  } catch (e) {
    console.warn("FORCE_QR: failed to remove LocalAuth folder:", e && e.message ? e.message : e);
  }
}

const puppeteerArgs = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--no-first-run',
  '--no-zygote',
  '--single-process',
  '--disable-gpu'
];

// allow optional CHROMIUM_PATH env var for hosts that provide a binary path
const puppeteerOptions = {
  headless: true,
  args: puppeteerArgs
};
if (process.env.CHROMIUM_PATH) {
  puppeteerOptions.executablePath = process.env.CHROMIUM_PATH;
}

// small util: escape for regex
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a robust word-boundary regex using Unicode properties so punctuation/Unicode works better
const bannedArray = Array.from(bannedWords).map(w => escapeRegExp(w)).filter(Boolean);
const bannedRegex = bannedArray.length
  ? new RegExp(`(^|[^\\p{L}\\p{N}])(${bannedArray.join('|')})([^\\p{L}\\p{N}]|$)`, 'iu')
  : null;

// Load/store warnings
let warnings = {};
function loadWarnings() {
  try {
    if (fs.existsSync(WARNINGS_FILE)) {
      const raw = fs.readFileSync(WARNINGS_FILE, 'utf8') || "{}";
      warnings = JSON.parse(raw);
    } else {
      warnings = {};
    }
  } catch (e) {
    console.error("Failed to load warnings:", e && e.message ? e.message : e);
    warnings = {};
  }
}
function saveWarnings() {
  try {
    fs.writeFileSync(WARNINGS_FILE, JSON.stringify(warnings, null, 2));
  } catch (e) {
    console.error("Failed to save warnings:", e && e.message ? e.message : e);
  }
}

// Normalise an id like "65987654321@c.us" -> "65987654321"
function extractDigitsFromId(id) {
  if (!id) return "";
  return id.replace(/\D/g, "");
}

// Return true if a sender matches one of the allowedNumbers (compares by full digits or endsWith)
function isAllowedNumberDigits(digits) {
  if (!digits) return false;
  return allowedNumbers.some(n => {
    if (!n) return false;
    // match full or endsWith to accommodate variations (+65, leading zeros, etc.)
    return digits === n || digits.endsWith(n) || n.endsWith(digits);
  });
}

// Helper to format allowedNumbers for the startup message
function humanListAllowedNumbers() {
  if (!allowedNumbers.length) return "No admin numbers configured.";
  return allowedNumbers.map(n => {
    // if starts with country code like 65, show +65...
    if (n.length > 6) return "+" + n;
    return n;
  }).join(", ");
}

// Initialise client
const client = new Client({
  authStrategy: new LocalAuth({ clientId: CLIENT_ID }),
  puppeteer: puppeteerOptions
});

// cache my own id (reduces calls)
let myId = null;

client.on('qr', qr => {
  // Print QR to console for Railway logs and show printable QR
  qrcode.generate(qr, { small: true });
  console.log("Scan the above QR (printed in logs). If you can't scan from logs, fetch server logs.");
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
                                
