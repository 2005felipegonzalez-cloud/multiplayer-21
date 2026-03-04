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
        broadcastLobby(socket);
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

    // Join room — FREE, no gems taken. Player watches until they opt in.
    socket.on('joinRoom', (roomId) => {
        if (!currentUser || !rooms[roomId]) return;
        const room = rooms[roomId];

        // Leave previous room cleanly (no penalty for leaving between rounds)
        if (currentRoomId && rooms[currentRoomId]) {
            const oldRoom = rooms[currentRoomId];
            const oldPlayer = oldRoom.players.find(p => p.id === socket.id);
            // If mid-hand, forfeit bet
            if (oldPlayer && oldRoom.phase === 'playing' && oldPlayer.status === 'playing') {
                socket.emit('notification', `Left mid-hand — ${oldPlayer.bet} 💎 forfeited.`);
            }
            oldRoom.players = oldRoom.players.filter(p => p.id !== socket.id);
            socket.leave(currentRoomId);
            io.to(currentRoomId).emit('updateGame', sanitizeRoom(oldRoom));
            checkTimerCancel(currentRoomId);
        }

        currentRoomId = roomId;
        socket.join(roomId);

        // Add as 'watching' — free, no commitment
        room.players.push({
            id: socket.id,
            name: currentUser,
            hand: [],
            score: 0,
            bet: 0,
            status: 'watching'
        });

        socket.emit('updateBalance', users[currentUser].gems);
        socket.emit('updateGame', sanitizeRoom(room));

        if (room.phase === 'playing') {
            socket.emit('notification', "Round in progress — click 'Play Next Round' to join after this hand!");
        } else if (room.phase === 'betting') {
            socket.emit('notification', `Watching table. Click 'Play Next Round' to enter for ${room.entryFee} 💎.`);
        }

        broadcastLobby();
    });

    // Player explicitly opts in to next round
    socket.on('joinNextRound', (roomId) => {
        if (!currentUser || !rooms[roomId]) return;
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        // Can only opt in while watching/waiting and not during active play
        if (!['watching', 'waiting'].includes(player.status)) return;

        if (users[currentUser].gems < room.entryFee) {
            return socket.emit('notification', `Not enough gems! Need ${room.entryFee} 💎 to play.`);
        }

        // Mark as ready — gems charged at deal time, not now
        player.status = 'ready';
        socket.emit('notification', `✅ You're in for the next round! ${room.entryFee} 💎 will be charged when cards are dealt.`);
        io.to(roomId).emit('updateGame', sanitizeRoom(room));

        // Start countdown if this is the first ready player
        if (room.phase === 'betting' && !room.timer) {
            startRoomTimer(roomId);
        }
    });

    // Player cancels their opt-in (only allowed before cards are dealt)
    socket.on('cancelRound', (roomId) => {
        if (!rooms[roomId]) return;
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        if (!player || player.status !== 'ready') return;

        player.status = 'watching';
        socket.emit('notification', "You've opted out of the next round. You'll watch for free.");
        io.to(roomId).emit('updateGame', sanitizeRoom(room));

        // If nobody is ready anymore, cancel the timer
        checkTimerCancel(roomId);
    });

    socket.on('leaveRoom', (roomId) => {
        if (!rooms[roomId]) return;
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);

        // Only forfeit if mid-hand (cards already dealt and they're still playing)
        if (player && room.phase === 'playing' && player.status === 'playing' && player.bet > 0) {
            socket.emit('notification', `Left mid-hand — ${player.bet} 💎 forfeited.`);
        }
        // Watching/ready/waiting players leave for free

        room.players = room.players.filter(p => p.id !== socket.id);
        socket.leave(roomId);
        currentRoomId = null;
        io.to(roomId).emit('updateGame', sanitizeRoom(room));
        checkTimerCancel(roomId);
        broadcastLobby();
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
        if (!player || player.status !== 'playing' || player.hand.length !== 2) return;
        if (users[player.name].gems < player.bet) {
            return socket.emit('notification', "Not enough gems to double down!");
        }
        users[player.name].gems -= player.bet;
        player.bet *= 2;
        io.to(player.id).emit('updateBalance', users[player.name].gems);
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
            // No penalty unless mid-hand
            room.players = room.players.filter(p => p.id !== socket.id);
            io.to(currentRoomId).emit('updateGame', sanitizeRoom(room));
            checkTimerCancel(currentRoomId);
        }
    });
});

