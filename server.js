const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 10e6 // 10 MB para soportar imágenes y avatares
});

// Servir archivos estáticos resolviendo la ruta absoluta al directorio actual
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// CONFIGURACIÓN DE SEGURIDAD Y ENTORNO
// ============================================================
// #1 Clave de administración segura en servidor
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin1509';

// #3 Proxy de GIFs: No exponer claves de API por defecto en el código
const GIF_API_KEY = process.env.GIF_API_KEY || '';
const GIF_PROVIDER = (process.env.GIF_PROVIDER || 'klipy').toLowerCase();
const GIF_PAGE_SIZE = 24;
const GIF_CACHE_TTL = 5 * 60 * 1000;
const gifCache = new Map();

function isHttps(u) {
    return typeof u === 'string' && /^https:\/\//i.test(u);
}

// #6 Permitir solo imágenes base64 o dominios confiables de proveedores oficiales
function isAllowedImageUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    // Data URL de imágenes estándar (base64 hasta ~5 MB)
    if (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(url)) {
        return url.length <= 5500000;
    }
    // Dominios oficiales de GIFs autorizados
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return false;
        const host = parsed.hostname.toLowerCase();
        if (host === 'static.klipy.com' || host === 'giphy.com' || host.endsWith('.giphy.com')) {
            return true;
        }
    } catch (e) {
        return false;
    }
    return false;
}

// #7 Rate limiting básico en el servidor (máx 5 mensajes/segundo por socket)
const socketRateLimits = new Map();
function checkRateLimit(socketId, maxPerSec = 5) {
    const now = Date.now();
    let record = socketRateLimits.get(socketId);
    if (!record || now - record.resetTime > 1000) {
        record = { count: 1, resetTime: now };
        socketRateLimits.set(socketId, record);
        return true;
    }
    record.count++;
    return record.count <= maxPerSec;
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
    if (!GIF_API_KEY) {
        return res.status(503).json({ error: 'no-key', message: 'Configura GIF_API_KEY en las variables de entorno para habilitar GIFs.' });
    }
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
const recordingUsers = new Set();

function broadcastRecordingStatus() {
    const names = Array.from(recordingUsers)
        .map(id => users[id] ? users[id].nickname : null)
        .filter(Boolean);
    io.emit('recording update', names);
}

// #7 Límites de almacenamiento en memoria
const MAX_GLOBAL_MESSAGES = 200;
let messageIdCounter = 0;
const messagesStore = {};
const privateMessagesStore = {}; // roomId -> Array de mensajes

function getDmRoomId(uid1, uid2) {
    return [String(uid1), String(uid2)].sort().join('__');
}

function cleanName(n) { return String(n || '').replace(/[<>]/g, '').trim().slice(0, 24); }
function cleanBio(b) { return String(b || '').replace(/[<>]/g, '').trim().slice(0, 200); }
function cleanAvatar(a) {
    return (typeof a === 'string' && a.startsWith('data:image/') && a.length <= 400000) ? a : null;
}

// ============================================================
// AMIGOS & PERFILES (CON PERSISTENCIA ATÓMICA - #14)
// ============================================================
const FRIENDS_FILE = process.env.FRIENDS_FILE || path.join(__dirname, 'friends-data.json');
let profiles = {};
const friendsMap = {};
const requestsMap = {};

// #11 Soporte multi-pestaña para conexión de usuarios (uid -> Set de socket.id)
const userSocketsMap = new Map();

function addSocketForUid(uid, socketId) {
    if (!uid) return;
    if (!userSocketsMap.has(uid)) userSocketsMap.set(uid, new Set());
    userSocketsMap.get(uid).add(socketId);
}

function removeSocketForUid(uid, socketId) {
    if (!uid) return;
    if (userSocketsMap.has(uid)) {
        const set = userSocketsMap.get(uid);
        set.delete(socketId);
        if (set.size === 0) userSocketsMap.delete(uid);
    }
}

function isUidOnline(uid) {
    const set = userSocketsMap.get(uid);
    return !!(set && set.size > 0);
}

function emitToUid(uid, event, data) {
    const set = userSocketsMap.get(uid);
    if (set) {
        for (const sid of set) {
            io.to(sid).emit(event, data);
        }
    }
}

function uidFromToken(token) {
    return crypto.createHash('sha256').update('chat-uid:' + token).digest('hex').slice(0, 16);
}

function loadFriendsData() {
    if (!fs.existsSync(FRIENDS_FILE)) return;
    try {
        const raw = JSON.parse(fs.readFileSync(FRIENDS_FILE, 'utf8'));
        profiles = raw.profiles || {};
        Object.entries(raw.friends || {}).forEach(([k, v]) => { friendsMap[k] = new Set(v); });
        Object.entries(raw.requests || {}).forEach(([k, v]) => { requestsMap[k] = new Set(v); });
    } catch (e) {
        console.error('Error al cargar friends-data.json:', e.message);
        try {
            fs.copyFileSync(FRIENDS_FILE, FRIENDS_FILE + '.corrupt.' + Date.now());
        } catch (backupErr) {}
    }
}
loadFriendsData();

let saveTimer = null;
function saveFriendsData() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        const keep = new Set();
        const friends = {};
        const requests = {};
        Object.entries(friendsMap).forEach(([k, set]) => {
            if (set.size) { friends[k] = [...set]; keep.add(k); set.forEach(x => keep.add(x)); }
        });
        Object.entries(requestsMap).forEach(([k, set]) => {
            if (set.size) { requests[k] = [...set]; keep.add(k); set.forEach(x => keep.add(x)); }
        });
        const outProfiles = {};
        keep.forEach(id => {
            const p = profiles[id];
            if (p) outProfiles[id] = Object.assign({}, p, { avatar: (p.avatar && p.avatar.length <= 300000) ? p.avatar : null });
        });

        // #14 Escritura atómica mediante archivo temporal antes de renombrar
        const payload = JSON.stringify({ profiles: outProfiles, friends, requests });
        const tmpFile = FRIENDS_FILE + '.tmp.' + Date.now();
        fs.writeFile(tmpFile, payload, 'utf8', (err) => {
            if (err) {
                console.error('No se pudo guardar amigos (tmp):', err.message);
                return;
            }
            fs.rename(tmpFile, FRIENDS_FILE, (renameErr) => {
                if (renameErr) console.error('No se pudo renombrar archivo de amigos atómicamente:', renameErr.message);
            });
        });
    }, 600);
}

