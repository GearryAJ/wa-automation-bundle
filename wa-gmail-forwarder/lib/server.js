const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const http = require('http');
const jwt = require('jsonwebtoken');
const chatLog = require('./chat-log');
const fs = require('fs');
const path = require('path');

const DASHBOARD_DIST = path.join(__dirname, '..', '..', 'dashboard_v2', 'dist');

const JWT_SECRET = process.env.JWT_SECRET || 'dashboard-v2-super-secret-key-1234';
const ADMIN_USER = process.env.DASHBOARD_USERNAME || 'admin';
const ADMIN_PASS = process.env.DASHBOARD_PASSWORD || 'itsmnac2026';

let io;
let sendMessageCb;

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (token == null) return res.sendStatus(401);
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

function initServer(port, sendMsgFn) {
  sendMessageCb = sendMsgFn;
  const app = express();
  app.use(cors());
  app.use(express.json());

  const server = http.createServer(app);
  io = new Server(server, {
    cors: { origin: '*' }
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication error'));
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (err) return next(new Error('Authentication error'));
      socket.user = decoded;
      next();
    });
  });

  io.on('connection', (socket) => {
    console.log(`[API] Web client connected: ${socket.id}`);
    socket.on('disconnect', () => {
      console.log(`[API] Web client disconnected: ${socket.id}`);
    });
  });

  // REST API Routes
  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USER && password === ADMIN_PASS) {
      const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '24h' });
      res.json({ token, user: { username } });
    } else {
      res.status(401).json({ error: 'Invalid credentials' });
    }
  });

  app.get('/api/status', authenticateToken, (req, res) => {
    res.json({ status: global.waStatus || 'disconnected' });
  });

  app.get('/api/chats', authenticateToken, (req, res) => {
    try {
      const chats = chatLog.listChats().map(c => ({
        jid: c.jid,
        chatName: c.name,
        lastUpdated: c.lastTs,
        count: c.count,
      }));
      res.json(chats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/chats/:jid/messages', authenticateToken, (req, res) => {
    try {
      const jid = req.params.jid;
      const file = path.join(process.env.CHAT_LOG_DIR || 'logs', chatLog.jidToFilename(jid));
      if (!fs.existsSync(file)) return res.json([]);
      
      const messages = fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try { return JSON.parse(line); } catch (e) { return null; }
        })
        .filter(Boolean);
        
      res.json(messages);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  
  app.get('/api/chats/:jid/tickets', authenticateToken, (req, res) => {
    try {
      const jid = req.params.jid;
      const file = path.join(process.env.TICKET_DIR || 'tickets', chatLog.jidToFilename(jid).replace('.jsonl', '_tickets.json'));
      if (!fs.existsSync(file)) return res.json({ tickets: [] });
      const tickets = JSON.parse(fs.readFileSync(file, 'utf8'));
      res.json(tickets);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/chats/:jid/send', authenticateToken, async (req, res) => {
    try {
      const { jid } = req.params;
      const { text } = req.body;
      if (!text) return res.status(400).json({ error: 'Text is required' });
      
      if (!sendMessageCb) {
        return res.status(500).json({ error: 'WhatsApp socket not available' });
      }

      await sendMessageCb(jid, { text });
      
      // Note: appending to log is handled by index.js after sending, or we can do it there.
      // In index.js we need to ensure outbound messages from API are also logged.
      // Wait, index.js doesn't log outbound API calls automatically. We should log it here.
      const entry = {
        jid,
        sender: 'operator',
        senderName: process.env.OPERATOR_LABEL || 'ITSM NAC BNI',
        fromMe: true,
        text,
        type: 'text',
        timestamp: Math.floor(Date.now() / 1000)
      };
      
      chatLog.appendMessage(entry);
      emitMessageSent(entry);
      
      res.json({ success: true, message: entry });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Serve media files statically
  const PUBLIC_MEDIA = path.join(__dirname, '..', 'public', 'media');
  if (!fs.existsSync(PUBLIC_MEDIA)) {
    fs.mkdirSync(PUBLIC_MEDIA, { recursive: true });
  }
  app.use('/media', express.static(PUBLIC_MEDIA));

  // Serve React frontend static build
  if (fs.existsSync(DASHBOARD_DIST)) {
    app.use(express.static(DASHBOARD_DIST));
    app.get('/{*path}', (req, res) => {
      res.sendFile(path.join(DASHBOARD_DIST, 'index.html'));
    });
    console.log(`[API] Serving frontend from ${DASHBOARD_DIST}`);
  }

  server.listen(port, () => {
    console.log(`[API] Dashboard v2 Realtime Server running on port ${port}`);
  });
}

function emitMessageReceived(msg) {
  if (io) io.emit('message:received', msg);
}

function emitMessageSent(msg) {
  if (io) io.emit('message:sent', msg);
}

function emitStatusUpdate(statusData) {
  global.waStatus = statusData.status;
  if (io) io.emit('wa:status', statusData);
}

module.exports = {
  initServer,
  emitMessageReceived,
  emitMessageSent,
  emitStatusUpdate
};
