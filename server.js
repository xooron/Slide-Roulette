const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let gameState = {
    players: [],
    bank: 0,
    isSpinning: false,
    timeLeft: 0,
    onlineCount: 0
};

let countdownInterval = null;

io.on('connection', (socket) => {
    // Увеличиваем счетчик онлайна
    gameState.onlineCount = io.engine.clientsCount;
    io.emit('sync', gameState);

    socket.on('disconnect', () => {
        gameState.onlineCount = io.engine.clientsCount;
        io.emit('sync', gameState);
    });

    socket.on('createInvoice', async (amount) => {
        if (!BOT_TOKEN) return;
        try {
            const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: `Пополнение ${amount} ⭐`,
                    description: `Зачисление звезд на баланс Stars Roulette`,
                    payload: `deposit_${amount}`,
                    currency: "XTR",
                    prices: [{ label: "Stars", amount: amount }]
                })
            });
            const data = await response.json();
            if (data.ok) socket.emit('invoiceLink', { url: data.result, amount });
        } catch (e) { console.error(e); }
    });

    socket.on('makeBet', (data) => {
        if (gameState.isSpinning) return;

        // Ищем, есть ли уже такой игрок в раунде (по уникальному ID)
        let existingPlayer = gameState.players.find(p => p.userId === data.userId);

        if (existingPlayer) {
            // Если есть, просто прибавляем ставку
            existingPlayer.bet += data.bet;
        } else {
            // Если нет, добавляем как нового
            gameState.players.push(data);
        }

        gameState.bank += data.bet;

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
        gameState.players = [];
        gameState.bank = 0;
        gameState.isSpinning = false;
        gameState.timeLeft = 0;
        io.emit('sync', gameState);
    }, 14000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server started` trial));
