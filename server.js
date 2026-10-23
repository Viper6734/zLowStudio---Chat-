const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Guardar usuarios conectados: { socketId: nickname }
const users = {};

io.on('connection', (socket) => {
    socket.on('join', (nickname) => {
        socket.nickname = nickname || 'Anónimo';
        users[socket.id] = socket.nickname;

        // Notificar que alguien se unió
        io.emit('system-message', `${socket.nickname} ha entrado al chat.`);
        
        // Enviar la lista actualizada de usuarios a todos
        io.emit('update-users', Object.values(users));
    });

    socket.on('chat message', (msg) => {
        if (socket.nickname) {
            io.emit('chat message', {
                user: socket.nickname,
                text: msg
            });
        }
    });

    socket.on('disconnect', () => {
        if (socket.nickname) {
            delete users[socket.id];
            io.emit('system-message', `${socket.nickname} ha salido del chat.`);
            // Actualizar lista al desconectarse
            io.emit('update-users', Object.values(users));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});
