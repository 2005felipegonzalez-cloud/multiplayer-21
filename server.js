const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

let rooms = {
    "The Lounge": { players: [], dealer: { hand: [], score: 0 }, phase: 'betting', entryFee: 25, timeLeft: 15, timer: null, deck: [] },
    "High Roller": { players: [], dealer: { hand: [], score: 0 }, phase: 'betting', entryFee: 100, timeLeft: 15, timer: null, deck: [] },
    "VIP Suite":   { players: [], dealer: { hand: [], score: 0 }, phase: 'betting', entryFee: 500, timeLeft: 15, timer: null, deck: [] }
};

let users = {};

io.on('connection', (socket) => {
    let currentUser = null;
    let currentRoomId = null;

    socket.on('auth', ({ username, password }) => {
        if (!users[username]) {
            users[username] = { password, gems: 1000, lastBonus: 0 };
        }
        if (users[username].password !== password) {
            return socket.emit('notification', "Wrong password!");
        }
        currentUser = username;
        socket.emit('authSuccess', { username, gems: users[username].gems });
        socket.emit('roomList', Object.keys(rooms).map(name => ({
            name,
            fee: rooms[name].entryFee,
            players: rooms[name].players.length,
            phase: rooms[name].phase,
            timeLeft: rooms[name].timeLeft
        })));
    });

    socket.on('claimDaily', () => {
        if (!currentUser) return;
        const now = Date.now();
        const last = users[currentUser].lastBonus || 0;
        if (now - last < 86400000) {
            const remaining = Math.ceil((86400000 - (now - last)) / 3600000);
            return socket.emit('notification', `Daily bonus available in ${remaining}h`);
        }
        users[currentUser].gems += 500;
        users[currentUser].lastBonus = now;
        socket.emit('updateBalance', users[currentUser].gems);
        socket.emit('notification', "🎁 Daily bonus of 500 💎 claimed!");
    });

    socket.on('joinRoom', (roomId) => {
        if (!currentUser || !rooms[roomId]) return;
        const room = rooms[roomId];

        // Leave any previous room cleanly
        if (currentRoomId && rooms[currentRoomId]) {
            rooms[currentRoomId].players = rooms[currentRoomId].players.filter(p => p.id !== socket.id);
            socket.leave(currentRoomId);
            io.to(currentRoomId).emit('updateGame', sanitizeRoom(rooms[currentRoomId]));
        }

        currentRoomId = roomId;
        socket.join(roomId);

        // If game is already playing, join as spectator
        if (room.phase === 'playing') {
            room.players.push({
                id: socket.id,
                name: currentUser,
                hand: [],
                score: 0,
                bet: 0,
                status: 'spectating'
            });
            socket.emit('updateBalance', users[currentUser].gems);
            socket.emit('notification', "Round in progress — you'll join next round!");
            io.to(roomId).emit('updateGame', sanitizeRoom(room));
            return;
        }

        // Betting phase — auto-join with entry fee
        if (users[currentUser].gems < room.entryFee) {
            currentRoomId = null;
            socket.leave(roomId);
            return socket.emit('notification', "Not enough gems to enter this table!");
        }

        users[currentUser].gems -= room.entryFee;
        room.players.push({
            id: socket.id,
            name: currentUser,
            hand: [],
            score: 0,
            bet: room.entryFee,
            status: 'ready'
        });

        socket.emit('updateBalance', users[currentUser].gems);
        io.to(roomId).emit('updateGame', sanitizeRoom(room));
        broadcastLobby();

        // Start timer if this is the first ready player
        if (room.phase === 'betting' && !room.timer && room.players.some(p => p.status === 'ready')) {
            startRoomTimer(roomId);
        }
    });

    socket.on('leaveRoom', (roomId) => {
        if (!rooms[roomId]) return;
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);

        // No refund — leaving forfeits your bet (spectators/waiting had no bet so no loss)
        if (player && player.bet > 0 && room.phase === 'betting') {
            socket.emit('notification', `You left the table — your ${player.bet} 💎 stake is forfeited.`);
        }

        room.players = room.players.filter(p => p.id !== socket.id);
        socket.leave(roomId);
        currentRoomId = null;
        io.to(roomId).emit('updateGame', sanitizeRoom(room));

        // If no ready players left during betting, cancel the timer
        if (room.phase === 'betting' && !room.players.some(p => p.status === 'ready')) {
            if (room.timer) { clearInterval(room.timer); room.timer = null; }
            room.timeLeft = 15;
            io.to(roomId).emit('timerUpdate', 0);
        }
    });

    socket.on('hit', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || player.status !== 'playing') return;

        player.hand.push(dealCard(room));
        player.score = calculateScore(player.hand);
        if (player.score > 21) player.status = 'bust';
        io.to(roomId).emit('updateGame', sanitizeRoom(room));
        checkAutoProceed(roomId);
    });

    socket.on('doubleDown', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        // Double down only on first two cards
        if (!player || player.status !== 'playing' || player.hand.length !== 2) return;
        // Player must have enough gems to double their bet
        if (users[player.name].gems < player.bet) {
            return socket.emit('notification', "Not enough gems to double down!");
        }
        // Charge the extra bet
        users[player.name].gems -= player.bet;
        player.bet *= 2;
        io.to(player.id).emit('updateBalance', users[player.name].gems);
        // Deal exactly one card then stand
        player.hand.push(dealCard(room));
        player.score = calculateScore(player.hand);
        player.status = player.score > 21 ? 'bust' : 'stood';
        player.doubled = true;
        io.to(roomId).emit('updateGame', sanitizeRoom(room));
        checkAutoProceed(roomId);
    });

    socket.on('stand', (roomId) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (!player || player.status !== 'playing') return;
        player.status = 'stood';
        io.to(roomId).emit('updateGame', sanitizeRoom(room));
        checkAutoProceed(roomId);
    });

    socket.on('disconnect', () => {
        if (currentRoomId && rooms[currentRoomId]) {
            const room = rooms[currentRoomId];
            // No refund on disconnect — bet is forfeited
            room.players = room.players.filter(p => p.id !== socket.id);
            io.to(currentRoomId).emit('updateGame', sanitizeRoom(room));
            if (room.phase === 'betting' && !room.players.some(p => p.status === 'ready')) {
                if (room.timer) { clearInterval(room.timer); room.timer = null; }
            }
        }
    });
});

