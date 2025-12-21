const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Раздаем статические файлы из текущей папки
app.use(express.static(path.join(__dirname)));

// Явно указываем, что по адресу "/" нужно отдать index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let gameState = {
    players: [],
    bank: 0,
    isSpinning: false,
    timeLeft: 0,
    lastWinner: null
};

let countdownInterval = null;

io.on('connection', (socket) => {
    socket.emit('sync', gameState);

    socket.on('makeBet', (playerData) => {
        if (gameState.isSpinning) return;
        gameState.players.push(playerData);
        gameState.bank += playerData.bet;
        if (gameState.players.length >= 2 && !countdownInterval) {
            startCountdown();
        }
        io.emit('sync', gameState);
    });
});

function startCountdown() {
    gameState.timeLeft = 10;
    countdownInterval = setInterval(() => {
        gameState.timeLeft--;
        io.emit('timer', gameState.timeLeft);
        if (gameState.timeLeft <= 0) {
            clearInterval(countdownInterval);
            countdownInterval = null;
            runGame();
        }
    }, 1000);
}

function runGame() {
    gameState.isSpinning = true;
    const winnerRandom = Math.random() * gameState.bank;
    io.emit('startSpin', { winnerRandom, bank: gameState.bank });
    setTimeout(() => {
        gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, lastWinner: null };
        io.emit('sync', gameState);
    }, 14000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
