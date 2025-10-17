const axios = require("axios");
const cheerio = require("cheerio");
const mongoose = require("mongoose");
const { liveBot, debugBot } = require("./bot.js");
require("dotenv").config();

// MongoDB Connection Caching
let cached = global.mongoose;

const GRACE_PERIOD_MINUTES = 5;
// Define the accounts to monitor
const ACCOUNTS_TO_MONITOR = [
  "@dealintangg",
  "@vieyyy09",
  "@bontotewahidin",
  "@sintakarma.22",
  "@indrinugraha_",
  "@zforsure",
  "@userrsiva",
  "@anakmanisss.02",
  "@raya4zzhr",
  "@airahdc_",
  "@hafiza_luthfiana",
];

const USERNAME_TELEGRAM = "7319703092";

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function connectDB() {
  if (cached.conn) {
    return cached.conn;
  }

  if (!cached.promise) {
    const opts = {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    };

    cached.promise = mongoose
      .connect(process.env.URL, opts)
      .then((mongoose) => {
        return mongoose;
      });
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

const LiveStatusSchema = new mongoose.Schema({
  userId: { type: String, unique: true },
  isLive: { type: Boolean, default: false },
  lastLiveStart: { type: Date },
  lastCheck: { type: Date },
  tempOfflineSince: { type: Date, default: null },
  isInGracePeriod: { type: Boolean, default: false },
});

const liveSessionSchema = new mongoose.Schema({
  username: { type: String, required: true },
  startTime: { type: Date, required: true },
  endTime: { type: Date },
  duration: { type: Number },
  date: { type: String },
});

// Schema for tracking HTML debug files
const HtmlDebugSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  reason: { type: String, required: true }, // 'no_sigi_state', 'no_profile_page', 'both_missing'
  fileName: { type: String, required: true },
  telegramFileId: { type: String },
  timestamp: { type: Date, default: Date.now },
});

const LiveStatusModel =
  mongoose.models.LiveStatus || mongoose.model("LiveStatus", LiveStatusSchema);

const LiveSessionModel =
  mongoose.models.LiveSession ||
  mongoose.model("LiveSession", liveSessionSchema);

const HtmlDebugModel =
  mongoose.models.HtmlDebug || mongoose.model("HtmlDebug", HtmlDebugSchema);

// Processing flag
let isProcessing = false;

// Helper Functions
async function sendHtmlToTelegram(userId, htmlContent, reason) {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `${userId.replace("@", "")}_${reason}_${timestamp}.html`;

    // Create buffer from HTML content
    const fileBuffer = Buffer.from(htmlContent, "utf8");

    // Gunakan debugBot untuk mengirim file HTML (lebih reliable)
    if (debugBot) {
      try {
        const response = await debugBot.sendDocument(
          USERNAME_TELEGRAM,
          fileBuffer,
          {
            caption: `📄 HTML Debug File\nUser: ${userId}\nReason: ${reason}\nFile: ${fileName}`,
            filename: fileName,
          }
        );

        const telegramFileId = response.document.file_id;
        console.log(
          `✅ HTML file sent via debugBot: ${fileName} (File ID: ${telegramFileId})`
        );

        // Save debug info to database
        try {
          const debugRecord = new HtmlDebugModel({
            userId: userId,
            reason: reason,
            fileName: fileName,
            telegramFileId: telegramFileId,
          });
          await debugRecord.save();
          console.log(`Debug record saved to database for ${userId}`);
        } catch (dbError) {
          console.error("Error saving debug record to database:", dbError);
        }

        return {
          fileName: fileName,
          telegramFileId: telegramFileId,
        };
      } catch (debugBotError) {
        console.warn(
          "debugBot failed, trying liveBot as fallback:",
          debugBotError.message
        );
        // Fallback ke liveBot jika debugBot gagal
        throw debugBotError;
      }
    }

    // Fallback: Jika debugBot tidak tersedia atau gagal
    console.log("Sending via liveBot as fallback...");
    const truncatedHtml = htmlContent.substring(0, 4000);
    const message = `📄 HTML Debug File\nUser: ${userId}\nReason: ${reason}\nFile: ${fileName}\n\n\`\`\`html\n${truncatedHtml}${
      htmlContent.length > 4000 ? "\n...[truncated]" : ""
    }\n\`\`\``;

    await liveBot.sendMessage(USERNAME_TELEGRAM, message, {
      parse_mode: "HTML",
    });

    console.log(
      `✅ HTML sent to Telegram via liveBot (truncated): ${fileName}`
    );

    return {
      fileName: fileName,
      telegramFileId: null,
    };
  } catch (error) {
    console.error(
      "Error sending HTML to Telegram:",
      error.response?.data || error.message
    );

    // Fallback: send notification only
    try {
      const message = `⚠️ HTML Debug Needed\nUser: ${userId}\nReason: ${reason}\nNote: Could not send HTML file directly`;
      await debugBot.sendMessage(USERNAME_TELEGRAM, message);
    } catch (fallbackError) {
      console.error("Error sending fallback message:", fallbackError);
    }
    return null;
  }
}

