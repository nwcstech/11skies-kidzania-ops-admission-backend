const express = require("express");
const fs = require("fs");
const https = require("https");
const socketIo = require("socket.io");
const Redis = require("ioredis");
const morgan = require("morgan");
const winston = require("winston");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Op } = require("sequelize");
const db = require("./models");
require("dotenv").config({ path: ".admission-env" });
const cors = require("cors");
const checkApiKey = require("./middleware/checkApiKey");
const activityRoutes = require("./activityRoutes");
const moment = require("moment-timezone");

// Set default timezone
moment.tz.setDefault("Asia/Singapore");

// Validate environment variables
const requiredEnvVars = [
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_HOST",
  "REDIS_HOST",
  "REDIS_PORT",
  "NODE_ENV",
  "API_KEY",
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Set up Winston logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});

const app = express();

// Security middleware
app.use(helmet());

// Enable CORS for all routes
app.use(cors());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10000,
  message: "Too many requests from this IP, please try again later.",
});
// app.use(limiter);

// HTTP request logging
app.use(
  morgan("combined", {
    stream: { write: (message) => logger.info(message.trim()) },
  })
);

// Test DB connection and sync
db.sequelize
  .authenticate()
  .then(() => {
    logger.info("Database connected successfully");
    return db.sequelize.sync();
  })
  .then(() => {
    logger.info("Database synchronized");
  })
  .catch((error) => {
    logger.error(`Database synchronization failed: ${error.message}`, {
      name: error.name,
      stack: error.stack,
    });
    process.exit(1);
  });

// Create HTTPS server and socket.io instance
const httpsOptions = {
  key: fs.readFileSync("server.key"),
  cert: fs.readFileSync("server.cert"),
};

const server = https.createServer(httpsOptions, app);
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:4200",
    methods: ["GET", "POST"],
  },
});
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
});

// Function to log current counts
const logCurrentCounts = async () => {
  try {
    const [totalGtsTickets, totalKids, totalCheckIns] = await redis.mget(
      "total_gts_tickets",
      "total_kids",
      "total_check_ins"
    );
    logger.info("Current counts:", {
      totalGtsTickets: parseInt(totalGtsTickets) || 0,
      totalKids: parseInt(totalKids) || 0,
      totalCheckIns: parseInt(totalCheckIns) || 0,
    });
  } catch (error) {
    logger.error(`Failed to log current counts: ${error.message}`);
  }
};

// Function to increment counts in Redis
const incrementCounts = async (numberOfKids, gtsTicketCount) => {
  const multi = redis.multi();
  multi.incrby("total_gts_tickets", gtsTicketCount);
  multi.incrby("total_kids", numberOfKids);
  multi.incr("total_check_ins");
  await multi.exec();
  // Emit updated counts to all connected clients
  const [totalGtsTickets, totalKids, totalCheckIns] = await redis.mget(
    "total_gts_tickets",
    "total_kids",
    "total_check_ins"
  );
  io.emit("update-counts", {
    totalGtsTickets: parseInt(totalGtsTickets) || 0,
    totalKids: parseInt(totalKids) || 0,
    totalCheckIns: parseInt(totalCheckIns) || 0,
  });
};

// Function to check for duplicates
const checkForDuplicates = async (code, model) => {
  const count = await model.count({ where: { code } });
  return count > 0;
};

