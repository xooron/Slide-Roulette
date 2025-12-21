const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_USERNAME = 'maesexs';
const DB_PATH = path.join(__dirname, 'balances.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

// --- БАЗА ДАННЫХ ---
let db = { users: {}, commissionPool: 0 };
if (fs.existsSync(DB_PATH)) {
    try { db = JSON.parse(fs.readFileSync(DB_PATH)); } catch (e) { console.log("DB Error"); }
}

function saveDB() { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

let gameState = {
    players: [],
    bank: 0,
    isSpinning: false,
    timeLeft: 0,
    onlineCount: 0
};

let countdownInterval = null;

io.on('connection', (socket) => {
    gameState.onlineCount = io.engine.clientsCount;
    io.emit('sync', gameState);

    // Авторизация
    socket.on('auth', (userData) => {
        if (!userData.id) return;
        if (!db.users[userData.id]) {
            db.users[userData.id] = { balance: 0, username: userData.username, name: userData.name };
        } else {
            db.users[userData.id].username = userData.username;
            db.users[userData.id].name = userData.name;
        }
        socket.userId = userData.id;
        socket.emit('updateBalance', db.users[userData.id].balance);
        saveDB();
    });

    // Пополнение
    socket.on('createInvoice', async (amount) => {
        if (!BOT_TOKEN) return;
        try {
            const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: `Пополнение ${amount} ⭐`,
                    description: `Stars Roulette Deposit`,
                    payload: `dep_${socket.userId}`,
                    currency: "XTR",
                    prices: [{ label: "Stars", amount: amount }]
                })
            });
            const data = await res.json();
            if (data.ok) socket.emit('invoiceLink', { url: data.result, amount });
        } catch (e) { console.error(e); }
    });

    socket.on('paymentSuccess', (amount) => {
        if (socket.userId && db.users[socket.userId]) {
            db.users[socket.userId].balance += amount;
            saveDB();
            socket.emit('updateBalance', db.users[socket.userId].balance);
        }
    });

    // ВЫВОД (МИН 1000)
    socket.on('withdrawRequest', (amount) => {
        if (!socket.userId || !db.users[socket.userId]) return;
        let user = db.users[socket.userId];
        if (amount < 1000) return socket.emit('error', "Минимум для вывода: 1000 ⭐");
        if (user.balance < amount) return socket.emit('error', "Недостаточно звезд!");

        user.balance -= amount;
        saveDB();
        socket.emit('updateBalance', user.balance);

        console.log(`\n💰 ЗАЯВКА НА ВЫВОД: @${user.username} - ${amount} ⭐ (ID: ${socket.userId})\n`);
        socket.emit('notify', "Заявка принята! Ожидайте перевод от @maesexs.");
    });

    // Ставка (Суммирование)
    socket.on('makeBet', (data) => {
        if (gameState.isSpinning) return;
        let user = db.users[socket.userId];
        if (!user || user.balance < data.bet) return socket.emit('error', "Недостаточно звезд!");

        user.balance -= data.bet;
        let existing = gameState.players.find(p => p.userId === socket.userId);
        if (existing) {
            existing.bet += data.bet;
        } else {
            gameState.players.push({ ...data, userId: socket.userId });
        }

        gameState.bank += data.bet;
        if (gameState.players.length >= 2 && !countdownInterval) startCountdown();
        
        saveDB();
        io.emit('sync', gameState);
        socket.emit('updateBalance', user.balance);
    });

    socket.on('adminFreeStars', () => {
        if (socket.userId && db.users[socket.userId].username === ADMIN_USERNAME) {
            db.users[socket.userId].balance += 500;
            saveDB();
            socket.emit('updateBalance', db.users[socket.userId].balance);
        }
    });

    socket.on('disconnect', () => {
        gameState.onlineCount = io.engine.clientsCount;
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
    const currentBank = gameState.bank;
    const winnerRandom = Math.random() * currentBank;
    io.emit('startSpin', { winnerRandom, bank: currentBank });

    setTimeout(() => {
        let current = 0;
        let winner = gameState.players[0];
        for (let p of gameState.players) {
            current += p.bet;
            if (winnerRandom <= current) { winner = p; break; }
        }

        const commission = Math.floor(currentBank * 0.05); // 5% тебе
        const winAmount = currentBank - commission;
        db.commissionPool += commission;

        if (db.users[winner.userId]) {
            db.users[winner.userId].balance += winAmount;
        }

        saveDB();
        io.emit('winnerUpdate', { userId: winner.userId, winAmount, winner });
        
        gameState.players = []; gameState.bank = 0; gameState.isSpinning = false;
        io.emit('sync', gameState);
    }, 14000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server started`));
