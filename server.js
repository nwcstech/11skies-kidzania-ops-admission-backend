const express = require('express');
const fs = require('fs');
const https = require('https');
const socketIo = require('socket.io');
const Redis = require('ioredis');
const cron = require('node-cron');
const morgan = require('morgan');
const winston = require('winston');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Op } = require('sequelize');
const db = require('./models');
require('dotenv').config({ path: 'admission-env' }); // Load environment variables from admission-env
const cors = require('cors'); // Import cors
const checkApiKey = require('./middleware/checkApiKey'); // Import API key middleware

// Validate environment variables
const requiredEnvVars = [
  "POSTGRES_DB",
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_HOST",
  "REDIS_HOST",
  "REDIS_PORT",
  "NODE_ENV",
  "API_KEY", // Add API_KEY to required environment variables
];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

// Set up Winston logger
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

const app = express();

// Security middleware
app.use(helmet());

// Enable CORS for all routes
app.use(cors());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
});
app.use(limiter);

// HTTP request logging
app.use(morgan('combined', {
  stream: { write: (message) => logger.info(message.trim()) },
}));

// Test DB connection and sync
db.sequelize
  .authenticate()
  .then(() => {
    logger.info('Database connected successfully');
    return db.sequelize.sync();
  })
  .then(() => {
    logger.info('Database synchronized');
  })
  .catch((error) => {
    logger.error(`Database synchronization failed: ${error.message}`, {
      name: error.name,
      stack: error.stack,
    });
    process.exit(1);
  });

// Create HTTPS server and socket.io instance
const httpsOptions = { key: fs.readFileSync("server.key"), cert: fs.readFileSync("server.cert"), };

const server = https.createServer(httpsOptions, app);
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:4200", // Allow your Angular app's origin
    methods: ["GET", "POST"]
  }
});
const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
});

// Function to increment counts in Redis
const incrementCounts = async (numberOfKids, gtsTicketCount) => {
  const multi = redis.multi();
  multi.incrby('total_gts_tickets', gtsTicketCount);
  multi.incrby('total_kids', numberOfKids);
  multi.incr('total_check_ins');
  await multi.exec();
  // Emit updated counts to all connected clients
  const [totalGtsTickets, totalKids, totalCheckIns] = await redis.mget(
    'total_gts_tickets',
    'total_kids',
    'total_check_ins'
  );
  io.emit('update-counts', {
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
io.on('connection', (socket) => {
  const clientIp = socket.handshake.address;
  logger.info(`New client connected from IP: ${clientIp}`);

  // Initial counts fetch from Redis
  const fetchCounts = async () => {
    try {
      const [totalGtsTickets, totalKids, totalCheckIns] = await redis.mget(
        'total_gts_tickets',
        'total_kids',
        'total_check_ins'
      );
      socket.emit('update-counts', {
        totalGtsTickets: parseInt(totalGtsTickets) || 0,
        totalKids: parseInt(totalKids) || 0,
        totalCheckIns: parseInt(totalCheckIns) || 0,
      });
    } catch (error) {
      logger.error(`Error fetching counts: ${error.message}`);
      socket.emit('error', { message: 'Failed to fetch initial counts' });
    }
  };

  fetchCounts();

  socket.on('sync-data', async (data) => {
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

      io.emit('data-synced', checkIn);
      logger.info(
        `Data synced for transaction: ${checkIn.transaction_id} from IP: ${clientIp}`
      );
    } catch (error) {
      logger.error(`Error inserting data: ${error.message}`, {
        stack: error.stack,
      });
      socket.emit('sync-error', { message: 'Failed to sync data' });
    }
  });

  socket.on('check-duplicate', async (data, callback) => {
    try {
      const isGtsDuplicate = await checkForDuplicates(data.code, db.admission_gts_tickets);
      const isBraceletDuplicate = await checkForDuplicates(data.code, db.admission_bracelets);
      callback({ isGtsDuplicate, isBraceletDuplicate });
    } catch (error) {
      logger.error(`Error checking duplicate: ${error.message}`);
      callback({ isGtsDuplicate: false, isBraceletDuplicate: false });
    }
  });

  socket.on('disconnect', () => {
    logger.info(`Client disconnected from IP: ${clientIp}`);
  });
});

app.use(express.json());

app.get('/api/checkins', async (req, res) => {
  try {
    const checkIns = await db.admission_check_ins.findAll({
      include: [
        { model: db.admission_gts_tickets },
        { model: db.admission_bracelets },
      ],
      order: [['timestamp', 'DESC']],
      where: {
        deleted_at: {
          [Op.is]: null,
        },
      },
      limit: 100, // Limit the number of results
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
    res.status(500).json({ error: 'Failed to fetch check-ins' });
  }
});

// API to reset counts, protected by API key
app.post('/api/reset-counts', checkApiKey, async (req, res) => {
  try {
    await redis.mset({
      total_gts_tickets: 0,
      total_kids: 0,
      total_check_ins: 0,
    });
    logger.info('Counts reset via API');
    io.emit('update-counts', {
      totalGtsTickets: 0,
      totalKids: 0,
      totalCheckIns: 0,
    });
    res.status(200).json({ message: 'Counts reset successfully' });
  } catch (error) {
    logger.error(`Failed to reset counts: ${error.message}`);
    res.status(500).json({ error: 'Failed to reset counts' });
  }
});

// Schedule the job to run at midnight every day
cron.schedule('0 0 * * *', () => {
  resetCounts();
});

const resetCounts = async () => {
  try {
    await redis.mset({
      total_gts_tickets: 0,
      total_kids: 0,
      total_check_ins: 0,
    });
    logger.info('Counts reset in Redis');
  } catch (error) {
    logger.error(`Failed to reset counts: ${error.message}`);
  }
};

app.get('/', (req, res) => {
  res.send('Server is running');
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error(`Unhandled error: ${err.message}`, {
    name: err.name,
    stack: err.stack,
  });
  res.status(500).json({ error: 'Internal server error' });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM signal received. Closing HTTP server.');
  server.close(() => {
    logger.info('HTTP server closed.');
    // Close database connection
    db.sequelize.close().then(() => {
      logger.info('Database connection closed.');
      process.exit(0);
    });
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => logger.info(`Server running on port ${PORT}`));
