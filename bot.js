// =============================================================================
// 24/7 Minecraft AFK Bot — BotManager
// Evolved from Minecraft-AFK-Bot-main/bot.js (nuekkis)
// =============================================================================

const mineflayer = require('mineflayer');

// ---------------------------------------------------------------------------
// Movement actions the bot can perform (from original bot.js, extended)
// ---------------------------------------------------------------------------
const DEFAULT_ACTIONS = ['forward', 'backward', 'jump', 'sneak', 'idle'];
const VALID_ACTIONS = new Set(DEFAULT_ACTIONS);

// ---------------------------------------------------------------------------
// BotManager — wraps Mineflayer with reconnection, logging, and remote control
// ---------------------------------------------------------------------------
class BotManager {
  constructor(config = {}) {
    // Minecraft connection
    this.host = config.host || 'elema.aternos.me';
    this.port = parseInt(config.port, 10) || 25270;
    this.username = config.username || '24_7';
    this.auth = config.auth || 'offline';
    this.version = config.version || false;      // auto-detect
    this.viewDistance = parseInt(config.viewDistance, 10) || 1;

    // Reconnection (exponential backoff)
    this.reconnectMinDelay = parseInt(config.reconnectMinDelay, 10) || 5000;
    this.reconnectMaxDelay = parseInt(config.reconnectMaxDelay, 10) || 60000;
    this._reconnectDelay = this.reconnectMinDelay;
    this.reconnectAttempts = 0;

    // AFK movement
    this.afkMinInterval = parseInt(config.afkMinInterval, 10) || 1500;
    this.afkMaxInterval = parseInt(config.afkMaxInterval, 10) || 3000;

    // Configurable movement actions (comma-separated, e.g. "forward,backward,jump")
    if (config.afkActions) {
      const requested = config.afkActions.split(',').map(a => a.trim().toLowerCase()).filter(a => VALID_ACTIONS.has(a));
      this.actions = requested.length > 0 ? requested : DEFAULT_ACTIONS;
    } else {
      this.actions = DEFAULT_ACTIONS;
    }

    // State
    this.bot = null;
    this.state = 'stopped';  // stopped | connecting | online | reconnecting
    this.autoReconnect = true;
    this._movementTimer = null;
    this._reconnectTimer = null;
    this._isConnecting = false;
    this.manuallyStopped = false;
    this.lastError = null;

    // Timestamps
    this.lastConnected = null;
    this.lastDisconnected = null;
    this.connectedSince = null;

    // Logging (rolling buffer)
    this.logs = [];
    this.maxLogs = 200;
  }

