const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let gameState = {
    players: [],
    bank: 0,
    isSpinning: false,
    timeLeft: 0,
    lastWinner: null
};

let countdownInterval = null;

io.on('connection', (socket) => {
    // Отправляем текущее состояние при подключении
    socket.emit('sync', gameState);

    socket.on('makeBet', (playerData) => {
        if (gameState.isSpinning) return;

        // Добавляем игрока
        gameState.players.push(playerData);
        gameState.bank += playerData.bet;

        // Если игроков двое или больше, и таймер еще не запущен
        if (gameState.players.length >= 2 && !countdownInterval) {
            startCountdown();
        }

        io.emit('sync', gameState);
    });
});

function startCountdown() {
    gameState.timeLeft = 10; // 10 секунд до начала
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
    
    // Генерируем случайное число для определения победителя (от 0 до bank)
    const winnerRandom = Math.random() * gameState.bank;
    
    // Сообщаем всем клиентам начать крутить
    io.emit('startSpin', { winnerRandom, bank: gameState.bank });

    // Ждем окончания анимации (10 сек крутка + 3 сек окно) и сбрасываем игру
    setTimeout(() => {
        gameState = {
            players: [],
            bank: 0,
            isSpinning: false,
            timeLeft: 0,
            lastWinner: null
        };
        io.emit('sync', gameState);
    }, 14000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));