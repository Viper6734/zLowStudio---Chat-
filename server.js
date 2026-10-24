const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const AVAILABLE_COLORS = [
    '#ff4757', '#2ed573', '#1e90ff', '#ffa502', '#eccc68',
    '#ff6b81', '#70a1ff', '#7bed9f', '#ff7f50', '#a29bfe',
    '#fd79a8', '#00cec9', '#00b894', '#e84393', '#6c5ce7',
    '#fdcb6e', '#d63031', '#e17055', '#0026ca', '#fab1a0'
];

let colorIndex = 0;
const users = {}; // { socketId: { nickname, color, isFirst, status } }
const typingUsers = new Set();
let messageIdCounter = 0;

function getUniqueColor() {
    const color = AVAILABLE_COLORS[colorIndex % AVAILABLE_COLORS.length];
    colorIndex++;
    return color;
}

io.on('connection', (socket) => {
    socket.on('join', (nickname) => {
        socket.nickname = nickname || 'Anónimo';
        
        const isFirst = Object.keys(users).length === 0;
        socket.userColor = isFirst ? '#ffcc00' : getUniqueColor();

        users[socket.id] = {
            nickname: socket.nickname,
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

            io.emit('chat message', {
                id: msgId,
                senderId: socket.id,
                user: users[socket.id].nickname,
                color: users[socket.id].color,
                text: data.text,
                time: data.time,
                replyTo: data.replyTo || null
            });
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
        io.emit('message deleted', msgId);
    });

    socket.on('edit message', ({ msgId, newText }) => {
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