function hasRelations(id) {
    if (friendsMap[id] && friendsMap[id].size) return true;
    if (requestsMap[id] && requestsMap[id].size) return true;
    return Object.values(requestsMap).some(set => set.has(id));
}

function friendStatus(id) {
    const set = userSocketsMap.get(id);
    if (set && set.size > 0) {
        for (const sid of set) {
            const u = users[sid];
            if (u && u.status) return u.status;
        }
        return 'online';
    }
    return 'offline';
}

function friendEntry(id) {
    const p = profiles[id] || { nickname: 'Usuario' };
    const set = userSocketsMap.get(id);
    let src = p;
    if (set && set.size > 0) {
        const firstSid = set.values().next().value;
        if (users[firstSid]) src = users[firstSid];
    }
    return {
        uid: id,
        nickname: src.nickname || 'Usuario',
        avatar: src.avatar || null,
        color: src.color || '#888888',
        bio: src.bio || '',
        memberSince: src.memberSince || 0,
        lastSeen: p.lastSeen || 0,
        status: friendStatus(id)
    };
}

function buildFriendsState(id) {
    return {
        me: id,
        friends: [...(friendsMap[id] || [])].map(friendEntry),
        incoming: [...(requestsMap[id] || [])].map(f => {
            const e = friendEntry(f);
            return { uid: e.uid, nickname: e.nickname, avatar: e.avatar, color: e.color };
        }),
        outgoing: Object.keys(requestsMap).filter(to => requestsMap[to].has(id))
    };
}

function pushFriendsState(id) {
    emitToUid(id, 'friends state', buildFriendsState(id));
}

