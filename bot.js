const TelegramBot = require("node-telegram-bot-api");
require("dotenv").config();
const TOKEN = "7122030840:AAHmsuvm2rEIVJL1TbUWVnPXtjCrpcCEUFA";
console.log(TOKEN);
const bot = new TelegramBot(TOKEN, { polling: false });

module.exports = bot;
