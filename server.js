const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

let rooms = {};
let users = {}; 

io.on('connection', (socket) => {
    let currentUser = null;
    socket.emit('roomList', Object.keys(rooms));

    socket.on('auth', ({ username, password }) => {
        if (!users[username]) users[username] = { password, gems: 500 }; // Higher starting gems
        if (users[username].password === password) {
            currentUser = username;
            socket.emit('authSuccess', { username, gems: users[username].gems });
            updateLeaderboard();
        } else {
            socket.emit('authError', 'Invalid Credentials');
        }
    });

    socket.on('joinRoom', (roomId) => {
        if (!currentUser) return;
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = { players: [], dealer: { hand: [], score: 0 }, phase: 'betting', deck: [] };
            io.emit('roomList', Object.keys(rooms));
        }
        if (!rooms[roomId].players.find(p => p.name === currentUser)) {
            rooms[roomId].players.push({ id: socket.id, name: currentUser, hand: [], score: 0, bet: 0, status: 'waiting' });
        }
        broadcastRoom(roomId);
    });

    socket.on('placeBet', ({ roomId, amount }) => {
        const room = rooms[roomId];
        const player = room?.players.find(p => p.id === socket.id);
        if (player && users[currentUser].gems >= amount && room.phase === 'betting') {
            player.bet = amount;
            users[currentUser].gems -= amount;
            player.status = 'ready';
            socket.emit('updateBalance', users[currentUser].gems);
            if (room.players.every(p => p.status === 'ready')) startDeal(roomId);
            else broadcastRoom(roomId);
        }
    });

    socket.on('hit', (roomId) => {
        const room = rooms[roomId];
        const player = room?.players.find(p => p.id === socket.id);
        if (player?.status === 'playing') {
            player.hand.push(room.deck.pop());
            player.score = calculateScore(player.hand);
            if (player.score > 21) player.status = 'bust';
            checkAutoProceed(roomId);
        }
    });

    socket.on('stand', (roomId) => {
        const room = rooms[roomId];
        const player = room?.players.find(p => p.id === socket.id);
        if (player) {
            player.status = 'stood';
            checkAutoProceed(roomId);
        }
    });
});

function startDeal(roomId) {
    const room = rooms[roomId];
    room.phase = 'playing';
    room.deck = createDeck();
    room.dealer.hand = [room.deck.pop(), room.deck.pop()];
    room.players.forEach(p => {
        p.hand = [room.deck.pop(), room.deck.pop()];
        p.score = calculateScore(p.hand);
        p.status = 'playing';
    });
    broadcastRoom(roomId);
}

function checkAutoProceed(roomId) {
    const room = rooms[roomId];
    if (room.players.every(p => p.status !== 'playing')) {
        room.phase = 'results';
        room.dealer.score = calculateScore(room.dealer.hand);
        while (room.dealer.score < 17) {
            room.dealer.hand.push(room.deck.pop());
            room.dealer.score = calculateScore(room.dealer.hand);
        }
        endRound(roomId);
    } else {
        broadcastRoom(roomId);
    }
}

function endRound(roomId) {
    const room = rooms[roomId];
    room.players.forEach(p => {
