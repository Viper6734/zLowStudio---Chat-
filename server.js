const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 10e6 // 10 MB para soportar imágenes y avatares
});

app.use(express.static('public'));

// ============================================================
// GIFs: proxy en el servidor para no exponer la API key en el navegador.
// La API de Tenor se apagó el 30/06/2026, por eso se usa Klipy (API casi
// idéntica a Tenor) o Giphy. Configura con variables de entorno:
//   GIF_API_KEY=tu_clave
//   GIF_PROVIDER=klipy   (o "giphy")
// ============================================================
const GIF_API_KEY = process.env.GIF_API_KEY || 'EqKveKya673SGDNK1vWqZlqCeczfAYPbRC3KDD9WDW8cVMQKPG6wTnMWcEoqOglk';
const GIF_PROVIDER = (process.env.GIF_PROVIDER || 'klipy').toLowerCase();
const GIF_PAGE_SIZE = 24;
const GIF_CACHE_TTL = 5 * 60 * 1000;
const gifCache = new Map();

function isHttps(u) {
    return typeof u === 'string' && /^https:\/\//i.test(u);
}

function normalizeKlipy(json) {
    const d = json && json.data;
    const list = d && Array.isArray(d.data) ? d.data : (Array.isArray(d) ? d : []);
    const items = list.map(g => {
        if (!g || g.type === 'ad' || g.kind === 'ad' || !g.file) return null;
        const f = g.file;
        const small = (f.sm || f.xs || f.md || f.hd || {}).gif;
        const medium = (f.md || f.sm || f.hd || f.xs || {}).gif;
        if (!small || !medium || !isHttps(small.url) || !isHttps(medium.url)) return null;
        return {
            id: String(g.slug || g.id),
            title: g.title || 'GIF',
            preview: small.url,
            url: medium.url,
            w: small.width || 0,
            h: small.height || 0
        };
    }).filter(Boolean);
    return { items, hasNext: !!(d && (d.has_next || d.hasNext)) };
}

function normalizeGiphy(json, offset) {
    const list = Array.isArray(json && json.data) ? json.data : [];
    const items = list.map(g => {
        const img = g && g.images;
        if (!img) return null;
        const small = img.fixed_height_small || img.fixed_height;
        const medium = img.fixed_height || img.original;
        if (!small || !medium || !isHttps(small.url) || !isHttps(medium.url)) return null;
        return {
            id: String(g.id),
            title: g.title || 'GIF',
            preview: small.url,
            url: medium.url,
            w: Number(small.width) || 0,
            h: Number(small.height) || 0
        };
    }).filter(Boolean);
    const p = json && json.pagination;
    const hasNext = !!(p && p.total_count > offset + (p.count || list.length));
    return { items, hasNext };
}

app.get('/api/gifs', async (req, res) => {
    if (!GIF_API_KEY) return res.status(503).json({ error: 'no-key' });
    if (typeof fetch !== 'function') return res.status(500).json({ error: 'node-too-old' });

    const q = String(req.query.q || '').trim().slice(0, 80);
    const page = Math.min(Math.max(parseInt(req.query.page, 10) || 1, 1), 50);
    const cid = /^[\w-]{1,64}$/.test(String(req.query.cid || '')) ? String(req.query.cid) : 'anon';

    const cacheKey = `${GIF_PROVIDER}|${q.toLowerCase()}|${page}`;
    const cached = gifCache.get(cacheKey);
    if (cached && Date.now() - cached.t < GIF_CACHE_TTL) return res.json(cached.data);

    let url;
    if (GIF_PROVIDER === 'giphy') {
        const params = new URLSearchParams({
            api_key: GIF_API_KEY,
            limit: GIF_PAGE_SIZE,
            offset: (page - 1) * GIF_PAGE_SIZE,
            rating: 'g'
        });
        if (q) params.set('q', q);
        url = `https://api.giphy.com/v1/gifs/${q ? 'search' : 'trending'}?${params}`;
    } else {
        const params = new URLSearchParams({ page, per_page: GIF_PAGE_SIZE, customer_id: cid });
        if (q) params.set('q', q);
        url = `https://api.klipy.com/api/v1/${encodeURIComponent(GIF_API_KEY)}/gifs/${q ? 'search' : 'trending'}?${params}`;
    }

    try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!resp.ok) return res.status(502).json({ error: 'provider-' + resp.status });
        const json = await resp.json();

        const parsed = GIF_PROVIDER === 'giphy'
            ? normalizeGiphy(json, (page - 1) * GIF_PAGE_SIZE)
            : normalizeKlipy(json);

        const data = { ...parsed, provider: GIF_PROVIDER === 'giphy' ? 'GIPHY' : 'KLIPY' };

        if (gifCache.size > 300) gifCache.clear();
        gifCache.set(cacheKey, { t: Date.now(), data });
        res.json(data);
    } catch (err) {
        res.status(502).json({ error: 'fetch-failed' });
    }
});

const AVAILABLE_COLORS = [
    '#ff4757', '#2ed573', '#1e90ff', '#ffa502', '#eccc68',
    '#ff6b81', '#70a1ff', '#7bed9f', '#ff7f50', '#a29bfe',
    '#fd79a8', '#00cec9', '#00b894', '#e84393', '#6c5ce7',
    '#fdcb6e', '#d63031', '#e17055', '#0026ca', '#fab1a0'
];

let colorIndex = 0;
const users = {}; 
const typingUsers = new Set();
let messageIdCounter = 0;
const messagesStore = {};