async function updateLiveStatus(userId, isCurrentlyLive) {
  try {
    const currentTime = new Date();
    let liveStatus = await LiveStatusModel.findOne({ userId });
    const formattedDate = currentTime.toISOString().split("T")[0];
    let shouldNotify = false;

    if (!liveStatus) {
      liveStatus = new LiveStatusModel({
        userId,
        isLive: isCurrentlyLive,
        lastLiveStart: isCurrentlyLive ? currentTime : null,
        lastCheck: currentTime,
        tempOfflineSince: null,
        isInGracePeriod: false,
      });

      await liveStatus.save();

      if (isCurrentlyLive) {
        await createNewLiveSession(userId, currentTime, formattedDate);
        shouldNotify = true;
      }

      return shouldNotify;
    }

    liveStatus.lastCheck = currentTime;

    if (isCurrentlyLive && !liveStatus.isLive) {
      if (liveStatus.isInGracePeriod && liveStatus.tempOfflineSince) {
        console.log(
          `${userId} kembali live setelah jeda ${Math.round(
            (currentTime - liveStatus.tempOfflineSince) / (1000 * 60)
          )} menit`
        );

        liveStatus.isLive = true;
        liveStatus.isInGracePeriod = false;
        liveStatus.tempOfflineSince = null;
        await liveStatus.save();
        shouldNotify = false;
      } else {
        liveStatus.isLive = true;
        liveStatus.lastLiveStart = currentTime;
        liveStatus.isInGracePeriod = false;
        liveStatus.tempOfflineSince = null;
        await liveStatus.save();

        await createNewLiveSession(userId, currentTime, formattedDate);
        shouldNotify = true;
      }
    } else if (isCurrentlyLive && liveStatus.isLive) {
      await liveStatus.save();
      shouldNotify = false;
    } else if (!isCurrentlyLive && liveStatus.isLive) {
      liveStatus.isInGracePeriod = true;
      liveStatus.tempOfflineSince = currentTime;
      liveStatus.isLive = false;
      await liveStatus.save();

      console.log(
        `${userId} terdeteksi offline pada ${currentTime.toISOString()}, masuk masa jeda ${GRACE_PERIOD_MINUTES} menit`
      );

      shouldNotify = false;
    } else if (!isCurrentlyLive && !liveStatus.isLive) {
      if (liveStatus.isInGracePeriod && liveStatus.tempOfflineSince) {
        const minutesSinceOffline =
          (currentTime - liveStatus.tempOfflineSince) / (1000 * 60);

        if (minutesSinceOffline > GRACE_PERIOD_MINUTES) {
          console.log(
            `${userId} masih offline setelah ${Math.round(
              minutesSinceOffline
            )} menit, menyelesaikan sesi live`
          );

          liveStatus.isInGracePeriod = false;
          await liveStatus.save();

          await completeLiveSession(userId, liveStatus.tempOfflineSince);
        } else {
          console.log(
            `${userId} masih dalam masa jeda (${Math.round(
              minutesSinceOffline
            )}/${GRACE_PERIOD_MINUTES} menit)`
          );
        }
      }
      await liveStatus.save();
      shouldNotify = false;
    }

    return shouldNotify;
  } catch (error) {
    console.error("Error updating live status:", error);
    return false;
  }
}

async function createNewLiveSession(username, startTime, formattedDate) {
  try {
    const newSession = new LiveSessionModel({
      username: username,
      startTime: startTime,
      date: formattedDate,
    });

    await newSession.save();
    console.log(
      `New live session created for ${username} at ${startTime.toISOString()}`
    );
    return newSession;
  } catch (e) {
    console.error("Error creating live session:", e);
    return null;
  }
}

async function completeLiveSession(username, endTime) {
  try {
    const ongoingSession = await LiveSessionModel.findOne({
      username: username,
      endTime: { $exists: false },
    }).sort({ startTime: -1 });

    if (ongoingSession) {
      const durationMinutes = Math.round(
        (endTime - ongoingSession.startTime) / (1000 * 60)
      );

      ongoingSession.endTime = endTime;
      ongoingSession.duration = durationMinutes;

      await ongoingSession.save();
      console.log(
        `Live session ended for ${username}. Duration: ${durationMinutes} minutes`
      );
      return ongoingSession;
    } else {
      console.log(`No ongoing live session found for ${username}`);
      return null;
    }
  } catch (e) {
    console.error("Error completing live session:", e);
    return null;
  }
}