// Handle socket connections
io.on("connection", (socket) => {
  const clientIp = socket.handshake.address;
  logger.info(`New client connected from IP: ${clientIp}`);

  // Initial counts fetch from Redis
  const fetchCounts = async () => {
    try {
      const [totalGtsTickets, totalKids, totalCheckIns] = await redis.mget(
        "total_gts_tickets",
        "total_kids",
        "total_check_ins"
      );
      socket.emit("update-counts", {
        totalGtsTickets: parseInt(totalGtsTickets) || 0,
        totalKids: parseInt(totalKids) || 0,
        totalCheckIns: parseInt(totalCheckIns) || 0,
      });
    } catch (error) {
      logger.error(`Error fetching counts: ${error.message}`);
      socket.emit("error", { message: "Failed to fetch initial counts" });
    }
  };

  fetchCounts();

  socket.on("sync-data", async (data) => {
    logger.info(`Received sync-data event with data: ${JSON.stringify(data)}`);
    try {
      const checkIn = await db.sequelize.transaction(async (t) => {
        const newCheckIn = await db.admission_check_ins.create(
          {
            number_of_kids: data.numberOfKids,
            kidzo_checked: data.kidZoChecked,
            timestamp: new Date(data.timestamp),
          },
          { transaction: t }
        );

        const gtsTickets = await Promise.all(
          data.gtsTickets.map(async (ticket) => {
            const isDuplicate = await checkForDuplicates(
              ticket.code,
              db.admission_gts_tickets
            );
            return {
              ...ticket,
              check_in_id: newCheckIn.transaction_id,
              duplicate: isDuplicate,
            };
          })
        );

        const bracelets = await Promise.all(
          data.bracelets.map(async (bracelet) => {
            const isDuplicate = await checkForDuplicates(
              bracelet.code,
              db.admission_bracelets
            );
            return {
              ...bracelet,
              check_in_id: newCheckIn.transaction_id,
              duplicate: isDuplicate,
            };
          })
        );

        await db.admission_gts_tickets.bulkCreate(gtsTickets, {
          transaction: t,
        });
        await db.admission_bracelets.bulkCreate(bracelets, {
          transaction: t,
        });

        return newCheckIn;
      });

      // Increment counts in Redis
      await incrementCounts(data.numberOfKids, data.gtsTickets.length);

      io.emit("data-synced", checkIn);
      socket.emit("check-in-response", { success: true, checkIn });
      logger.info(
        `Data synced for transaction: ${checkIn.transaction_id} from IP: ${clientIp}`
      );
    } catch (error) {
      logger.error(`Error inserting data: ${error.message}`, {
        stack: error.stack,
        data: JSON.stringify(data),
      });
      socket.emit("check-in-response", {
        success: false,
        error: "Failed to sync data",
        details: error.message,
      });
    }
  });

  socket.on("check-in", async (data, callback) => {
    logger.info(`Received check-in event with data: ${JSON.stringify(data)}`);
    try {
      const checkIn = await db.sequelize.transaction(async (t) => {
        const newCheckIn = await db.admission_check_ins.create(
          {
            number_of_kids: data.numberOfKids,
            kidzo_checked: data.kidZoChecked,
            timestamp: new Date(data.timestamp),
          },
          { transaction: t }
        );

        const gtsTickets = await Promise.all(
          data.gtsTickets.map(async (ticket) => {
            const isDuplicate = await checkForDuplicates(
              ticket.code,
              db.admission_gts_tickets
            );
            return {
              ...ticket,
              check_in_id: newCheckIn.transaction_id,
              duplicate: isDuplicate,
            };
          })
        );

        const bracelets = await Promise.all(
          data.bracelets.map(async (bracelet) => {
            const isDuplicate = await checkForDuplicates(
              bracelet.code,
              db.admission_bracelets
            );
            return {
              ...bracelet,
              check_in_id: newCheckIn.transaction_id,
              duplicate: isDuplicate,
            };
          })
        );

        await db.admission_gts_tickets.bulkCreate(gtsTickets, {
          transaction: t,
        });
        await db.admission_bracelets.bulkCreate(bracelets, {
          transaction: t,
        });

        return newCheckIn;
      });

      await incrementCounts(data.numberOfKids, data.gtsTickets.length);

      callback({ success: true, checkIn });
      logger.info(
        `Check-in successful for transaction: ${checkIn.transaction_id} from IP: ${clientIp}`
      );
    } catch (error) {
      logger.error(`Check-in error: ${error.message}`, {
        stack: error.stack,
        data: JSON.stringify(data),
      });
      callback({
        success: false,
        error: "Check-in failed",
        details: error.message,
      });
    }
  });

  socket.on("check-duplicate", async (data, callback) => {
    try {
      const isGtsDuplicate = await checkForDuplicates(
        data.code,
        db.admission_gts_tickets
      );
      const isBraceletDuplicate = await checkForDuplicates(
        data.code,
        db.admission_bracelets
      );
      callback({ isGtsDuplicate, isBraceletDuplicate });
    } catch (error) {
      logger.error(`Error checking duplicate: ${error.message}`);
      callback({ isGtsDuplicate: false, isBraceletDuplicate: false });
    }
  });

  socket.on("disconnect", () => {
    logger.info(`Client disconnected from IP: ${clientIp}`);
  });
});

