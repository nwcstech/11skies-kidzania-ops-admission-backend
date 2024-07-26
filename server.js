const fs = require('fs');
const https = require('https');
const express = require('express');
const socketIo = require('socket.io');
const Redis = require('ioredis');
const cron = require('node-cron');
const morgan = require('morgan');
const winston = require('winston');
const db = require('./models');
require('dotenv').config();

const app = express();

const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
});

// Set up Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'combined.log' }),
  ],
});

// HTTP request logging
app.use(
  morgan('combined', {
    stream: { write: (message) => logger.info(message.trim()) },
  })
);

db.sequelize.sync().then(() => {
  logger.info('Database synchronized');
});

// Function to increment counts in Redis
const incrementCounts = async (numberOfKids, numberOfGtsTickets) => {
  await redis.incrby('totalGtsTickets', numberOfGtsTickets);
  await redis.incrby('totalKids', numberOfKids);
  await redis.incr('totalCheckIns');
};

const checkForDuplicates = async (code, table) => {
  const count = await db[table].count({ where: { code } });
  return count > 0;
};

const server = https.createServer({
  key: fs.readFileSync('server.key'),
  cert: fs.readFileSync('server.cert')
}, app);

const io = socketIo(server);

io.on('connection', (socket) => {
  const clientIp = socket.handshake.address;
  logger.info(`New client connected from IP: ${clientIp}`);

  // Initial counts fetch from Redis
  const fetchCounts = async () => {
    const totalGtsTickets = await redis.get('totalGtsTickets');
    const totalKids = await redis.get('totalKids');
    const totalCheckIns = await redis.get('totalCheckIns');

    socket.emit('update-counts', {
      totalGtsTickets: totalGtsTickets || 0,
      totalKids: totalKids || 0,
      totalCheckIns: totalCheckIns || 0,
    });
  };

  fetchCounts();

  socket.on('sync-data', async (data) => {
    try {
      if (data.type === 'checkIn') {
        const checkIn = await db.CheckIn.create({
          number_of_kids: data.numberOfKids,
          kidzo_checked: data.kidZoChecked,
          timestamp: new Date(data.timestamp),
        });

        const gtsTickets = await Promise.all(
          data.gtsTickets.map(async (ticket) => {
            const isDuplicate = await checkForDuplicates(
              ticket.code,
              'GtsTicket'
            );
            return {
              ...ticket,
              check_in_id: checkIn.transaction_id,
              duplicate: isDuplicate,
            };
          })
        );
        const bracelets = await Promise.all(
          data.bracelets.map(async (bracelet) => {
            const isDuplicate = await checkForDuplicates(
              bracelet.code,
              'Bracelet'
            );
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
        await incrementCounts(data.numberOfKids, data.gtsTickets.length);

        io.emit('data-synced', checkIn);
        logger.info(
          `Data synced for transaction: ${checkIn.transaction_id} from IP: ${clientIp}`
        );
      }
    } catch (error) {
      logger.error(`Error inserting data: ${error.message}`);
    }
  });

  socket.on('disconnect', () => {
    logger.info(`Client disconnected from IP: ${clientIp}`);
  });
});

app.use(express.json());

app.get('/api/checkins', async (req, res) => {
  try {
    const checkIns = await db.CheckIn.findAll({
      include: [{ model: db.GtsTicket }, { model: db.Bracelet }],
      order: [['timestamp', 'DESC']],
    });
    res.json(
      checkIns.map((checkIn) => ({
        transaction_id: checkIn.transaction_id,
        timestamp: checkIn.timestamp,
        number_of_kids: checkIn.number_of_kids,
        kidzo_checked: checkIn.kidzo_checked,
        gtsTickets: checkIn.GtsTickets,
        bracelets: checkIn.Bracelets,
      }))
    );
    logger.info(`Fetched previous check-ins from IP: ${req.ip}`);
  } catch (error) {
    logger.error(`Failed to fetch check-ins: ${error.message}`);
    res.status(500).json({ error: 'Failed to fetch check-ins' });
  }
});

// Schedule the job to run at midnight every day
cron.schedule('0 0 * * *', () => {
  resetCounts();
});

const resetCounts = async () => {
  await redis.set('totalGtsTickets', 0);
  await redis.set('totalKids', 0);
  await redis.set('totalCheckIns', 0);
  logger.info('Counts reset in Redis');
};

app.get('/', (req, res) => {
  res.send('Server is running');
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => logger.info(`Server running on port ${PORT}`));
