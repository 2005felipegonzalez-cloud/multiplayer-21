const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

let rooms = {};

io.on('connection', (socket) => {
    // Send the list of active rooms to the new player
    socket.emit('roomList', Object.keys(rooms));

    socket.on('joinRoom', (roomId) => {
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = { 
                players: [], 
                dealer: { hand: [], score: 0 }, 
                deck: createDeck(),
                gameStarted: false 
            };
        }
        
        // Only add player if they aren't already in
        if (!rooms[roomId].players.find(p => p.id === socket.id)) {
            rooms[roomId].players.push({ id: socket.id, hand: [], score: 0, status: 'playing' });
        }
        
        io.to(roomId).emit('updateGame', rooms[roomId]);
        io.emit('roomList', Object.keys(rooms)); // Update global room list
    });

    socket.on('startGame', (roomId) => {
        const room = rooms[roomId];
        room.deck = createDeck();
        room.gameStarted = true;
        
        // Deal 2 cards to every player and the dealer
        room.players.forEach(p => {
            p.hand = [room.deck.pop(), room.deck.pop()];
            p.score = calculateScore(p.hand);
            p.status = 'playing';
        });
        room.dealer.hand = [room.deck.pop(), room.deck.pop()];
        room.dealer.score = calculateScore(room.dealer.hand);

        io.to(roomId).emit('updateGame', room);
    });

    socket.on('hit', (roomId) => {
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        if (player && player.status === 'playing') {
            player.hand.push(room.deck.pop());
            player.score = calculateScore(player.hand);
            if (player.score > 21) player.status = 'bust';
            io.to(roomId).emit('updateGame', room);
        }
    });

    socket.on('stand', (roomId) => {
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.status = 'stood';
            
            // If all players are done, Dealer plays
            const activePlayers = room.players.filter(p => p.status === 'playing');
            if (activePlayers.length === 0) {
                while (room.dealer.score < 17) {
                    room.dealer.hand.push(room.deck.pop());
                    room.dealer.score = calculateScore(room.dealer.hand);
                }
                io.to(roomId).emit('updateGame', room);
                io.to(roomId).emit('gameOver', determineWinners(room));
            } else {
                io.to(roomId).emit('updateGame', room);
            }
        }
    });
});

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

function determineWinners(room) {
    return room.players.map(p => {
        if (p.score > 21) return `Player ${p.id.substring(0,4)} Busts!`;
        if (room.dealer.score > 21 || p.score > room.dealer.score) return `Player ${p.id.substring(0,4)} Wins!`;
        if (p.score === room.dealer.score) return `Player ${p.id.substring(0,4)} Push (Tie)`;
        return `Player ${p.id.substring(0,4)} Loses`;
    }).join(' | ');
}

server.listen(process.env.PORT || 3000);