app.use(express.json());
app.use("/api", activityRoutes);

// New routes for activity sessions
app.post("/api/est-activity-sessions", async (req, res) => {
  try {
    const sessionData = req.body;
    // Ensure activity_name is provided instead of activity_id
    if (!sessionData.activity_name) {
      return res.status(400).json({ error: "Activity name is required" });
    }
    const newSession = await db.activity_sessions.create(sessionData);
    res.status(201).json({
      sessionId: newSession.id,
      message: "Activity session started successfully",
    });
  } catch (error) {
    logger.error("Error starting activity session:", error);
    res.status(500).json({ error: "Failed to start activity session" });
  }
});

app.put("/api/activity-sessions/:sessionId", async (req, res) => {
  try {
    const { sessionId } = req.params;
    const updateData = req.body;
    const session = await db.activity_sessions.findByPk(sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    await session.update(updateData);
    res.status(200).json({ message: "Activity session updated successfully" });
  } catch (error) {
    logger.error("Error updating activity session:", error);
    res.status(500).json({ error: "Failed to update activity session" });
  }
});

app.post("/api/sync-offline", async (req, res) => {
  try {
    const offlineData = req.body;
    for (const item of offlineData) {
      if (item.action === "start") {
        // Ensure activity_name is used instead of activity_id
        if (!item.data.activity_name) {
          logger.warn(
            "Skipping offline session start due to missing activity name"
          );
          continue;
        }
        await db.activity_sessions.create(item.data);
      } else if (item.action === "stop") {
        const session = await db.activity_sessions.findByPk(item.sessionId);
        if (session) {
          await session.update(item.data);
        }
      }
    }
    res.status(200).json({ message: "Offline data synced successfully" });
  } catch (error) {
    logger.error("Error syncing offline data:", error);
    res.status(500).json({ error: "Failed to sync offline data" });
  }
});

app.get("/api/checkins", async (req, res) => {
  try {
    const checkIns = await db.admission_check_ins.findAll({
      include: [
        { model: db.admission_gts_tickets },
        { model: db.admission_bracelets },
      ],
      order: [["timestamp", "DESC"]],
      where: {
        deleted_at: {
          [Op.is]: null,
        },
      },
      limit: 100,
    });
    res.json(
      checkIns.map((checkIn) => ({
        transaction_id: checkIn.transaction_id,
        timestamp: checkIn.timestamp,
        number_of_kids: checkIn.number_of_kids,
        kidzo_checked: checkIn.kidzo_checked,
        gtsTickets: checkIn.admission_gts_tickets,
        bracelets: checkIn.admission_bracelets,
      }))
    );
    logger.info(`Fetched previous check-ins from IP: ${req.ip}`);
  } catch (error) {
    logger.error(`Failed to fetch check-ins: ${error.message}`, {
      stack: error.stack,
    });
    res.status(500).json({ error: "Failed to fetch check-ins" });
  }
});

// API to reset counts, protected by API key
app.post("/api/reset-counts", checkApiKey, async (req, res) => {
  try {
    await redis.mset({
      total_gts_tickets: 0,
      total_kids: 0,
      total_check_ins: 0,
    });
    logger.info("Counts reset via API");
    io.emit("update-counts", {
      totalGtsTickets: 0,
      totalKids: 0,
      totalCheckIns: 0,
    });
    res.status(200).json({ message: "Counts reset successfully" });
  } catch (error) {
    logger.error(`Failed to reset counts: ${error.message}`);
    res.status(500).json({ error: "Failed to reset counts" });
  }
});

app.get("/api/est-configs", async (req, res) => {
  try {
    const configs = await db.FIBConfig.findAll();
    const transformedConfigs = configs.map((config) => transformConfig(config));
    res.json(transformedConfigs);
  } catch (error) {
    logger.error("Error fetching all est-configs:", {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Utility function to transform config data
const transformConfig = (configData) => {
  // If configData is from the database, it might have a 'config' property
  const data = configData.config || configData;

  return {
    hostname: data.hostname,
    establishment_id: data.establishment_id,
    name: data.name,
    enable: data.enable,
    logo_only: data.logo_only,
    internal_remarks: data.internal_remarks,
    visitors: data.visitors,
    suggested_age: data.suggested_age,
    duration: data.duration,
    economy: data.economy,
    activities: data.activities,
    displayed_activity_name: data.displayed_activity_name,
    displayed_description: data.displayed_description,
  };
};

// Function to reset counts
const resetCounts = async () => {
  try {
    await redis.mset({
      total_gts_tickets: 0,
      total_kids: 0,
      total_check_ins: 0,
    });
    logger.info("Counts reset in Redis");
    io.emit("update-counts", {
      totalGtsTickets: 0,
      totalKids: 0,
      totalCheckIns: 0,
    });
    await logCurrentCounts(); // Log counts after reset
  } catch (error) {
    logger.error(`Failed to reset counts: ${error.message}`);
  }
};

// Function to schedule the next reset
const scheduleNextReset = () => {
  const now = moment();
  logger.info(`Current time: ${now.format()}`);

  const resetTimes = [
    moment(now).startOf("day"), // 00:00
    // moment(now).startOf("day").add(14, "hours"), // 14:00
  ];

  resetTimes.forEach((time, index) => {
    logger.info(`Reset time ${index + 1}: ${time.format()}`);
  });

  let nextReset = resetTimes.find((time) => time.isAfter(now));
  if (!nextReset) {
    nextReset = moment(resetTimes[0]).add(1, "day");
  }

  const msUntilNextReset = nextReset.diff(now);

  logger.info(
    `Next reset scheduled for ${nextReset.format()} (in ${
      msUntilNextReset / 1000 / 60
    } minutes)`
  );

  setTimeout(() => {
    logger.info(`Executing scheduled reset at ${moment().format()}`);
    resetCounts()
      .then(() => {
        scheduleNextReset();
      })
      .catch((error) => {
        logger.error(`Error during scheduled reset: ${error.message}`);
        scheduleNextReset(); // Reschedule even if there's an error
      });
  }, msUntilNextReset);
};

// Start the scheduling process
const startScheduling = () => {
  logger.info("Starting scheduling process");
  scheduleNextReset();

  // Immediate check
  const now = moment();
  const resetTimes = [
    moment(now).startOf("day"), // 00:00
    moment(now).startOf("day").add(1, "hours").add(30, "minutes"), // 01:30
    moment(now).startOf("day").add(9, "hours").add(30, "minutes"), // 09:30
    moment(now).startOf("day").add(14, "hours"), // 14:00
  ];

  const immediateReset = resetTimes.find((time) => time.isSame(now, "minute"));
  if (immediateReset) {
    logger.info("Executing immediate reset");
    resetCounts();
  }
};

// Add this to log counts every hour for debugging
setInterval(logCurrentCounts, 60 * 60 * 1000);

app.get("/", (req, res) => {
  res.send("Server is running");
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK", timestamp: new Date().toISOString() });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`, {
    name: err.name,
    stack: err.stack,
  });
  res.status(500).json({ error: "Internal server error" });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM signal received. Closing HTTP server.");
  server.close(() => {
    logger.info("HTTP server closed.");
    // Close database connection
    db.sequelize.close().then(() => {
      logger.info("Database connection closed.");
      process.exit(0);
    });
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
  startScheduling(); // Start the scheduling process after the server starts
});
