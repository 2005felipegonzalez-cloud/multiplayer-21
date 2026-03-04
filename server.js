const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

let rooms = {
    "The Lounge": { players: [], dealer: { hand: [], score: 0 }, phase: 'betting', deck: [], timer: null },
    "High Roller": { players: [], dealer: { hand: [], score: 0 }, phase: 'betting', deck: [], timer: null },
    "VIP Suite": { players: [], dealer: { hand: [], score: 0 }, phase: 'betting', deck: [], timer: null }
};
let users = {}; 

io.on('connection', (socket) => {
    let currentUser = null;

    socket.on('auth', ({ username, password }) => {
        if (!users[username]) users[username] = { password, gems: 1000, lastBonus: 0 };
        if (users[username].password === password) {
            currentUser = username;
            socket.emit('authSuccess', { username, gems: users[username].gems });
        }
    });

    // --- DAILY REWARD LOGIC ---
    socket.on('claimDaily', () => {
        if (!currentUser) return;
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        if (now - users[currentUser].lastBonus > oneDay) {
            users[currentUser].gems += 500;
            users[currentUser].lastBonus = now;
            socket.emit('updateBalance', users[currentUser].gems);
            socket.emit('notification', "You claimed 500 Daily Gems! 💎");
        } else {
            socket.emit('notification', "Bonus not ready yet!");
        }
    });

    socket.on('joinRoom', (roomId) => {
        if (!currentUser || !rooms[roomId]) return;
        socket.join(roomId);
        // Clear from other rooms
        Object.keys(rooms).forEach(r => rooms[r].players = rooms[r].players.filter(p => p.name !== currentUser));
        rooms[roomId].players.push({ id: socket.id, name: currentUser, hand: [], score: 0, bet: 0, status: 'waiting' });
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
            
            // If first person bets, start a 15s countdown
            if (room.players.filter(p => p.status === 'ready').length === 1) {
                startCountdown(roomId);
            }
            
            if (room.players.every(p => p.status === 'ready')) {
                clearTimeout(room.timer);
                startDeal(roomId);
            } else {
                broadcastRoom(roomId);
            }
        }
    });

    // ... (Hit/Stand logic remains the same)
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
});

function startCountdown(roomId) {
    const room = rooms[roomId];
    let timeLeft = 15;
    room.timer = setInterval(() => {
        timeLeft--;
        io.to(roomId).emit('timerUpdate', timeLeft);
        if (timeLeft <= 0) {
            clearInterval(room.timer);
            if (room.players.some(p => p.status === 'ready')) startDeal(roomId);
        }
    }, 1000);
}

function startDeal(roomId) {
    const room = rooms[roomId];
    clearInterval(room.timer);
    room.phase = 'playing';
    room.deck = createDeck();
    room.dealer.hand = [room.deck.pop(), room.deck.pop()];
    room.players.forEach(p => {
        if (p.status === 'ready') {
            p.hand = [room.deck.pop(), room.deck.pop()];
            p.score = calculateScore(p.hand);
            p.status = 'playing';
        } else {
            p.status = 'spectating';
        }
    });
    broadcastRoom(roomId);
}

// ... (calculateScore, createDeck, endRound logic)
function checkAutoProceed(roomId) {
    const room = rooms[roomId];
    if (room.players.filter(p => p.status === 'playing').length === 0) {
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
        if (p.status !== 'spectating') {
            if (p.status !== 'bust' && (p.score > room.dealer.score || room.dealer.score > 21)) {
                users[p.name].gems += p.bet * 2;
            } else if (p.score === room.dealer.score && p.status !== 'bust') {
                users[p.name].gems += p.bet;
            }
            io.to(p.id).emit('updateBalance', users[p.name].gems);
        }
    });
    broadcastRoom(roomId);
    setTimeout(() => {
        room.phase = 'betting';
        room.players.forEach(p => { p.hand = []; p.score = 0; p.status = 'waiting'; p.bet = 0; });
        room.dealer = { hand: [], score: 0 };
        broadcastRoom(roomId);
    }, 5000);
}

function broadcastRoom(roomId) { io.to(roomId).emit('updateGame', rooms[roomId]); }
function createDeck() {
    const s = ['♠', '♥', '♦', '♣'], v = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    let d = []; s.forEach(x => v.forEach(y => d.push({suit: x, value: y})));
    return d.sort(() => Math.random() - 0.5);
}
function calculateScore(hand) {
    let s = 0, a = 0;
    hand.forEach(c => { if (['J','Q','K'].includes(c.value)) s += 10; else if (c.value === 'A') { a++; s += 11; } else s += parseInt(c.value); });
    while (s > 21 && a > 0) { s -= 10; a--; }
    return s;
}

server.listen(process.env.PORT || 3000);
