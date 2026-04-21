const WebSocket = require('ws');
const http = require('http');
const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    if (req.url === '/status') {
        const info = { status: 'OK', activeRooms: Object.keys(rooms).length, clients: wss.clients.size };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(info));
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('DartMatch Signaling Server OK\n');
    }
});

const wss = new WebSocket.Server({ server });

// rooms[code] = {
//   host: ws | null,
//   guest: ws | null,
//   hostDisconnectedAt: timestamp | null,   // pour le délai de grâce
//   guestDisconnectedAt: timestamp | null,
//   gameState: jsonString | null            // dernier état de jeu connu
// }
const rooms = {};
const clientRoom = new Map();
const clientRole = new Map();

// Délai de grâce : 5 minutes (300 000 ms)
// Pendant ce délai, la room est conservée même si un joueur se déconnecte.
const GRACE_PERIOD_MS = 5 * 60 * 1000;

const log = m => console.log(`[${new Date().toISOString()}] ${m}`);
const send = (ws, d) => ws && ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(d));

// Nettoyer les rooms expirées périodiquement
setInterval(() => {
    const now = Date.now();
    for (const [code, room] of Object.entries(rooms)) {
        const hostGone  = !room.host  || room.host.readyState !== WebSocket.OPEN;
        const guestGone = !room.guest || room.guest.readyState !== WebSocket.OPEN;

        if (hostGone && guestGone) {
            // Les deux sont déconnectés depuis trop longtemps ?
            const hostExpired  = room.hostDisconnectedAt  && (now - room.hostDisconnectedAt  > GRACE_PERIOD_MS);
            const guestExpired = room.guestDisconnectedAt && (now - room.guestDisconnectedAt > GRACE_PERIOD_MS);
            // Supprimer si les deux sont expirés (ou s'il n'y a jamais eu de guest)
            if (hostExpired && (guestExpired || !room.guestDisconnectedAt)) {
                delete rooms[code];
                log(`Room ${code} expired and deleted`);
            }
        }
    }
}, 60_000);

