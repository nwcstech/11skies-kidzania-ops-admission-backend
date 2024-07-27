const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('./models'); // Assuming you have Sequelize models set up

// Start a new session
router.post('/sessions', async (req, res) => {
  try {
    const { activityId } = req.body;
    const sessionId = uuidv4();
    const startTime = new Date();

    const session = await db.Session.create({
      sessionId,
      startTime,
      activityId
    });

    res.status(201).json(session);
  } catch (error) {
    console.error('Error starting session:', error);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// Stop a session
router.put('/sessions/:sessionId/stop', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const endTime = new Date();

    const session = await db.Session.findOne({ where: { sessionId } });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    session.endTime = endTime;
    session.duration = (endTime - session.startTime) / 60000; // Duration in minutes
    await session.save();

    res.json(session);
  } catch (error) {
    console.error('Error stopping session:', error);
    res.status(500).json({ error: 'Failed to stop session' });
  }
});

// Add scanned code to a session
router.post('/sessions/:sessionId/codes', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { code } = req.body;

    const session = await db.Session.findOne({ where: { sessionId } });
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const existingCode = await db.ScannedCode.findOne({
      where: { sessionId, code }
    });
    if (existingCode) {
      return res.status(400).json({ error: 'Duplicate guest ID' });
    }

    const newCode = await db.ScannedCode.create({
      sessionId,
      code,
      timestamp: new Date()
    });

    res.status(201).json(newCode);
  } catch (error) {
    console.error('Error adding scanned code:', error);
    res.status(500).json({ error: 'Failed to add scanned code' });
  }
});

// Delete scanned code from a session
router.delete('/sessions/:sessionId/codes/:codeId', async (req, res) => {
  try {
    const { sessionId, codeId } = req.params;

    const deletedCount = await db.ScannedCode.destroy({
      where: { id: codeId, sessionId }
    });

    if (deletedCount === 0) {
      return res.status(404).json({ error: 'Scanned code not found' });
    }

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting scanned code:', error);
    res.status(500).json({ error: 'Failed to delete scanned code' });
  }
});

// Get all scanned codes for a session
router.get('/sessions/:sessionId/codes', async (req, res) => {
  try {
    const { sessionId } = req.params;

    const codes = await db.ScannedCode.findAll({
      where: { sessionId },
      order: [['timestamp', 'ASC']]
    });

    res.json(codes);
  } catch (error) {
    console.error('Error fetching scanned codes:', error);
    res.status(500).json({ error: 'Failed to fetch scanned codes' });
  }
});

// Get past sessions
router.get('/sessions', async (req, res) => {
  try {
    const sessions = await db.Session.findAll({
      include: [
        { model: db.ScannedCode },
        { model: db.Activity }
      ],
      order: [['startTime', 'DESC']],
      limit: 100 // Limit the number of results
    });

    res.json(sessions);
  } catch (error) {
    console.error('Error fetching past sessions:', error);
    res.status(500).json({ error: 'Failed to fetch past sessions' });
  }
});

module.exports = router;