function sanitizeRoom(room) {
    const totalCards = 7 * 52;
    const remaining = room.deck ? room.deck.length : totalCards;
    return {
        players: room.players,
        dealer: room.dealer,
        phase: room.phase,
        entryFee: room.entryFee,
        timeLeft: room.timeLeft,
        deckRemaining: remaining,
        deckTotal: totalCards,
        reshuffleNext: room.reshuffleNext || false
    };
}

function startRoomTimer(roomId) {
    const room = rooms[roomId];
    room.timeLeft = 15;
    if (room.timer) clearInterval(room.timer);
    room.timer = setInterval(() => {
        room.timeLeft--;
        io.to(roomId).emit('timerUpdate', room.timeLeft);
        if (room.timeLeft <= 0) {
            clearInterval(room.timer);
            room.timer = null;
            startDeal(roomId);
        }
    }, 1000);
}

function startDeal(roomId) {
    const room = rooms[roomId];
    const readyPlayers = room.players.filter(p => p.status === 'ready');
    if (readyPlayers.length === 0) {
        room.phase = 'betting';
        io.to(roomId).emit('updateGame', sanitizeRoom(room));
        return;
    }

    room.phase = 'playing';
    if (!room.deck || room.deck.length < 50 || room.reshuffleNext) { room.deck = createShoe(); room.reshuffleNext = false; }
    room.dealer.hand = [dealCard(room), dealCard(room)];
    room.dealer.score = 0;

    room.players.forEach(p => {
        if (p.status === 'ready') {
            p.hand = [dealCard(room), dealCard(room)];
            p.score = calculateScore(p.hand);
            p.status = 'playing';
            // Auto-stand on blackjack
            if (p.score === 21) p.status = 'stood';
        }
    });

    io.to(roomId).emit('updateGame', sanitizeRoom(room));
    broadcastLobby();
    checkAutoProceed(roomId);
}

function checkAutoProceed(roomId) {
    const room = rooms[roomId];
    const stillPlaying = room.players.filter(p => p.status === 'playing');
    if (stillPlaying.length === 0 && room.phase === 'playing') {
        dealerPlay(roomId);
    }
}

function dealerPlay(roomId) {
    const room = rooms[roomId];
    room.phase = 'results';
    room.dealer.score = calculateScore(room.dealer.hand);
    // Casino rule: dealer hits on soft 17 (H17)
    while (room.dealer.score < 17 || isSoft17(room.dealer.hand)) {
        room.dealer.hand.push(dealCard(room));
        room.dealer.score = calculateScore(room.dealer.hand);
    }
    resolveRound(roomId);
}

