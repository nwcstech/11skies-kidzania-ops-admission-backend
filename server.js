const express = require("express");
const fs = require("fs");
const https = require("https");
const socketIo = require("socket.io");
const Redis = require("ioredis");
const cron = require("node-cron");
const morgan = require("morgan");
const winston = require("winston");
const db = require("./models");
require("dotenv").config();

// Set up Winston logger
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});

// HTTP request logging
const app = express();
app.use(
  morgan("combined", {
    stream: { write: (message) => logger.info(message.trim()) },
  })
);

// Test DB connection and sync
db.sequelize.authenticate().then(() => {
  logger.info('Database connected successfully');
  return db.sequelize.sync();
}).then(() => {
  logger.info("Database synchronized");
}).catch(error => {
  logger.error(`Database synchronization failed: ${error.message}`, { name: error.name, stack: error.stack });
  process.exit(1); // Exit if DB connection fails
});

// Create HTTPS server and socket.io instance
const httpsOptions = {
  key: fs.readFileSync('server.key'),
  cert: fs.readFileSync('server.cert')
};
const server = https.createServer(httpsOptions, app);
const io = socketIo(server);
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
});

// Function to increment counts in Redis
const incrementCounts = async (numberOfKids) => {
  await redis.incr("total_gts_tickets");
  await redis.incrby("total_kids", numberOfKids);
  await redis.incr("total_check_ins");
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
    const totalGtsTickets = await redis.get("total_gts_tickets");
    const totalKids = await redis.get("total_kids");
    const totalCheckIns = await redis.get("total_check_ins");

    socket.emit("update-counts", {
      totalGtsTickets: totalGtsTickets || 0,
      totalKids: totalKids || 0,
      totalCheckIns: totalCheckIns || 0,
    });
  };

  fetchCounts();

  socket.on("sync-data", async (data) => {
    try {
      if (data.type === "checkIn") {
        const checkIn = await db.CheckIn.create({
          number_of_kids: data.numberOfKids,
          kidzo_checked: data.kidZoChecked,
          timestamp: new Date(data.timestamp),
        });

        const gtsTickets = await Promise.all(
          data.gtsTickets.map(async (ticket) => {
            const isDuplicate = await checkForDuplicates(ticket.code, db.GtsTicket);
            return {
              ...ticket,
              check_in_id: checkIn.transaction_id,
              duplicate: isDuplicate,
            };
          })
        );

        const bracelets = await Promise.all(
          data.bracelets.map(async (bracelet) => {
            const isDuplicate = await checkForDuplicates(bracelet.code, db.Bracelet);
            return {
              ...bracelet,
              check_in_id: checkIn.transaction_id,
              duplicate: isDuplicate,
            };
          })
        );

        await db.GtsTicket.bulkCreate(gtsTickets);
        await db.Bracelet.bulkCreate(bracelets);

        // Increment counts in Redis
        await incrementCounts(data.numberOfKids);

        io.emit("data-synced", checkIn);
        logger.info(`Data synced for transaction: ${checkIn.transaction_id} from IP: ${clientIp}`);
      }
    } catch (error) {
      logger.error(`Error inserting data: ${error.message}`);
    }
  });

  socket.on("disconnect", () => {
    logger.info(`Client disconnected from IP: ${clientIp}`);
  });
});

app.use(express.json());

app.get("/api/checkins", async (req, res) => {
  try {
    const checkIns = await db.CheckIn.findAll({
      include: [{ model: db.GtsTicket }, { model: db.Bracelet }],
      order: [["timestamp", "DESC"]],
      where: {
        deleted_at: {
          [Op.is]: null
        }
      }
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
    logger.error(`Failed to fetch check-ins: ${error.message}`);
    res.status(500).json({ error: "Failed to fetch check-ins" });
  }
});

// Schedule the job to run at midnight every day
cron.schedule("0 0 * * *", () => {
  resetCounts();
});

const resetCounts = async () => {
  await redis.set("total_gts_tickets", 0);
  await redis.set("total_kids", 0);
  await redis.set("total_check_ins", 0);
  logger.info("Counts reset in Redis");
};

app.get("/", (req, res) => {
  res.send("Server is running");
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => logger.info(`Server running on port ${PORT}`));