  // -------------------------------------------------------------------------
  // Logging
  // -------------------------------------------------------------------------
  _log(message) {
    const now = new Date();
    const ts = now.toLocaleTimeString('en-GB', { hour12: false });
    const entry = { timestamp: now.toISOString(), time: ts, message };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    console.log(`[${ts}] ${message}`);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------
  start() {
    if (this.state === 'online' || this.state === 'connecting') {
      this._log('Bot is already running.');
      return;
    }
    this.autoReconnect = true;
    this.manuallyStopped = false;
    this.lastError = null;
    this.reconnectAttempts = 0;
    this._reconnectDelay = this.reconnectMinDelay;
    this._connect();
  }

  stop() {
    this.autoReconnect = false;
    this.manuallyStopped = true;
    this._clearTimers();
    if (this.bot) {
      this._log('Stopping bot...');
      this.state = 'stopped';
      this._destroyBot();
    } else {
      this.state = 'stopped';
      this._log('Bot stopped.');
    }
  }

  restart() {
    this._log('Restarting bot...');
    this.stop();
    // Small delay so the old socket fully closes
    setTimeout(() => this.start(), 1500);
  }

  getStatus() {
    let uptime = 0;
    if (this.connectedSince && this.state === 'online') {
      uptime = Math.floor((Date.now() - this.connectedSince) / 1000);
    }
    return {
      backend: 'online',
      bot: this.username,
      online: this.state === 'online',
      state: this.state,
      manuallyStopped: this.manuallyStopped,
      lastError: this.lastError,
      server: `${this.host}:${this.port}`,
      uptime,
      reconnectAttempts: this.reconnectAttempts,
      lastConnected: this.lastConnected,
      lastDisconnected: this.lastDisconnected,
    };
  }

  getLogs(count = 50) {
    return this.logs.slice(-count);
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------
  _connect() {
    if (this._isConnecting) {
      this._log('Connection attempt already in progress, skipping.');
      return;
    }
    this._isConnecting = true;

    // Clean up any previous instance
    this._destroyBot();

    this.state = this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting';
    this._log(`Connecting to ${this.host}:${this.port} as ${this.username}...`);

    try {
      this.bot = mineflayer.createBot({
        host: this.host,
        port: this.port,
        username: this.username,
        auth: this.auth,
        version: this.version,
        viewDistance: this.viewDistance,
        hideErrors: false,
      });

      this._bindEvents();
    } catch (err) {
      this._log(`Failed to create bot: ${err.message}`);
      this._isConnecting = false;
      this._scheduleReconnect();
    }
  }

  _bindEvents() {
    const bot = this.bot;
    if (!bot) return;

    bot.on('login', () => {
      this._log(`Logged in as ${this.username}.`);
    });

    bot.on('spawn', () => {
      this._isConnecting = false;
      this.state = 'online';
      this.lastConnected = new Date().toISOString();
      this.connectedSince = Date.now();
      this.reconnectAttempts = 0;
      this._reconnectDelay = this.reconnectMinDelay;
      this._log(`${this.username} spawned on the server.`);
      this._log('AFK movement started.');
      this._startMovementCycle();
    });

    bot.on('kicked', (reason) => {
      let reasonText;
      try {
        const parsed = JSON.parse(reason);
        reasonText = parsed.text || parsed.translate || reason;
      } catch {
        reasonText = reason;
      }
      this._log(`Kicked: ${reasonText}`);
    });

    bot.on('end', (reason) => {
      this._isConnecting = false;
      this._stopMovementCycle();
      this.lastDisconnected = new Date().toISOString();
      this.connectedSince = null;

      if (this.state !== 'stopped') {
        this.state = 'reconnecting';
        this._log(`Disconnected: ${reason || 'unknown reason'}`);
        this._scheduleReconnect();
      }
    });

    bot.on('error', (err) => {
      this._isConnecting = false;
      this.lastError = err.message;
      this._log(`Error: ${err.message}`);
      // The 'end' event will fire after error, which handles reconnection
    });
  }

  // -------------------------------------------------------------------------
  // Reconnection (exponential backoff)
  // -------------------------------------------------------------------------
  _scheduleReconnect() {
    if (!this.autoReconnect) return;

    this.reconnectAttempts++;
    const delay = Math.min(
      this._reconnectDelay + Math.floor(Math.random() * 1000),
      this.reconnectMaxDelay
    );
    this._log(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);

    // Increase delay for next attempt (exponential)
    this._reconnectDelay = Math.min(this._reconnectDelay * 2, this.reconnectMaxDelay);
  }

  // -------------------------------------------------------------------------
  // Bot cleanup
  // -------------------------------------------------------------------------
  _destroyBot() {
    if (this.bot) {
      try {
        this.bot.removeAllListeners();
        this.bot.end();
      } catch {
        // Ignore errors during cleanup
      }
      this.bot = null;
    }
    this._stopMovementCycle();
  }

  _clearTimers() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._stopMovementCycle();
  }

  // -------------------------------------------------------------------------
  // AFK Movement (evolved from original bot.js movement cycle)
  // -------------------------------------------------------------------------
  _startMovementCycle() {
    this._stopMovementCycle();
    this._doMovement();
  }

  _stopMovementCycle() {
    if (this._movementTimer) {
      clearTimeout(this._movementTimer);
      this._movementTimer = null;
    }
    // Clear all control states
    if (this.bot && this.bot.entity) {
      try {
        this.bot.setControlState('forward', false);
        this.bot.setControlState('back', false);
        this.bot.setControlState('jump', false);
        this.bot.setControlState('sneak', false);
      } catch {
        // Bot may already be disconnected
      }
    }
  }

  _doMovement() {
    if (!this.bot || !this.bot.entity || this.state !== 'online') return;

    // Clear previous control states (avoid getting stuck)
    try {
      this.bot.setControlState('forward', false);
      this.bot.setControlState('back', false);
      this.bot.setControlState('jump', false);
      this.bot.setControlState('sneak', false);
    } catch {
      return;
    }

    // Pick a random action from configured list
    const action = this.actions[Math.floor(Math.random() * this.actions.length)];

    try {
      switch (action) {
        case 'forward':
          this.bot.setControlState('forward', true);
          break;
        case 'backward':
          this.bot.setControlState('back', true);
          break;
        case 'jump':
          this.bot.setControlState('jump', true);
          setTimeout(() => {
            if (this.bot && this.bot.entity) {
              try { this.bot.setControlState('jump', false); } catch {}
            }
          }, 500);
          break;
        case 'sneak':
          this.bot.setControlState('sneak', true);
          break;
        case 'idle':
          // Do nothing — just stand still
          break;
      }
    } catch {
      // Bot may have disconnected mid-action
      return;
    }

    // Schedule next movement at a random interval
    const interval = this.afkMinInterval +
      Math.floor(Math.random() * (this.afkMaxInterval - this.afkMinInterval));
    this._movementTimer = setTimeout(() => this._doMovement(), interval);
  }
}

module.exports = BotManager;
