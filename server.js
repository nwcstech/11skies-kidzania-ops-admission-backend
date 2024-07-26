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

const pub = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
});

const sub = new Redis({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
});

// Set up Winston logger
const logger = winston.createLogger({
  level: 'debug', // Set log level to debug for detailed logs
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
}).catch(error => {
  logger.error('Database synchronization failed:', error);
  process.exit(1); // Exit process if DB synchronization fails
});

const incrementCounts = async (numberOfKids, numberOfGtsTickets) => {
  try {
    logger.info(`Incrementing counts in Redis: numberOfKids=${numberOfKids}, numberOfGtsTickets=${numberOfGtsTickets}`);
    await redis.incrby('totalGtsTickets', numberOfGtsTickets);
    await redis.incrby('totalKids', numberOfKids);
    await redis.incr('totalCheckIns');
    logger.info('Counts incremented successfully in Redis');
  } catch (error) {
    logger.error('Error incrementing counts in Redis:', error);
  }
};

const checkForDuplicates = async (code, table) => {
  try {
    logger.info(`Checking for duplicates in table=${table} with code=${code}`);
    const count = await db[table].count({ where: { code } });
    logger.info(`Duplicate count for code=${code} in table=${table} is ${count}`);
    return count > 0;
  } catch (error) {
    logger.error(`Error checking for duplicates in ${table}:`, error);
    throw error;
  }
};

let server;
try {
  server = https.createServer({
    key: fs.readFileSync('server.key'),
    cert: fs.readFileSync('server.cert')
  }, app);
  logger.info('HTTPS server created successfully');
} catch (error) {
  logger.error('Failed to create HTTPS server:', error);
  process.exit(1); // Exit process if HTTPS server creation fails
}

const io = socketIo(server);

io.on('connection', (socket) => {
  const clientIp = socket.handshake.address;
  logger.info(`New client connected from IP: ${clientIp}`);

  const fetchCounts = async () => {
    try {
      logger.info('Fetching initial counts from Redis');
      const totalGtsTickets = await redis.get('totalGtsTickets');
      const totalKids = await redis.get('totalKids');
      const totalCheckIns = await redis.get('totalCheckIns');

      socket.emit('update-counts', {
        totalGtsTickets: totalGtsTickets || 0,
        totalKids: totalKids || 0,
        totalCheckIns: totalCheckIns || 0,
      });
      logger.info('Initial counts fetched and emitted to client');
    } catch (error) {
      logger.error('Error fetching counts from Redis:', error);
    }
  };

  fetchCounts();

  socket.on('sync-data', async (data) => {
    logger.info(`Received sync-data event with data: ${JSON.stringify(data)}`);
    try {
      if (data.type === 'checkIn') {
        logger.info('Processing checkIn data');
        const checkIn = await db.CheckIn.create({
          number_of_kids: data.numberOfKids,
          kidzo_checked: data.kidZoChecked,
          timestamp: new Date(data.timestamp),
        });
        logger.info(`CheckIn record created with transaction_id: ${checkIn.transaction_id}`);

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
        logger.info('GtsTickets processed successfully');

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
        logger.info('Bracelets processed successfully');

        await db.GtsTicket.bulkCreate(gtsTickets);
        await db.Bracelet.bulkCreate(bracelets);
        logger.info('GtsTickets and Bracelets inserted into the database successfully');

        await incrementCounts(data.numberOfKids, data.gtsTickets.length);

        io.emit('data-synced', checkIn);
        logger.info(
          `Data synced for transaction: ${checkIn.transaction_id} from IP: ${clientIp}`
        );

        pub.publish('checkInEvent', JSON.stringify({
          type: 'checkIn',
          transaction_id: checkIn.transaction_id,
          numberOfKids: data.numberOfKids,
          gtsTickets: data.gtsTickets,
          bracelets: data.bracelets
        }));
      }
    } catch (error) {
      logger.error(`Error processing sync-data: ${error.message}`);
    }
  });

  socket.on('disconnect', () => {
    logger.info(`Client disconnected from IP: ${clientIp}`);
  });
});

app.use(express.json());

app.get('/api/checkins', async (req, res) => {
  try {
    logger.info('Fetching check-in records from the database');
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
    logger.info('Check-in records fetched successfully');
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
  try {
    logger.info('Resetting counts in Redis');
    await redis.set('totalGtsTickets', 0);
    await redis.set('totalKids', 0);
    await redis.set('totalCheckIns', 0);
    logger.info('Counts reset successfully in Redis');
  } catch (error) {
    logger.error('Error resetting counts in Redis:', error);
  }
};

app.get('/', (req, res) => {
  res.send('Server is running');
  logger.info('Root endpoint accessed');
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
  logger.info('Health check endpoint accessed');
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => logger.info(`Server running on port ${PORT}`));

// Subscribe to Redis events
sub.subscribe('checkInEvent', (err, count) => {
  if (err) {
    logger.error('Failed to subscribe to Redis events:', err);
  } else {
    logger.info(`Subscribed to ${count} Redis channels.`);
  }
});

sub.on('message', (channel, message) => {
  logger.info(`Received message from channel ${channel}: ${message}`);
  const event = JSON.parse(message);
  if (event.type === 'checkIn') {
    logger.info(`Handling checkIn event: ${JSON.stringify(event)}`);
  }
});