async function checkLiveStatus(userData, userId) {
  const $ = cheerio.load(userData);
  const scriptContent = $("#SIGI_STATE").html();
  const isLive = /"isLiveBroadcast"\s*:\s*true/.test(userData);
  const profilePageContent = $("#ProfilePage").html();

  // Check for missing elements and send HTML if needed
  const missingSigiState = !scriptContent;
  const missingProfilePage = !profilePageContent;

  if (missingSigiState || missingProfilePage) {
    let reason;
    if (missingSigiState && missingProfilePage) {
      reason = "both_missing";
    } else if (missingSigiState) {
      reason = "no_sigi_state";
    } else {
      reason = "no_profile_page";
    }

    console.warn(
      `⚠️ ${reason
        .replace(/_/g, " ")
        .toUpperCase()} detected for ${userId} - sending HTML to Telegram`
    );

    // Send HTML to Telegram
    await sendHtmlToTelegram(userId, userData, reason);
  }

  let isWatchCount = false;

  if (profilePageContent) {
    try {
      const profileData = JSON.parse(profilePageContent);

      const watch =
        profileData.mainEntity?.interactionStatistic?.find(
          (stat) =>
            stat.interactionType["@type"] === "http://schema.org/WatchAction"
        )?.userInteractionCount ?? 0;

      isWatchCount = watch > 5;
    } catch (err) {
      console.error("Failed to parse ProfilePage JSON:", err);
    }
  } else {
    console.warn(`No ProfilePage script found for ${userId}`);
  }

  if (!scriptContent && !isLive) {
    console.warn(`No SIGI_STATE and no live broadcast detected for ${userId}`);
  }

  let message = "";
  let shouldNotify = false;

  let sigIState = null;
  if (scriptContent) {
    try {
      sigIState = JSON.parse(scriptContent);
    } catch (error) {
      console.error(`Error parsing SIGI_STATE for ${userId}:`, error);
    }
  }

  const status = sigIState?.LiveRoom?.liveRoomUserInfo?.user?.status;

  if (status === 2 || isWatchCount) {
    message = `${userId} sedang live!`;
    liveBot.sendMessage(USERNAME_TELEGRAM, message);
    shouldNotify = await updateLiveStatus(userId, true);

    if (shouldNotify) {
      message = `${userId} baru saja mulai live!`;
      console.log(message);
    } else {
      message = `${userId} masih live (notifikasi tidak dikirim)`;
      console.log(message);
    }
  } else {
    await updateLiveStatus(userId, false);
    message = `${userId} tidak sedang live.`;
    console.log(message);
  }

  return { message, isLive: status === 2 };
}

async function checkAllAccounts() {
  const results = {};

  for (const account of ACCOUNTS_TO_MONITOR) {
    try {
      const response = await axios.get(
        `https://www.tiktok.com/${account}/live`,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
        }
      );

      console.log(`TikTok response status for ${account}:`, response.status);
      const result = await checkLiveStatus(response.data, account);
      results[account] = result;
    } catch (error) {
      console.error(`Error checking ${account}:`, error);
      results[account] = {
        message: `Error checking account: ${error.message}`,
        isLive: false,
      };
    }
  }

  return results;
}

module.exports = async function handler(req, res) {
  // Enable CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Connect to MongoDB
  try {
    await connectDB();
  } catch (error) {
    console.error("Database connection error:", error);
    return res.status(500).json({ message: "Database connection failed" });
  }

  // Route handling
  const path = req.url.split("?")[0];

  // Handle /live endpoint
  if (path === "/live" && req.method === "GET") {
    if (isProcessing) {
      return res
        .status(429)
        .json({ message: "Request is already being processed" });
    }

    isProcessing = true;

    try {
      const results = await checkAllAccounts();
      return res.status(200).json({ accounts: results });
    } catch (error) {
      console.error("Terjadi kesalahan:", error);
      return res.status(500).json({ message: "Terjadi kesalahan" });
    } finally {
      isProcessing = false;
    }
  }

  // Handle /livesessions endpoint
  if (path === "/livesessions" && req.method === "GET") {
    try {
      const username = req.query.username;
      const query = username ? { username } : {};

      const sessions = await LiveSessionModel.find(query).sort({
        startTime: -1,
      });
      return res.json(sessions);
    } catch (e) {
      console.error("Error fetching live sessions:", e.message);
      return res
        .status(500)
        .json({ message: "Server error fetching live sessions" });
    }
  }

  // Handle /debug-files endpoint - view saved HTML debug files
  if (path === "/debug-files" && req.method === "GET") {
    try {
      const userId = req.query.userId;
      const query = userId ? { userId } : {};

      const debugFiles = await HtmlDebugModel.find(query).sort({
        timestamp: -1,
      });
      return res.json(debugFiles);
    } catch (e) {
      console.error("Error fetching debug files:", e.message);
      return res
        .status(500)
        .json({ message: "Server error fetching debug files" });
    }
  }

  // Handle unknown routes
  return res.status(404).json({ message: "Not found" });
};
