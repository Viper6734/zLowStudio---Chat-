const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Paleta de colores variados (excluyendo tonos muy oscuros/negros y blancos/grises muy claros)
const AVAILABLE_COLORS = [
    '#ff4757', '#2ed573', '#1e90ff', '#ffa502', '#eccc68',
    '#ff6b81', '#70a1ff', '#7bed9f', '#ff7f50', '#a29bfe',
    '#fd79a8', '#00cec9', '#00b894', '#e84393', '#6c5ce7',
    '#fdcb6e', '#d63031', '#e17055', '#0026ca', '#fab1a0'
];

let colorIndex = 0;

// Estructura de usuarios: { socketId: { nickname: string, color: string } }
const users = {};

function getUniqueColor() {
    const color = AVAILABLE_COLORS[colorIndex % AVAILABLE_COLORS.length];
    colorIndex++;
    return color;
}

io.on('connection', (socket) => {
    socket.on('join', (nickname) => {
        socket.nickname = nickname || 'Anónimo';
        socket.userColor = getUniqueColor();

        users[socket.id] = {
            nickname: socket.nickname,
            color: socket.userColor
        };

        io.emit('system-message', `${socket.nickname} ha entrado al chat.`);
        io.emit('update-users', users);
    });

    socket.on('chat message', (data) => {
        if (users[socket.id]) {
            io.emit('chat message', {
                senderId: socket.id,
                user: users[socket.id].nickname,
                color: users[socket.id].color,
                text: data.text,
                time: data.time
            });
        }
    });

    // Edición por parte del Admin (Nombre o Color)
    socket.on('admin update user', ({ targetId, newName, newColor }) => {
        if (users[targetId]) {
            if (newName && newName.trim() !== '') {
                users[targetId].nickname = newName.trim();
                const targetSocket = io.sockets.sockets.get(targetId);
                if (targetSocket) {
                    targetSocket.nickname = newName.trim();
                }
            }
            if (newColor) {
                users[targetId].color = newColor;
                const targetSocket = io.sockets.sockets.get(targetId);
                if (targetSocket) {
                    targetSocket.userColor = newColor;
                }
            }
            io.emit('update-users', users);
        }
    });

    // Evento de baneo/kick
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