wss.on('connection', ws => {
    log('New connection');

    ws.on('message', raw => {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        switch (msg.type) {

            case 'create_room': {
                const code = msg.roomCode;
                if (!code) return send(ws, { type: 'error', message: 'No room code' });

                if (rooms[code]) {
                    const room = rooms[code];
                    // ── RECONNEXION HÔTE ──
                    // La room existe déjà : l'hôte se reconnecte (déco accidentelle)
                    const hostGone = !room.host || room.host.readyState !== WebSocket.OPEN;
                    if (hostGone) {
                        log(`Host reconnecting to room ${code}`);
                        // Nettoyer l'ancienne connexion hôte
                        if (room.host && room.host !== ws) {
                            try { room.host.terminate(); } catch {}
                        }
                        room.host = ws;
                        room.hostDisconnectedAt = null;
                        clientRoom.set(ws, code);
                        clientRole.set(ws, 'host');
                        send(ws, { type: 'room_created', roomCode: code, reconnected: true });
                        // Si l'invité est encore connecté, on les notifie mutuellement
                        if (room.guest && room.guest.readyState === WebSocket.OPEN) {
                            send(ws,       { type: 'peer_connected' });
                            send(room.guest, { type: 'peer_connected' });
                            // Renvoyer le dernier état de jeu à l'hôte
                            if (room.gameState) send(ws, { type: 'game_state', ...JSON.parse(room.gameState) });
                        }
                        return;
                    }
                    // La room existe et l'hôte est déjà connecté → conflit
                    // (ne devrait pas arriver, mais on remplace quand même)
                    if (room.guest) send(room.guest, { type: 'peer_disconnected' });
                    delete rooms[code];
                }

                // Nouvelle room
                rooms[code] = { host: ws, guest: null, hostDisconnectedAt: null, guestDisconnectedAt: null, gameState: null };
                clientRoom.set(ws, code);
                clientRole.set(ws, 'host');
                log(`Room CREATED: ${code}`);
                send(ws, { type: 'room_created', roomCode: code });
                break;
            }

            case 'join_room': {
                const code = msg.roomCode;
                if (!rooms[code]) return send(ws, { type: 'error', message: `Salle "${code}" introuvable. Demandez à l'hôte de recréer la salle.` });

                const room = rooms[code];
                // Vérifier si c'est l'hôte qui tente de rejoindre sa propre salle (reconnexion)
				const hostGone = !room.host || room.host.readyState !== WebSocket.OPEN;
				if (hostGone) {
					// L'hôte se reconnecte via join_room — on le redirige comme un create_room
					room.host = ws;
					room.hostDisconnectedAt = null;
					clientRoom.set(ws, code);
					clientRole.set(ws, 'host');
					send(ws, { type: 'room_created', roomCode: code, reconnected: true });
					if (room.guest && room.guest.readyState === WebSocket.OPEN) {
						send(ws, { type: 'peer_connected' });
						send(room.guest, { type: 'peer_connected' });
						if (room.gameState) send(ws, { type: 'game_state', ...JSON.parse(room.gameState) });
					}
					return;
				}
				const guestGone = !room.guest || room.guest.readyState !== WebSocket.OPEN;
				if (!guestGone && room.guest !== ws) {
					return send(ws, { type: 'error', message: 'Salle pleine' });
				}

                // Reconnexion ou nouvelle connexion guest
                const isReconnect = room.guestDisconnectedAt !== null;
                if (room.guest && room.guest !== ws) {
                    try { room.guest.terminate(); } catch {}
                }
                room.guest = ws;
                room.guestDisconnectedAt = null;
                clientRoom.set(ws, code);
                clientRole.set(ws, 'guest');
                log(`Guest ${isReconnect ? 'RE' : ''}joined room: ${code}`);
                send(ws, { type: 'room_joined', roomCode: code, reconnected: isReconnect });

                // Notifier l'hôte
                if (room.host && room.host.readyState === WebSocket.OPEN) {
                    send(room.host, { type: 'peer_connected' });
                    // L'hôte envoie son état de jeu actuel à l'invité qui revient
                    if (isReconnect && room.gameState) {
                        send(ws, { type: 'game_state', ...JSON.parse(room.gameState) });
                    }
                }
                break;
            }

            // ── WebRTC signaling relay ──────────────────────────────
            case 'offer':
            case 'answer':
            case 'ice_candidate': {
                const code = clientRoom.get(ws);
                if (!code || !rooms[code]) return;
                const peer = clientRole.get(ws) === 'host' ? rooms[code].guest : rooms[code].host;
                if (peer && peer.readyState === WebSocket.OPEN) send(peer, msg);
                break;
            }

            // ── Game state relay + sauvegarde ──────────────────────
            case 'game_state': {
                const code = clientRoom.get(ws);
                if (!code || !rooms[code]) return;
                // Sauvegarder l'état pour les reconnexions
                rooms[code].gameState = JSON.stringify(msg);
                const peer = clientRole.get(ws) === 'host' ? rooms[code].guest : rooms[code].host;
                if (peer && peer.readyState === WebSocket.OPEN) send(peer, msg);
                break;
            }
            case 'reaction': {
                const code = clientRoom.get(ws);
                if (!code || !rooms[code]) return;
                const peer = clientRole.get(ws) === 'host' ? rooms[code].guest : rooms[code].host;
                if (peer && peer.readyState === WebSocket.OPEN) send(peer, msg);
                break;
            }

            case 'reaction': {
                const code = clientRoom.get(ws);
                if (!code || !rooms[code]) return;
                const peer = clientRole.get(ws) === 'host' ? rooms[code].guest : rooms[code].host;
                if (peer && peer.readyState === WebSocket.OPEN) send(peer, msg);
                break;
            }

            case 'ping': send(ws, { type: 'pong' }); break;
        }
    });

    ws.on('close', () => {
        const code = clientRoom.get(ws);
        if (code && rooms[code]) {
            const role = clientRole.get(ws);
            const peer = role === 'host' ? rooms[code].guest : rooms[code].host;

            // Marquer la déconnexion avec timestamp (délai de grâce)
            if (role === 'host') {
                rooms[code].host = null;
                rooms[code].hostDisconnectedAt = Date.now();
                log(`Host disconnected from room ${code} — grace period started`);
            } else {
                rooms[code].guest = null;
                rooms[code].guestDisconnectedAt = Date.now();
                log(`Guest disconnected from room ${code} — grace period started`);
            }

            // Notifier le pair
            if (peer && peer.readyState === WebSocket.OPEN) {
                send(peer, { type: 'peer_disconnected' });
            }
        }
        clientRoom.delete(ws);
        clientRole.delete(ws);
    });

    ws.on('error', err => log(`WS error: ${err.message}`));
});

server.listen(PORT, () => {
    log(`DartMatch V9 server listening on port ${PORT}`);
    log(`Grace period for reconnection: ${GRACE_PERIOD_MS / 1000}s`);
});

setInterval(() => {
    log(`Heartbeat — ${wss.clients.size} clients, ${Object.keys(rooms).length} rooms`);
}, 60_000);
