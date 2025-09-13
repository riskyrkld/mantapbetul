const axios = require("axios");
const cheerio = require("cheerio");
const mongoose = require("mongoose");
const bot = require("./bot.js");
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
  isInGracePeriod: { type: Boolean, default: false }, // Flag untuk menandai pengguna dalam masa jeda
});

const liveSessionSchema = new mongoose.Schema({
  username: { type: String, required: true },
  startTime: { type: Date, required: true },
  endTime: { type: Date },
  duration: { type: Number }, // dalam menit
  date: { type: String }, // format: YYYY-MM-DD
});

const LiveStatusModel =
  mongoose.models.LiveStatus || mongoose.model("LiveStatus", LiveStatusSchema);

const LiveSessionModel =
  mongoose.models.LiveSession ||
  mongoose.model("LiveSession", liveSessionSchema);

// Processing flag
let isProcessing = false;

// Helper Functions
async function updateLiveStatus(userId, isCurrentlyLive) {
  try {
    const currentTime = new Date();
    let liveStatus = await LiveStatusModel.findOne({ userId });
    const formattedDate = currentTime.toISOString().split("T")[0];
    let shouldNotify = false;

    // Jika tidak ada status live yang tersimpan sebelumnya
    if (!liveStatus) {
      // Membuat record LiveStatus baru
      liveStatus = new LiveStatusModel({
        userId,
        isLive: isCurrentlyLive,
        lastLiveStart: isCurrentlyLive ? currentTime : null,
        lastCheck: currentTime,
        tempOfflineSince: null, // Menambahkan field untuk melacak kapan jeda dimulai
        isInGracePeriod: false,
      });

      await liveStatus.save();

      // Jika sedang live, buat sesi baru
      if (isCurrentlyLive) {
        await createNewLiveSession(userId, currentTime, formattedDate);
        shouldNotify = true;
      }

      return shouldNotify;
    }

    // Update waktu pemeriksaan terakhir
    liveStatus.lastCheck = currentTime;

    // Kondisi 1: Status berubah dari tidak live menjadi live
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

        // Membuat catatan LiveSession baru setiap kali pengguna memulai live
        await createNewLiveSession(userId, currentTime, formattedDate);
        shouldNotify = true;
      }
    }
    // Kondisi 2: Masih live (tidak ada perubahan status)
    else if (isCurrentlyLive && liveStatus.isLive) {
      await liveStatus.save();
      shouldNotify = false;
    }
    // Kondisi 3: Status berubah dari live menjadi tidak live
    else if (!isCurrentlyLive && liveStatus.isLive) {
      liveStatus.isInGracePeriod = true;
      liveStatus.tempOfflineSince = currentTime;
      liveStatus.isLive = false;
      await liveStatus.save();

      console.log(
        `${userId} terdeteksi offline pada ${currentTime.toISOString()}, masuk masa jeda ${GRACE_PERIOD_MINUTES} menit`
      );

      // Menyelesaikan sesi live yang sedang berlangsung
      // await completeLiveSession(userId, currentTime);
      shouldNotify = false;
    }
    // Kondisi 4: Tetap tidak live
    else if (!isCurrentlyLive && !liveStatus.isLive) {
      // Cek apakah pengguna dalam masa jeda dan sudah melewati batas waktu jeda
      if (liveStatus.isInGracePeriod && liveStatus.tempOfflineSince) {
        const minutesSinceOffline =
          (currentTime - liveStatus.tempOfflineSince) / (1000 * 60);

        if (minutesSinceOffline > GRACE_PERIOD_MINUTES) {
          // Grace period habis, sekarang kita selesaikan sesi live
          console.log(
            `${userId} masih offline setelah ${Math.round(
              minutesSinceOffline
            )} menit, menyelesaikan sesi live`
          );

          // Reset flag grace period
          liveStatus.isInGracePeriod = false;
          await liveStatus.save();

          // Menyelesaikan sesi live dengan waktu offline awal sebagai waktu akhir
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
    // Cari sesi live terbaru yang belum memiliki waktu berakhir
    const ongoingSession = await LiveSessionModel.findOne({
      username: username,
      endTime: { $exists: false },
    }).sort({ startTime: -1 });

    if (ongoingSession) {
      // Hitung durasi dalam menit
      const durationMinutes = Math.round(
        (endTime - ongoingSession.startTime) / (1000 * 60)
      );

      // Update sesi dengan waktu berakhir dan durasi
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

  if (status === 2) {
    message = `${userId} sedang live!`;
    bot.sendMessage(USERNAME_TELEGRAM, message);
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
// Check all accounts function
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

  // Handle /live endpoint - always checks all accounts
  if (path === "/live" && req.method === "GET") {
    if (isProcessing) {
      return res
        .status(429)
        .json({ message: "Request is already being processed" });
    }

    isProcessing = true;

    try {
      // Always check all accounts
      const results = await checkAllAccounts();
      return res.status(200).json({ accounts: results });
    } catch (error) {
      console.error("Terjadi kesalahan:", error);
      return res.status(500).json({ message: "Terjadi kesalahan" });
    } finally {
      isProcessing = false;
    }
  }

  if (path == "/livesessions" && req.method === "GET") {
    try {
      // Allow filtering by username
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

  // Handle unknown routes
  return res.status(404).json({ message: "Not found" });
};
