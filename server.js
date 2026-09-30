// =============================================================================
// 24/7 Minecraft AFK Bot — API Server
// Express server providing secure REST API for bot control and monitoring
// =============================================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const BotManager = require('./bot');

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.BOT_API_PORT, 10) || 3000;
const API_TOKEN = process.env.BOT_API_TOKEN;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

if (!API_TOKEN) {
  console.error('❌ BOT_API_TOKEN is not set in .env — API will reject all authenticated requests.');
  console.error('   Create a .env file based on .env.example and set a strong token.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Initialize bot manager
// ---------------------------------------------------------------------------
const botManager = new BotManager({
  host: process.env.MINECRAFT_HOST,
  port: process.env.MINECRAFT_PORT,
  username: process.env.MINECRAFT_USERNAME,
  auth: process.env.MINECRAFT_AUTH,
  viewDistance: process.env.MINECRAFT_VIEW_DISTANCE,
  reconnectMinDelay: process.env.RECONNECT_MIN_DELAY,
  reconnectMaxDelay: process.env.RECONNECT_MAX_DELAY,
  afkMinInterval: process.env.AFK_MIN_INTERVAL,
  afkMaxInterval: process.env.AFK_MAX_INTERVAL,
  afkActions: process.env.AFK_ACTIONS,
});

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// JSON body parsing
app.use(express.json());

// CORS
app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------
const statusLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 60,                // 60 requests per minute for status/logs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

const controlLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 10,                // 10 control actions per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many control requests. Please wait.' },
});

// ---------------------------------------------------------------------------
// Authentication middleware
// ---------------------------------------------------------------------------
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header.' });
  }
  const token = authHeader.slice(7);
  if (token !== API_TOKEN) {
    return res.status(403).json({ error: 'Invalid API token.' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check — unauthenticated
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Bot status — authenticated
app.get('/api/status', statusLimiter, authenticate, (req, res) => {
  res.json(botManager.getStatus());
});

// Bot logs — authenticated
app.get('/api/logs', statusLimiter, authenticate, (req, res) => {
  const count = Math.min(parseInt(req.query.count, 10) || 50, 200);
  res.json({ logs: botManager.getLogs(count) });
});

// Start bot — authenticated
app.post('/api/start', controlLimiter, authenticate, (req, res) => {
  botManager.start();
  res.json({ success: true, message: 'Bot start initiated.' });
});

// Stop bot — authenticated
app.post('/api/stop', controlLimiter, authenticate, (req, res) => {
  botManager.stop();
  res.json({ success: true, message: 'Bot stopped.' });
});

// Restart bot — authenticated
app.post('/api/restart', controlLimiter, authenticate, (req, res) => {
  botManager.restart();
  res.json({ success: true, message: 'Bot restart initiated.' });
});

// ---------------------------------------------------------------------------
// 404 fallback
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// ---------------------------------------------------------------------------
// Start server and auto-start bot
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n🌐 API server listening on port ${PORT}`);
  console.log(`🔒 CORS origin: ${ALLOWED_ORIGIN}`);
  console.log(`📡 Health check: http://localhost:${PORT}/health\n`);

  // Auto-start the bot when the server starts
  botManager.start();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  botManager.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  botManager.stop();
  process.exit(0);
});
