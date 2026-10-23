const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const users = {}; // { socketId: nickname }

io.on('connection', (socket) => {
    socket.on('join', (nickname) => {
        socket.nickname = nickname || 'Anónimo';
        users[socket.id] = socket.nickname;

        io.emit('system-message', `${socket.nickname} ha entrado al chat.`);
        io.emit('update-users', users);
    });

    socket.on('chat message', (data) => {
        if (socket.nickname) {
            io.emit('chat message', {
                user: socket.nickname,
                text: data.text,
                time: data.time
            });
        }
    });

    // Evento de baneo/kick de administrador
    fnKickUser = (targetId, adminName) => {
        if (users[targetId]) {
            const targetSocket = io.sockets.sockets.get(targetId);
            if (targetSocket) {
                targetSocket.emit('kicked', adminName);
                targetSocket.disconnect(true);
            }
        }
    };

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
        if (socket.nickname) {
            delete users[socket.id];
            io.emit('system-message', `${socket.nickname} ha salido del chat.`);
            io.emit('update-users', users);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
