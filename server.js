const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const CHAT_NAME = "234";
let activeUsers = new Map();

io.on('connection', (socket) => {
  console.log('Un usuario se ha conectado:', socket.id);

  socket.on('join_chat', (nickname) => {
    const cleanNickname = nickname && nickname.trim() !== '' ? nickname.trim() : 'UsuarioAnonimo';
    activeUsers.set(socket.id, cleanNickname);

    socket.emit('chat_joined', {
      chatName: CHAT_NAME,
      nickname: cleanNickname
    });

    socket.broadcast.emit('user_event', {
      systemMessage: `${cleanNickname} ha entrado al chat.`
    });
  });

  socket.on('send_message', (message) => {
    const userNickname = activeUsers.get(socket.id);
    if (userNickname) {
      io.emit('new_message', {
        chatName: CHAT_NAME,
        nickname: userNickname,
        text: message
      });
    }
  });

  socket.on('disconnect', () => {
    const userNickname = activeUsers.get(socket.id);
    if (userNickname) {
      activeUsers.delete(socket.id);
      io.emit('user_event', {
        systemMessage: `${userNickname} ha salido del chat.`
      });
    }
    console.log('Usuario desconectado:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor de chat ejecutándose en http://localhost:${PORT}`);
});