function resolveRound(roomId) {
    const room = rooms[roomId];
    const dealerScore = room.dealer.score;

    room.players.forEach(p => {
        if (p.status === 'spectating' || p.status === 'waiting') return;

        let outcome = 'lose';
        const playerBJ = isBlackjack(p.hand);
        const dealerBJ = isBlackjack(room.dealer.hand);

        if (p.status === 'bust') {
            outcome = 'lose';
        } else if (playerBJ && dealerBJ) {
            // Both blackjack = push
            outcome = 'push';
            users[p.name].gems += p.bet;
        } else if (playerBJ) {
            // Blackjack pays 3:2
            outcome = 'blackjack';
            users[p.name].gems += p.bet + Math.floor(p.bet * 1.5);
        } else if (dealerBJ) {
            outcome = 'lose';
        } else if (dealerScore > 21 || p.score > dealerScore) {
            outcome = 'win';
            users[p.name].gems += p.bet * 2;
        } else if (p.score === dealerScore) {
            outcome = 'push';
            users[p.name].gems += p.bet;
        }

        p.outcome = outcome;
        io.to(p.id).emit('updateBalance', users[p.name].gems);
        io.to(p.id).emit('roundResult', { outcome, score: p.score, dealerScore, isBlackjack: outcome === 'blackjack' });
    });

    io.to(roomId).emit('updateGame', sanitizeRoom(room));

    setTimeout(() => {
        if (!rooms[roomId]) return;
        room.phase = 'betting';
        room.dealer = { hand: [], score: 0 };

        room.players.forEach(p => {
            p.hand = [];
            p.score = 0;
            p.outcome = null;

            if (p.status === 'spectating') {
                // Spectators can now join if they have gems
                if (users[p.name].gems >= room.entryFee) {
                    users[p.name].gems -= room.entryFee;
                    p.bet = room.entryFee;
                    p.status = 'ready';
                    io.to(p.id).emit('updateBalance', users[p.name].gems);
                    io.to(p.id).emit('notification', "You've been entered into the next round!");
                } else {
                    p.status = 'waiting';
                }
            } else if (users[p.name].gems >= room.entryFee) {
                users[p.name].gems -= room.entryFee;
                p.bet = room.entryFee;
                p.status = 'ready';
                io.to(p.id).emit('updateBalance', users[p.name].gems);
            } else {
                p.status = 'waiting';
                io.to(p.id).emit('notification', "Not enough gems for next round. Visit lobby to switch tables.");
            }
        });

        io.to(roomId).emit('updateGame', sanitizeRoom(room));
        broadcastLobby();

        if (room.players.some(p => p.status === 'ready')) {
            startRoomTimer(roomId);
        }
    }, 6000);
}

function createShoe(numDecks = 7) {
    const suits = ['♠', '♥', '♦', '♣'];
    const values = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    let deck = [];
    for (let d = 0; d < numDecks; d++) {
        suits.forEach(s => values.forEach(v => deck.push({ suit: s, value: v })));
    }
    // Fisher-Yates shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    // Place cut card between 60-75% through the shoe (like a casino)
    const cutPosition = Math.floor(deck.length * (0.60 + Math.random() * 0.15));
    deck.cutCard = cutPosition; // cards remaining when reshuffle is triggered
    return deck;
}

// Deal from the bottom (pop), reshuffle when cut card is passed
function dealCard(room) {
    if (room.deck.length <= (room.deck.cutCard || 0)) {
        // Reshuffle after the current round ends — flag it
        room.reshuffleNext = true;
    }
    return room.deck.pop();
}

function calculateScore(hand) {
    let score = 0, aces = 0;
    hand.forEach(c => {
        if (['J','Q','K'].includes(c.value)) score += 10;
        else if (c.value === 'A') { aces++; score += 11; }
        else score += parseInt(c.value);
    });
    while (score > 21 && aces > 0) { score -= 10; aces--; }
    return score;
}

function isSoft17(hand) {
    // Returns true if hand is exactly soft 17 (Ace counted as 11 + 6)
    let score = 0, aces = 0;
    hand.forEach(c => {
        if (['J','Q','K'].includes(c.value)) score += 10;
        else if (c.value === 'A') { aces++; score += 11; }
        else score += parseInt(c.value);
    });
    while (score > 21 && aces > 0) { score -= 10; aces--; }
    // Soft 17: score is 17 and at least one ace is still counted as 11
    let hardScore = 0;
    hand.forEach(c => {
        if (['J','Q','K'].includes(c.value)) hardScore += 10;
        else if (c.value === 'A') hardScore += 1;
        else hardScore += parseInt(c.value);
    });
    return score === 17 && hardScore < 17;
}

function isBlackjack(hand) {
    // Natural blackjack: exactly 2 cards totalling 21
    return hand.length === 2 && calculateScore(hand) === 21;
}

function broadcastLobby() {
    io.emit('roomList', Object.keys(rooms).map(name => ({
        name,
        fee: rooms[name].entryFee,
        players: rooms[name].players.length,
        phase: rooms[name].phase,
        timeLeft: rooms[name].timeLeft
    })));
}

server.listen(process.env.PORT || 10000, () => {
    console.log(`Royal Gem Casino running on port ${process.env.PORT || 10000}`);
});