function notifyFriendsOf(id) {
    pushFriendsState(id);
    (friendsMap[id] || []).forEach(pushFriendsState);
}

function notifyUid(id, text) {
    emitToUid(id, 'friend notice', { text });
}

function acceptFriendship(me, other) {
    if (requestsMap[me]) requestsMap[me].delete(other);
    if (requestsMap[other]) requestsMap[other].delete(me);
    if (!friendsMap[me]) friendsMap[me] = new Set();
    if (!friendsMap[other]) friendsMap[other] = new Set();
    friendsMap[me].add(other);
    friendsMap[other].add(me);
    saveFriendsData();
    pushFriendsState(me);
    pushFriendsState(other);
    const myName = (profiles[me] && profiles[me].nickname) || 'Alguien';
    notifyUid(other, `${myName} aceptó tu solicitud de amistad`);
}

function syncProfileFromSocket(socketId) {
    const u = users[socketId];
    if (!u || !u.uid) return;
    profiles[u.uid] = {
        nickname: u.nickname,
        avatar: u.avatar,
        color: u.color,
        bio: u.bio,
        memberSince: u.memberSince,
        lastSeen: Date.now()
    };
    if (hasRelations(u.uid)) saveFriendsData();
    notifyFriendsOf(u.uid);
}

function getUniqueColor() {
    const color = AVAILABLE_COLORS[colorIndex % AVAILABLE_COLORS.length];
    colorIndex++;
    return color;
}

