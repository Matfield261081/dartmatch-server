const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('DartMatch Signaling Server OK\n');
});

const wss = new WebSocket.Server({ server });

// Rooms: roomCode -> { host: ws, guest: ws }
const rooms = {};
// Track which room each ws belongs to
const clientRoom = new Map();
const clientRole = new Map();

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

wss.on('connection', (ws) => {
  log('New connection');

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'create_room': {
        const code = msg.roomCode;
        if (!code) return send(ws, { type: 'error', message: 'No room code' });
        if (rooms[code]) return send(ws, { type: 'error', message: 'Room already exists' });
        rooms[code] = { host: ws, guest: null };
        clientRoom.set(ws, code);
        clientRole.set(ws, 'host');
        log(`Room created: ${code}`);
        send(ws, { type: 'room_created', roomCode: code });
        break;
      }

      case 'join_room': {
        const code = msg.roomCode;
        if (!rooms[code]) return send(ws, { type: 'error', message: 'Room not found' });
        if (rooms[code].guest) return send(ws, { type: 'error', message: 'Room full' });
        rooms[code].guest = ws;
        clientRoom.set(ws, code);
        clientRole.set(ws, 'guest');
        log(`Guest joined room: ${code}`);
        send(ws, { type: 'room_joined', roomCode: code });
        // Notify host
        send(rooms[code].host, { type: 'peer_connected' });
        break;
      }

      // WebRTC signaling relay
      case 'offer':
      case 'answer':
      case 'ice_candidate': {
        const code = clientRoom.get(ws);
        if (!code || !rooms[code]) return;
        const role = clientRole.get(ws);
        const peer = role === 'host' ? rooms[code].guest : rooms[code].host;
        send(peer, msg);
        break;
      }

      // Game state relay
      case 'game_state':
      case 'score_update':
      case 'game_action': {
        const code = clientRoom.get(ws);
        if (!code || !rooms[code]) return;
        const role = clientRole.get(ws);
        const peer = role === 'host' ? rooms[code].guest : rooms[code].host;
        send(peer, msg);
        break;
      }

      case 'ping':
        send(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    const code = clientRoom.get(ws);
    if (code && rooms[code]) {
      const role = clientRole.get(ws);
      const peer = role === 'host' ? rooms[code].guest : rooms[code].host;
      send(peer, { type: 'peer_disconnected' });
      if (role === 'host') {
        delete rooms[code];
        log(`Room ${code} closed (host left)`);
      } else {
        rooms[code].guest = null;
        log(`Guest left room ${code}`);
      }
    }
    clientRoom.delete(ws);
    clientRole.delete(ws);
    log('Connection closed');
  });

  ws.on('error', (err) => log(`WS error: ${err.message}`));
});

server.listen(PORT, () => log(`Server listening on port ${PORT}`));
