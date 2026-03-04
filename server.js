const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

// Game State Storage
const rooms = {}; 

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('joinRoom', (roomId) => {
        socket.join(roomId);
        if (!rooms[roomId]) {
            rooms[roomId] = { players: [], deck: createDeck() };
        }
        
        const player = { id: socket.id, hand: [], score: 0 };
        rooms[roomId].players.push(player);
        
        // Tell everyone in the room a new player joined
        io.to(roomId).emit('updatePlayers', rooms[roomId].players);
    });

    socket.on('hit', (roomId) => {
        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.hand.push(room.deck.pop());
            player.score = calculateScore(player.hand);
            io.to(roomId).emit('updatePlayers', room.players);
        }
    });
});

function createDeck() {
    const suits = ['♠', '♥', '♦', '♣'];
    const values = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    let deck = [];
    for (let s of suits) {
        for (let v of values) {
            deck.push({ suit: s, value: v });
        }
    }
    return deck.sort(() => Math.random() - 0.5);
}

function calculateScore(hand) {
    let score = 0;
    let aces = 0;
    hand.forEach(card => {
        if (['J', 'Q', 'K'].includes(card.value)) score += 10;
        else if (card.value === 'A') { aces += 1; score += 11; }
        else score += parseInt(card.value);
    });
    while (score > 21 && aces > 0) { score -= 10; aces -= 1; }
    return score;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
