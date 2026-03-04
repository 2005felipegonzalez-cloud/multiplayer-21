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
        if (!users[username]) users[username] = { password, gems: 500 };
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
        if (p.status !== 'bust' && (p.score > room.dealer.score || room.dealer.score > 21)) {
            users[p.name].gems += p.bet * 2;
        } else if (p.score === room.dealer.score && p.status !== 'bust') {
            users[p.name].gems += p.bet;
        }
        io.to(p.id).emit('updateBalance', users[p.name].gems);
    });
    broadcastRoom(roomId);
    updateLeaderboard();
    setTimeout(() => {
        if (!rooms[roomId]) return;
        rooms[roomId].phase = 'betting';
        rooms[roomId].players.forEach(p => { p.hand = []; p.score = 0; p.status = 'waiting'; p.bet = 0; });
        rooms[roomId].dealer = { hand: [], score: 0 };
        broadcastRoom(roomId);
    }, 8000);
}

function broadcastRoom(roomId) { io.to(roomId).emit('updateGame', rooms[roomId]); }

function updateLeaderboard() {
    const top = Object.entries(users)
        .map(([name, data]) => ({ name, gems: data.gems }))
        .sort((a, b) => b.gems - a.gems).slice(0, 5);
    io.emit('leaderboard', top);
}

function createDeck() {
    const s = ['♠', '♥', '♦', '♣'], v = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    let d = []; s.forEach(x => v.forEach(y => d.push({suit: x, value: y})));
    return d.sort(() => Math.random() - 0.5);
}

function calculateScore(hand) {
    let s = 0, a = 0;
    hand.forEach(c => {
        if (['J','Q','K'].includes(c.value)) s += 10;
        else if (c.value === 'A') { a++; s += 11; }
        else s += parseInt(c.value);
    });
    while (s > 21 && a > 0) { s -= 10; a--; }
    return s;
}

server.listen(process.env.PORT || 3000);