function getUniqueColor() {
    const color = AVAILABLE_COLORS[colorIndex % AVAILABLE_COLORS.length];
    colorIndex++;
    return color;
}

io.on('connection', (socket) => {
    socket.on('join', (userData) => {
        const nickname = (userData && userData.nickname) ? userData.nickname.trim() : 'Anónimo';
        const avatar = (userData && userData.avatar) ? userData.avatar : null;

        socket.nickname = nickname;
        
        const isFirst = Object.keys(users).length === 0;
        socket.userColor = isFirst ? '#ffcc00' : getUniqueColor();

        users[socket.id] = {
            nickname: socket.nickname,
            avatar: avatar,
            color: socket.userColor,
            isFirst: isFirst,
            status: 'online'
        };

        io.emit('system-message', `${socket.nickname} ha entrado al chat.`);
        io.emit('update-users', users);
    });

    socket.on('change status', (status) => {
        if (users[socket.id]) {
            users[socket.id].status = status;
            io.emit('update-users', users);
        }
    });

    socket.on('chat message', (data) => {
        if (users[socket.id]) {
            messageIdCounter++;
            const msgId = 'msg_' + messageIdCounter + '_' + Date.now();
            
            typingUsers.delete(socket.id);
            broadcastTypingStatus();

            let image = data.image || null;
            if (typeof image !== 'string' || !(image.startsWith('data:image/') || /^https:\/\//i.test(image))) {
                image = null;
            }

            let audio = data.audio || null;
            if (typeof audio !== 'string' || !audio.startsWith('data:audio/')) audio = null;

            let waveform = null;
            if (Array.isArray(data.waveform) && data.waveform.length > 0 && data.waveform.length <= 100) {
                waveform = data.waveform.map(n => Math.min(100, Math.max(0, Math.round(Number(n) || 0))));
            }
            let duration = Number(data.duration);
            duration = (isFinite(duration) && duration > 0 && duration < 3600) ? Math.round(duration * 10) / 10 : 0;

            const msgData = {
                id: msgId,
                senderId: socket.id,
                user: users[socket.id].nickname,
                avatar: users[socket.id].avatar,
                color: users[socket.id].color,
                text: data.text || '',
                image: image,
                audio: audio, // <--- SE AGREGÓ EL AUDIO
                waveform: audio ? waveform : null,
                duration: audio ? duration : 0,
                time: data.time,
                replyTo: data.replyTo || null,
                reactions: {}
            };

            messagesStore[msgId] = msgData;
            io.emit('chat message', msgData);
        }
    });

    socket.on('add reaction', ({ msgId, emoji }) => {
        const user = users[socket.id];
        const msg = messagesStore[msgId];
        if (user && msg) {
            if (!msg.reactions) msg.reactions = {};

            let alreadyReacted = false;
            Object.keys(msg.reactions).forEach(e => {
                msg.reactions[e] = msg.reactions[e].filter(item => {
                    if (item.id === socket.id && e === emoji) {
                        alreadyReacted = true;
                        return false;
                    }
                    if (item.id === socket.id) {
                        return false;
                    }
                    return true;
                });
                if (msg.reactions[e].length === 0) {
                    delete msg.reactions[e];
                }
            });

            if (!alreadyReacted) {
                if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
                msg.reactions[emoji].push({
                    id: socket.id,
                    nickname: user.nickname,
                    avatar: user.avatar,
                    color: user.color
                });
            }

            io.emit('update reactions', { msgId, reactions: msg.reactions });
        }
    });

    socket.on('typing', (isTyping) => {
        if (users[socket.id]) {
            if (isTyping) {
                typingUsers.add(socket.id);
            } else {
                typingUsers.delete(socket.id);
            }
            broadcastTypingStatus();
        }
    });

    function broadcastTypingStatus() {
        const names = Array.from(typingUsers)
            .map(id => users[id] ? users[id].nickname : null)
            .filter(Boolean);

        io.emit('typing update', names);
    }

    socket.on('delete message', (msgId) => {
        delete messagesStore[msgId];
        io.emit('message deleted', msgId);
    });

    socket.on('edit message', ({ msgId, newText }) => {
        if (messagesStore[msgId]) {
            messagesStore[msgId].text = newText;
        }
        io.emit('message edited', { msgId, newText });
    });

    socket.on('admin update user', ({ targetId, newName, newColor }) => {
        if (users[targetId]) {
            if (newName && newName.trim() !== '') {
                users[targetId].nickname = newName.trim();
                const targetSocket = io.sockets.sockets.get(targetId);
                if (targetSocket) targetSocket.nickname = newName.trim();
            }
            if (newColor) {
                users[targetId].color = newColor;
                const targetSocket = io.sockets.sockets.get(targetId);
                if (targetSocket) targetSocket.userColor = newColor;
            }
            io.emit('update-users', users);
        }
    });

    socket.on('kick user', ({ targetId, adminName }) => {
        if (users[targetId]) {
            const targetSocket = io.sockets.sockets.get(targetId);
            if (targetSocket) {
                targetSocket.emit('kicked', adminName);
                targetSocket.disconnect(true);
            }
        }
    });

    socket.on('disconnect', () => {
        if (users[socket.id]) {
            const name = users[socket.id].nickname;
            typingUsers.delete(socket.id);
            broadcastTypingStatus();

            delete users[socket.id];
            io.emit('system-message', `${name} ha salido del chat.`);
            io.emit('update-users', users);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
