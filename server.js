const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

let rooms = {};
let users = {}; // Stores { username: { password, gems } }

io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('auth', ({ username, password }) => {
        if (!users[username]) {
            users[username] = { password, gems: 100 };
        }
        if (users[username].password === password) {
            currentUser = username;
            socket.emit('authSuccess', { username, gems: users[username].gems });
            socket.emit('roomList', Object.keys(rooms));
        } else {
            socket.emit('authError', 'Wrong password!');
        }
    });

    socket.on('joinRoom', (roomId) => {
        if (!currentUser) return;
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = { 
                players: [], 
                dealer: { hand: [], score: 0 }, 
                deck: [],
                phase: 'betting' // Phases: betting, playing, results
            };
        }
        if (!rooms[roomId].players.find(p => p.name === currentUser)) {
            rooms[roomId].players.push({ 
                id: socket.id, name: currentUser, hand: [], 
                score: 0, bet: 0, status: 'waiting' 
            });
        }
        io.to(roomId).emit('updateGame', rooms[roomId]);
    });

    socket.on('placeBet', ({ roomId, amount }) => {
        const room = rooms[roomId];
        const player = room.players.find(p => p.name === currentUser);
        if (player && users[currentUser].gems >= amount) {
            player.bet = amount;
            users[currentUser].gems -= amount;
            player.status = 'ready';
            
            // If everyone has bet, start the game
            if (room.players.every(p => p.status === 'ready')) {
                startGame(room, roomId);
            } else {
                io.to(roomId).emit('updateGame', room);
            }
            socket.emit('updateBalance', users[currentUser].gems);
        }
    });

    socket.on('hit', (roomId) => {
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        if (player && player.status === 'playing') {
            player.hand.push(room.deck.pop());
            player.score = calculateScore(player.hand);
            if (player.score > 21) player.status = 'bust';
            checkDealerTurn(room, roomId);
        }
    });

    socket.on('stand', (roomId) => {
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.status = 'stood';
            checkDealerTurn(room, roomId);
        }
    });
});

function startGame(room, roomId) {
    room.phase = 'playing';
    room.deck = createDeck();
    room.dealer.hand = [room.deck.pop(), room.deck.pop()];
    room.dealer.score = calculateScore(room.dealer.hand);
    room.players.forEach(p => {
        p.hand = [room.deck.pop(), room.deck.pop()];
        p.score = calculateScore(p.hand);
        p.status = 'playing';
    });
    io.to(roomId).emit('updateGame', room);
}

function checkDealerTurn(room, roomId) {
    const active = room.players.filter(p => p.status === 'playing');
    if (active.length === 0) {
        room.phase = 'results';
        while (room.dealer.score < 17) {
            room.dealer.hand.push(room.deck.pop());
            room.dealer.score = calculateScore(room.dealer.hand);
        }
        resolveBets(room);
        io.to(roomId).emit('updateGame', room);
    } else {
        io.to(roomId).emit('updateGame', room);
    }
}

function resolveBets(room) {
    room.players.forEach(p => {
        if (p.status !== 'bust' && (p.score > room.dealer.score || room.dealer.score > 21)) {
            users[p.name].gems += p.bet * 2; // Win
        } else if (p.score === room.dealer.score) {
            users[p.name].gems += p.bet; // Push
        }
        p.bet = 0; // Reset bet for next round
    });
}

function createDeck() {
    const suits = ['♠', '♥', '♦', '♣'], vals = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    let deck = [];
    for (let s of suits) for (let v of vals) deck.push({ suit: s, value: v });
    return deck.sort(() => Math.random() - 0.5);
}

function calculateScore(hand) {
    let score = 0, aces = 0;
    hand.forEach(c => {
        if (['J', 'Q', 'K'].includes(c.value)) score += 10;
        else if (c.value === 'A') { aces++; score += 11; }
        else score += parseInt(c.value);
    });
    while (score > 21 && aces > 0) { score -= 10; aces--; }
    return score;
}

server.listen(process.env.PORT || 3000);