function checkTimerCancel(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    if (room.phase === 'betting' && !room.players.some(p => p.status === 'ready')) {
        if (room.timer) { clearInterval(room.timer); room.timer = null; }
        room.timeLeft = 15;
        io.to(roomId).emit('timerUpdate', { timeLeft: 0, cancelled: true });
    }
}

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
        io.to(roomId).emit('timerUpdate', { timeLeft: room.timeLeft });
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

    // Charge gems NOW — at deal time, not before
    readyPlayers.forEach(p => {
        if (users[p.name].gems >= room.entryFee) {
            users[p.name].gems -= room.entryFee;
            p.bet = room.entryFee;
            io.to(p.id).emit('updateBalance', users[p.name].gems);
        } else {
            // Can't afford — drop to watching
            p.status = 'watching';
            p.bet = 0;
            io.to(p.id).emit('notification', "Not enough gems — you'll watch this round.");
        }
    });

    // Re-check after charging
    const activePlayers = room.players.filter(p => p.status === 'ready');
    if (activePlayers.length === 0) {
        room.phase = 'betting';
        io.to(roomId).emit('updateGame', sanitizeRoom(room));
        return;
    }

    room.phase = 'playing';
    if (!room.deck || room.deck.length < 50 || room.reshuffleNext) {
        room.deck = createShoe();
        room.reshuffleNext = false;
        io.to(roomId).emit('notification', "🔀 New shoe shuffled!");
    }

    room.dealer.hand = [dealCard(room), dealCard(room)];
    room.dealer.score = 0;

    room.players.forEach(p => {
        if (p.status === 'ready') {
            p.hand = [dealCard(room), dealCard(room)];
            p.score = calculateScore(p.hand);
            p.status = 'playing';
            if (p.score === 21) p.status = 'stood'; // auto-stand on blackjack
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
        if (p.bet === 0) return; // watchers/spectators

        let outcome = 'lose';
        const playerBJ = isBlackjack(p.hand);
        const dealerBJ = isBlackjack(room.dealer.hand);

        if (p.status === 'bust') {
            outcome = 'lose';
        } else if (playerBJ && dealerBJ) {
            outcome = 'push';
            users[p.name].gems += p.bet;
        } else if (playerBJ) {
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

    // Show results for 6s then reset to betting phase
    setTimeout(() => {
        if (!rooms[roomId]) return;
        room.phase = 'betting';
        room.dealer = { hand: [], score: 0 };

        room.players.forEach(p => {
            p.hand = [];
            p.score = 0;
            p.bet = 0;
            p.outcome = null;
            p.doubled = false;
            // After a round, everyone goes back to 'watching' — they must re-opt-in
            // This prevents auto-charging without consent
            p.status = 'watching';
            io.to(p.id).emit('promptNextRound', { entryFee: room.entryFee });
        });

        io.to(roomId).emit('updateGame', sanitizeRoom(room));
        broadcastLobby();
    }, 6000);
}

function createShoe(numDecks = 7) {
    const suits = ['♠', '♥', '♦', '♣'];
    const values = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    let deck = [];
    for (let d = 0; d < numDecks; d++) {
        suits.forEach(s => values.forEach(v => deck.push({ suit: s, value: v })));
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const cutPosition = Math.floor(deck.length * (0.60 + Math.random() * 0.15));
    deck.cutCard = cutPosition;
    return deck;
}

function dealCard(room) {
    if (room.deck.length <= (room.deck.cutCard || 0)) {
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
    let hardScore = 0;
    hand.forEach(c => {
        if (['J','Q','K'].includes(c.value)) hardScore += 10;
        else if (c.value === 'A') hardScore += 1;
        else hardScore += parseInt(c.value);
    });
    return calculateScore(hand) === 17 && hardScore < 17;
}

function isBlackjack(hand) {
    return hand.length === 2 && calculateScore(hand) === 21;
}

function broadcastLobby(targetSocket) {
    const data = Object.keys(rooms).map(name => ({
        name,
        fee: rooms[name].entryFee,
        players: rooms[name].players.length,
        phase: rooms[name].phase,
        timeLeft: rooms[name].timeLeft
    }));
    if (targetSocket) {
        targetSocket.emit('roomList', data);
    } else {
        io.emit('roomList', data);
    }
}

server.listen(process.env.PORT || 10000, () => {
    console.log(`Royal Gem Casino running on port ${process.env.PORT || 10000}`);
});