io.on('connection', (socket) => {
    socket.isAdmin = false;

    // #1 Autenticación de Administrador en el Servidor
    socket.on('admin login', (attemptPass, callback) => {
        const ok = typeof attemptPass === 'string' && attemptPass === ADMIN_PASSWORD;
        socket.isAdmin = ok;
        if (typeof callback === 'function') {
            callback({ success: ok, message: ok ? 'Autenticado como administrador' : 'Contraseña incorrecta' });
        }
        socket.emit('admin auth status', { isAdmin: ok });
    });

    socket.on('join', (userData) => {
        const nickname = (userData && userData.nickname) ? (cleanName(userData.nickname) || 'Anónimo') : 'Anónimo';
        const avatar = (userData && userData.avatar) ? cleanAvatar(userData.avatar) : null;
        const bio = (userData && userData.bio) ? cleanBio(userData.bio) : '';

        let token = (userData && typeof userData.token === 'string' && userData.token.length >= 8) ? userData.token : null;
        if (!token) {
            token = crypto.randomBytes(16).toString('hex');
        }
        const uid = uidFromToken(token);
        socket.uid = uid;

        // Informar al cliente de su sesión verificada
        socket.emit('session', { uid: uid });

        let memberSince = Number(userData && userData.memberSince);
        if (!isFinite(memberSince) || memberSince < 1577836800000 || memberSince > Date.now()) memberSince = Date.now();

        socket.nickname = nickname;
        const isFirst = Object.keys(users).length === 0;
        socket.userColor = isFirst ? '#ffcc00' : getUniqueColor();

        users[socket.id] = {
            nickname: socket.nickname,
            avatar: avatar,
            color: socket.userColor,
            isFirst: isFirst,
            status: 'online',
            bio: bio,
            memberSince: memberSince,
            connectedAt: Date.now(),
            uid: uid
        };

        // #11 Registrar socket en el mapa de sockets por UID
        addSocketForUid(uid, socket.id);
        syncProfileFromSocket(socket.id);

        io.emit('system-message', `${socket.nickname} ha entrado al chat.`);
        io.emit('update-users', users);
    });

    socket.on('friend request', (d) => {
        const me = socket.uid;
        const to = d && d.toUid;
        if (!me || typeof to !== 'string' || to === me || !profiles[to]) return;
        if (friendsMap[me] && friendsMap[me].has(to)) return;

        if (requestsMap[me] && requestsMap[me].has(to)) return acceptFriendship(me, to);

        if (!requestsMap[to]) requestsMap[to] = new Set();
        if (requestsMap[to].has(me) || requestsMap[to].size >= 50) return;
        requestsMap[to].add(me);

        saveFriendsData();
        pushFriendsState(me);
        pushFriendsState(to);
        const myName = (users[socket.id] && users[socket.id].nickname) || 'Alguien';
        notifyUid(to, `${myName} te envió una solicitud de amistad`);
    });

    socket.on('friend accept', (d) => {
        const me = socket.uid;
        const from = d && d.fromUid;
        if (!me || typeof from !== 'string') return;
        if (!requestsMap[me] || !requestsMap[me].has(from)) return;
        acceptFriendship(me, from);
    });

    socket.on('friend decline', (d) => {
        const me = socket.uid;
        const from = d && d.fromUid;
        if (!me || typeof from !== 'string' || !requestsMap[me]) return;
        requestsMap[me].delete(from);
        saveFriendsData();
        pushFriendsState(me);
        pushFriendsState(from);
    });

    socket.on('friend cancel', (d) => {
        const me = socket.uid;
        const to = d && d.toUid;
        if (!me || typeof to !== 'string' || !requestsMap[to]) return;
        requestsMap[to].delete(me);
        saveFriendsData();
        pushFriendsState(me);
        pushFriendsState(to);
    });

    socket.on('friend remove', (d) => {
        const me = socket.uid;
        const other = d && d.uid;
        if (!me || typeof other !== 'string') return;
        if (friendsMap[me]) friendsMap[me].delete(other);
        if (friendsMap[other]) friendsMap[other].delete(me);
        saveFriendsData();
        pushFriendsState(me);
        pushFriendsState(other);
    });

    socket.on('update profile', (p) => {
        const u = users[socket.id];
        if (!u || !p) return;

        const oldName = u.nickname;
        const newName = cleanName(p.nickname);
        if (newName) {
            u.nickname = newName;
            socket.nickname = newName;
        }
        if (p.avatar === null) {
            u.avatar = null;
        } else if (typeof p.avatar === 'string') {
            const a = cleanAvatar(p.avatar);
            if (a) u.avatar = a;
        }
        if (typeof p.bio === 'string') u.bio = cleanBio(p.bio);

        if (newName && newName !== oldName) {
            io.emit('system-message', `${oldName} ahora se llama ${newName}.`);
        }
        io.emit('update-users', users);
        syncProfileFromSocket(socket.id);
    });

    socket.on('change status', (status) => {
        if (users[socket.id]) {
            users[socket.id].status = status;
            io.emit('update-users', users);
            if (users[socket.id].uid) notifyFriendsOf(users[socket.id].uid);
        }
    });

    // --- MENSAJES PÚBLICOS ---
    socket.on('chat message', (data) => {
        if (!users[socket.id]) return;
        // #7 Rate limit
        if (!checkRateLimit(socket.id)) {
            return socket.emit('rate-limit-warning', 'Estás enviando mensajes demasiado rápido.');
        }

        messageIdCounter++;
        const msgId = 'msg_' + messageIdCounter + '_' + Date.now();
        
        typingUsers.delete(socket.id);
        broadcastTypingStatus();
        if (recordingUsers.delete(socket.id)) broadcastRecordingStatus();

        // #6 Validación de imagen
        let image = isAllowedImageUrl(data && data.image) ? data.image : null;

        let audio = (data && typeof data.audio === 'string' && data.audio.startsWith('data:audio/')) ? data.audio : null;

        let waveform = null;
        if (Array.isArray(data && data.waveform) && data.waveform.length > 0 && data.waveform.length <= 100) {
            waveform = data.waveform.map(n => Math.min(100, Math.max(0, Math.round(Number(n) || 0))));
        }
        let duration = Number(data && data.duration);
        duration = (isFinite(duration) && duration > 0 && duration < 3600) ? Math.round(duration * 10) / 10 : 0;

        // #7 Limitar tamaño de texto a 2000 caracteres
        const rawText = String((data && data.text) || '').slice(0, 2000);

        const msgData = {
            id: msgId,
            senderId: socket.id,
            senderUid: users[socket.id].uid || null,
            user: users[socket.id].nickname,
            avatar: users[socket.id].avatar,
            color: users[socket.id].color,
            text: rawText,
            image: image,
            audio: audio,
            waveform: audio ? waveform : null,
            duration: audio ? duration : 0,
            time: data.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            replyTo: (data && data.replyTo && typeof data.replyTo.user === 'string') ? {
                user: cleanName(data.replyTo.user),
                text: String(data.replyTo.text || '').slice(0, 500),
                color: String(data.replyTo.color || '#888888').slice(0, 20)
            } : null,
            reactions: {}
        };

        // #7 Purga de mensajes antiguos en memoria
        messagesStore[msgId] = msgData;
        const allKeys = Object.keys(messagesStore);
        if (allKeys.length > MAX_GLOBAL_MESSAGES) {
            const toDelete = allKeys.slice(0, allKeys.length - MAX_GLOBAL_MESSAGES);
            toDelete.forEach(k => delete messagesStore[k]);
        }

        io.emit('chat message', msgData);
    });

    // --- CHAT PRIVADO ---
    socket.on('get private history', ({ targetUid }) => {
        const me = socket.uid;
        if (!me || !targetUid) return;
        const roomId = getDmRoomId(me, targetUid);
        const history = privateMessagesStore[roomId] || [];
        socket.emit('private history', { targetUid, messages: history });
    });

    socket.on('private message', (data) => {
        const me = socket.uid;
        const toUid = data && data.targetUid;
        const u = users[socket.id];
        if (!me || !toUid || !u) return;

        // #7 Rate limit
        if (!checkRateLimit(socket.id)) {
            return socket.emit('rate-limit-warning', 'Estás enviando mensajes demasiado rápido.');
        }

        messageIdCounter++;
        const msgId = 'dm_' + messageIdCounter + '_' + Date.now();
        const roomId = getDmRoomId(me, toUid);

        // #6 Validación de imagen
        let image = isAllowedImageUrl(data && data.image) ? data.image : null;

        let audio = (data && typeof data.audio === 'string' && data.audio.startsWith('data:audio/')) ? data.audio : null;

        let waveform = null;
        if (Array.isArray(data && data.waveform) && data.waveform.length > 0 && data.waveform.length <= 100) {
            waveform = data.waveform.map(n => Math.min(100, Math.max(0, Math.round(Number(n) || 0))));
        }
        let duration = Number(data && data.duration);
        duration = (isFinite(duration) && duration > 0 && duration < 3600) ? Math.round(duration * 10) / 10 : 0;

        const rawText = String((data && data.text) || '').slice(0, 2000);

        const msgData = {
            id: msgId,
            senderId: socket.id,
            senderUid: me,
            targetUid: toUid,
            user: u.nickname,
            avatar: u.avatar,
            color: u.color,
            text: rawText,
            image: image,
            audio: audio,
            waveform: audio ? waveform : null,
            duration: audio ? duration : 0,
            time: data.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            replyTo: (data && data.replyTo && typeof data.replyTo.user === 'string') ? {
                user: cleanName(data.replyTo.user),
                text: String(data.replyTo.text || '').slice(0, 500),
                color: String(data.replyTo.color || '#888888').slice(0, 20)
            } : null,
            reactions: {}
        };

        if (!privateMessagesStore[roomId]) privateMessagesStore[roomId] = [];
        privateMessagesStore[roomId].push(msgData);
        if (privateMessagesStore[roomId].length > 150) privateMessagesStore[roomId].shift();

        // Enviar a todas las pestañas del emisor
        emitToUid(me, 'private message', msgData);

        // Enviar a todas las pestañas del destinatario
        emitToUid(toUid, 'private message', msgData);
    });

    socket.on('private typing', ({ targetUid, isTyping }) => {
        if (users[socket.id]) {
            emitToUid(targetUid, 'private typing update', {
                fromUid: socket.uid,
                fromName: users[socket.id].nickname,
                isTyping: !!isTyping
            });
        }
    });

    socket.on('private recording', ({ targetUid, isRecording }) => {
        if (users[socket.id]) {
            emitToUid(targetUid, 'private recording update', {
                fromUid: socket.uid,
                fromName: users[socket.id].nickname,
                isRecording: !!isRecording
            });
        }
    });

    socket.on('add private reaction', ({ targetUid, msgId, emoji }) => {
        const me = socket.uid;
        if (!me || !targetUid || !users[socket.id]) return;
        const roomId = getDmRoomId(me, targetUid);
        const list = privateMessagesStore[roomId] || [];
        const msg = list.find(m => m.id === msgId);
        if (!msg) return;

        if (!msg.reactions) msg.reactions = {};
        let alreadyReacted = false;

        Object.keys(msg.reactions).forEach(e => {
            msg.reactions[e] = msg.reactions[e].filter(item => {
                if (item.uid === me && e === emoji) {
                    alreadyReacted = true;
                    return false;
                }
                return item.uid !== me;
            });
            if (msg.reactions[e].length === 0) delete msg.reactions[e];
        });

        if (!alreadyReacted) {
            if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
            msg.reactions[emoji].push({
                id: socket.id,
                uid: me,
                nickname: users[socket.id].nickname,
                avatar: users[socket.id].avatar,
                color: users[socket.id].color
            });
        }

        const payloadMe = { targetUid, msgId, reactions: msg.reactions };
        const payloadOther = { targetUid: me, msgId, reactions: msg.reactions };
        emitToUid(me, 'update private reactions', payloadMe);
        emitToUid(targetUid, 'update private reactions', payloadOther);
    });

    // #10 Solo el autor puede borrar su propio mensaje privado
    socket.on('delete private message', ({ targetUid, msgId }) => {
        const me = socket.uid;
        if (!me || !targetUid) return;
        const roomId = getDmRoomId(me, targetUid);
        const list = privateMessagesStore[roomId] || [];
        const msg = list.find(m => m.id === msgId);
        if (!msg) return;

        if (msg.senderUid !== me) {
            return socket.emit('error notice', { message: 'Solo el autor puede eliminar este mensaje.' });
        }

        privateMessagesStore[roomId] = list.filter(m => m.id !== msgId);
        emitToUid(me, 'private message deleted', { targetUid, msgId });
        emitToUid(targetUid, 'private message deleted', { targetUid: me, msgId });
    });

    // #10 Solo el autor puede editar su propio mensaje privado
    socket.on('edit private message', ({ targetUid, msgId, newText }) => {
        const me = socket.uid;
        if (!me || !targetUid) return;
        const roomId = getDmRoomId(me, targetUid);
        const msg = (privateMessagesStore[roomId] || []).find(m => m.id === msgId);
        if (!msg) return;

        if (msg.senderUid !== me) {
            return socket.emit('error notice', { message: 'Solo el autor puede editar este mensaje.' });
        }

        msg.text = String(newText || '').slice(0, 2000);
        emitToUid(me, 'private message edited', { targetUid, msgId, newText: msg.text });
        emitToUid(targetUid, 'private message edited', { targetUid: me, msgId, newText: msg.text });
    });

    // --- REACCIONES PÚBLICAS (#12 Por UID permanente para evitar duplicados en recarga) ---
    socket.on('add reaction', ({ msgId, emoji }) => {
        const user = users[socket.id];
        const msg = messagesStore[msgId];
        const myUid = socket.uid;
        if (user && msg && myUid) {
            if (!msg.reactions) msg.reactions = {};

            let alreadyReacted = false;
            Object.keys(msg.reactions).forEach(e => {
                msg.reactions[e] = msg.reactions[e].filter(item => {
                    const itemUid = item.uid || item.id;
                    if (itemUid === myUid && e === emoji) {
                        alreadyReacted = true;
                        return false;
                    }
                    return itemUid !== myUid;
                });
                if (msg.reactions[e].length === 0) delete msg.reactions[e];
            });

            if (!alreadyReacted) {
                if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
                msg.reactions[emoji].push({
                    id: socket.id,
                    uid: myUid,
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
            if (isTyping) typingUsers.add(socket.id);
            else typingUsers.delete(socket.id);
            broadcastTypingStatus();
        }
    });

    function broadcastTypingStatus() {
        const names = Array.from(typingUsers)
            .map(id => users[id] ? users[id].nickname : null)
            .filter(Boolean);
        io.emit('typing update', names);
    }

    socket.on('recording', (isRecording) => {
        if (!users[socket.id]) return;
        if (isRecording) recordingUsers.add(socket.id);
        else recordingUsers.delete(socket.id);
        broadcastRecordingStatus();
    });

    // #1 Verificación en servidor: solo el autor o un admin verificado puede borrar
    socket.on('delete message', (msgId) => {
        const msg = messagesStore[msgId];
        if (!msg) return;
        const isOwner = (msg.senderUid && msg.senderUid === socket.uid) || msg.senderId === socket.id;
        if (!isOwner && !socket.isAdmin) {
            return socket.emit('error notice', { message: 'No tienes permiso para borrar este mensaje.' });
        }
        delete messagesStore[msgId];
        io.emit('message deleted', msgId);
    });

    // #1 Verificación en servidor: solo el autor o un admin verificado puede editar
    socket.on('edit message', ({ msgId, newText }) => {
        const msg = messagesStore[msgId];
        if (!msg) return;
        const isOwner = (msg.senderUid && msg.senderUid === socket.uid) || msg.senderId === socket.id;
        if (!isOwner && !socket.isAdmin) {
            return socket.emit('error notice', { message: 'No tienes permiso para editar este mensaje.' });
        }
        msg.text = String(newText || '').slice(0, 2000);
        io.emit('message edited', { msgId, newText: msg.text });
    });

    // #1 Verificación en servidor: solo administrador verificado puede modificar usuarios
    socket.on('admin update user', ({ targetId, newName, newColor }) => {
        if (!socket.isAdmin) {
            return socket.emit('error notice', { message: 'Se requiere rol de administrador.' });
        }
        if (users[targetId]) {
            if (newName && newName.trim() !== '') {
                users[targetId].nickname = cleanName(newName);
                const targetSocket = io.sockets.sockets.get(targetId);
                if (targetSocket) targetSocket.nickname = users[targetId].nickname;
            }
            if (newColor) {
                users[targetId].color = newColor;
                const targetSocket = io.sockets.sockets.get(targetId);
                if (targetSocket) targetSocket.userColor = newColor;
            }
            io.emit('update-users', users);
            syncProfileFromSocket(targetId);
        }
    });

    // #1 Verificación en servidor: solo administrador verificado puede expulsar
    socket.on('kick user', ({ targetId, adminName }) => {
        if (!socket.isAdmin) {
            return socket.emit('error notice', { message: 'Se requiere rol de administrador.' });
        }
        if (users[targetId]) {
            const targetSocket = io.sockets.sockets.get(targetId);
            if (targetSocket) {
                targetSocket.emit('kicked', adminName || 'Administrador');
                targetSocket.disconnect(true);
            }
        }
    });

    socket.on('disconnect', () => {
        if (users[socket.id]) {
            const name = users[socket.id].nickname;
            const leavingUid = users[socket.id].uid;
            
            typingUsers.delete(socket.id);
            broadcastTypingStatus();
            recordingUsers.delete(socket.id);
            broadcastRecordingStatus();
            socketRateLimits.delete(socket.id);

            delete users[socket.id];

            // #11 Desconectar del mapa multi-pestaña
            removeSocketForUid(leavingUid, socket.id);

            // Solo si no quedan otras pestañas abiertas de este UID, marcar como desconectado
            if (leavingUid && !isUidOnline(leavingUid)) {
                if (profiles[leavingUid]) profiles[leavingUid].lastSeen = Date.now();
                if (hasRelations(leavingUid)) saveFriendsData();
                notifyFriendsOf(leavingUid);
            }

            io.emit('system-message', `${name} ha salido del chat.`);
            io.emit('update-users', users);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
