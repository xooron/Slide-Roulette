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

    socket.on('auth', (userData) => {
        if (!userData.id) return;
        if (!db.users[userData.id]) {
            db.users[userData.id] = { balance: 0, username: userData.username, name: userData.name, gamesPlayed: 0 };
        } else {
            db.users[userData.id].username = userData.username;
            db.users[userData.id].name = userData.name;
        }
        socket.userId = userData.id;
        socket.emit('updateUserData', db.users[userData.id]);
        saveDB();
    });

    // АДМИН-ФУНКЦИЯ: ВЫДАЧА ЗВЕЗД ПО USERNAME
    socket.on('adminGiveStars', (data) => {
        const admin = db.users[socket.userId];
        if (!admin || admin.username !== ADMIN_USERNAME) return;

        const targetEntry = Object.entries(db.users).find(([id, u]) => u.username === data.targetUsername);
        if (targetEntry) {
            const [targetId, targetUser] = targetEntry;
            db.users[targetId].balance += parseInt(data.amount);
            saveDB();
            io.to(io.sockets.get(targetId)).emit('updateUserData', db.users[targetId]); // если в сети
            socket.emit('notify', `Выдано ${data.amount} ⭐ пользователю @${data.targetUsername}`);
        } else {
            socket.emit('error', "Пользователь не найден в базе");
        }
    });

    // АДМИН-ФУНКЦИЯ: ДОБАВЛЕНИЕ БОТА
    socket.on('adminAddBot', () => {
        const admin = db.users[socket.userId];
        if (!admin || admin.username !== ADMIN_USERNAME || gameState.isSpinning) return;

        const botBet = Math.floor(Math.random() * (200 - 50 + 1)) + 50;
        const botId = "bot_" + Math.random().toString(36).substr(2, 9);
        const botNames = ["SnowLeo", "IceKing", "Frosty", "SantaBet", "WinterPro", "Glacier"];
        const botName = botNames[Math.floor(Math.random() * botNames.length)];

        gameState.players.push({
            userId: botId,
            name: "[BOT] " + botName,
            photo: `https://ui-avatars.com/api/?name=${botName}&background=random`,
            bet: botBet,
            color: `hsl(${Math.random() * 360}, 70%, 60%)`,
            isBot: true
        });

        gameState.bank += botBet;
        if (gameState.players.length >= 2 && !countdownInterval) startCountdown();
        io.emit('sync', gameState);
    });

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
        socket.emit('updateUserData', user);
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

        const commission = Math.floor(currentBank * 0.05);
        const winAmount = currentBank - commission;
        db.commissionPool += commission;

        // Обновляем статистику всем участникам
        gameState.players.forEach(p => {
            if (!p.isBot && db.users[p.userId]) {
                db.users[p.userId].gamesPlayed++;
            }
        });

        if (!winner.isBot && db.users[winner.userId]) {
            db.users[winner.userId].balance += winAmount;
        }

        saveDB();
        io.emit('winnerUpdate', { userId: winner.userId, winAmount, winner });
        
        // Отправляем обновленные данные пользователям
        gameState.players.forEach(p => {
            if (!p.isBot) io.emit('updateUserDataTrigger', {id: p.userId, data: db.users[p.userId]});
        });

        gameState.players = []; gameState.bank = 0; gameState.isSpinning = false;
        io.emit('sync', gameState);
    }, 14000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server started`));
