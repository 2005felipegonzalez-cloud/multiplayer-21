const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

// Rooms with different stakes
let rooms = {
    "The Lounge": { players: [], dealer: { hand: [], score: 0 }, phase: 'betting', minBet: 10, timeLeft: 15 },
    "High Roller": { players: [], dealer: { hand: [], score: 0 }, phase: 'betting', minBet: 100, timeLeft: 15 },
    "VIP Suite": { players: [], dealer: { hand: [], score: 0 }, phase: 'betting', minBet: 500, timeLeft: 15 }
};
let users = {}; 

io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('auth', ({ username, password }) => {
        if (!users[username]) users[username] = { password, gems: 1000, lastBonus: 0 };
        if (users[username].password === password) {
            currentUser = username;
            socket.emit('authSuccess', { username, gems: users[username].gems });
            socket.emit('roomList', Object.keys(rooms).map(name => ({ name, min: rooms[name].minBet })));
        }
    });

    socket.on('leaveRoom', (roomId) => {
        if (rooms[roomId]) {
            rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
            socket.leave(roomId);
            io.to(roomId).emit('updateGame', rooms[roomId]);
        }
    });

    socket.on('joinRoom', (roomId) => {
        if (!currentUser || !rooms[roomId]) return;
        socket.join(roomId);
        // Clear from other rooms first
        Object.keys(rooms).forEach(r => rooms[r].players = rooms[r].players.filter(p => p.name !== currentUser));
        rooms[roomId].players.push({ id: socket.id, name: currentUser, hand: [], score: 0, bet: 0, status: 'waiting' });
        io.to(roomId).emit('updateGame', rooms[roomId]);
    });

    socket.on('placeBet', ({ roomId, amount }) => {
        const room = rooms[roomId];
        const player = room?.players.find(p => p.id === socket.id);
        if (player && users[currentUser].gems >= amount && amount >= room.minBet && room.phase === 'betting') {
            player.bet = amount;
            users[currentUser].gems -= amount;
            player.status = 'ready';
            socket.emit('updateBalance', users[currentUser].gems);
            if (room.players.filter(p => p.status === 'ready').length === 1) startRoomTimer(roomId);
            if (room.players.every(p => p.status === 'ready')) { clearInterval(room.timer); startDeal(roomId); }
            else { io.to(roomId).emit('updateGame', room); }
        } else if (amount < room.minBet) {
            socket.emit('notification', `Minimum bet for this table is ${room.minBet}!`);
        }
    });

    // ... (Hit, Stand, calculateScore, startDeal, resolveRound functions stay the same as previous)
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
        if (player) { player.status = 'stood'; checkAutoProceed(roomId); }
    });

    socket.on('claimDaily', () => {
        if (!currentUser) return;
        const now = Date.now();
        if (now - users[currentUser].lastBonus > 86400000) {
            users[currentUser].gems += 500;
            users[currentUser].lastBonus = now;
            socket.emit('updateBalance', users[currentUser].gems);
            socket.emit('notification', "Success! +500 Gems 💎");
        } else {
            socket.emit('notification', "Bonus available every 24h.");
        }
    });
});

// Timer and Deal Logic
function startRoomTimer(roomId) {
    const room = rooms[roomId];
    room.timeLeft = 15;
    if (room.timer) clearInterval(room.timer);
    room.timer = setInterval(() => {
        room.timeLeft--;
        io.to(roomId).emit('timerUpdate', room.timeLeft);
        if (room.timeLeft <= 0) { clearInterval(room.timer); startDeal(roomId); }
    }, 1000);
}

function startDeal(roomId) {
    const room = rooms[roomId];
    room.phase = 'playing';
    room.deck = createDeck();
    room.dealer.hand = [room.deck.pop(), room.deck.pop()];
    room.players.forEach(p => {
        if (p.status === 'ready') {
            p.hand = [room.deck.pop(), room.deck.pop()];
            p.score = calculateScore(p.hand);
            p.status = 'playing';
        } else { p.status = 'spectating'; }
    });
    io.to(roomId).emit('updateGame', room);
}

function checkAutoProceed(roomId) {
    const room = rooms[roomId];
    if (room.players.filter(p => p.status === 'playing').length === 0) {
        room.phase = 'results';
        room.dealer.score = calculateScore(room.dealer.hand);
        while (room.dealer.score < 17) {
            room.dealer.hand.push(room.deck.pop());
            room.dealer.score = calculateScore(room.dealer.hand);
        }
        resolveRound(roomId);
    } else {
        io.to(roomId).emit('updateGame', room);
    }
}

function resolveRound(roomId) {
    const room = rooms[roomId];
    room.players
