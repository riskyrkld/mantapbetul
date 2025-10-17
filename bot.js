const TelegramBot = require("node-telegram-bot-api");
require("dotenv").config();

// Bot 1: untuk informasi live
const LIVE_BOT_TOKEN = "7122030840:AAHmsuvm2rEIVJL1TbUWVnPXtjCrpcCEUFA";
const liveBot = new TelegramBot(LIVE_BOT_TOKEN, { polling: false });
console.log("✅ Live Bot initialized");

// Bot 2: untuk kirim file HTML debug
const DEBUG_BOT_TOKEN = "8438488742:AAEGncK5SIineac8494N2SGjINtMHUUVtFU";
const debugBot = DEBUG_BOT_TOKEN
  ? new TelegramBot(DEBUG_BOT_TOKEN, { polling: false })
  : null;

if (debugBot) {
  console.log("✅ Debug Bot initialized");
} else {
  console.warn(
    "⚠️ DEBUG_BOT_TOKEN tidak ditemukan di .env, debug file tidak akan terkirim"
  );
}

module.exports = {
  liveBot,
  debugBot,
  bot: liveBot,
};
