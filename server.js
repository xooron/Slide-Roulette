const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_USERNAME = 'maesexs';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const userSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    username: String,
    name: String,
    balance: { type: Number, default: 0 },
    gamesPlayed: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

if (MONGODB_URI) {
    mongoose.connect(MONGODB_URI).then(() => console.log("DB Connected"));
}

let gameState = { 
    players: [], 
    bank: 0, 
    isSpinning: false, 
    timeLeft: 0, 
    onlineCount: 0,
    tapeLayout: [],
    winnerIndex: 0,
    spinStartTime: 0
};

let countdownInterval = null;

io.on('connection', (socket) => {
    gameState.onlineCount = io.engine.clientsCount;
    socket.emit('sync', gameState);

    socket.on('auth', async (userData) => {
        if (!userData.id) return;
        let user = await User.findOne({ userId: userData.id.toString() });
        if (!user) {
            user = new User({ userId: userData.id.toString(), username: userData.username, name: userData.name });
            await user.save();
        }
        socket.userId = user.userId;
        socket.emit('updateUserData', user);
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning) return socket.emit('error', "Ставки закрыты, идет игра!");
        const betAmount = parseInt(data.bet);
        if (isNaN(betAmount) || betAmount <= 0) return socket.emit('error', "Ставка должна быть больше 0!");

        const user = await User.findOne({ userId: socket.userId });
        if (!user || user.balance < betAmount) return socket.emit('error', "Недостаточно звезд!");

        await User.updateOne({ userId: socket.userId }, { $inc: { balance: -betAmount } });
        
        let ex = gameState.players.find(p => p.userId === socket.userId);
        if (ex) { ex.bet += betAmount; } 
        else {
            gameState.players.push({ 
                userId: socket.userId, 
                name: data.name, 
                photo: data.photo, 
                bet: betAmount, 
                color: `hsl(${Math.random()*360}, 70%, 60%)` 
            });
        }

        gameState.bank += betAmount;
        gameState.players.sort((a, b) => b.bet - a.bet);

        if (gameState.players.length >= 2 && !countdownInterval) startCountdown();
        io.emit('sync', gameState);
        socket.emit('updateUserData', await User.findOne({ userId: socket.userId }));
    });

    socket.on('withdrawRequest', async (amount) => {
        const user = await User.findOne({ userId: socket.userId });
        if (!user || amount < 1000 || user.balance < amount) return socket.emit('error', "Минимум 1000 ⭐");
        await User.updateOne({ userId: socket.userId }, { $inc: { balance: -amount } });
        socket.emit('updateUserData', await User.findOne({ userId: socket.userId }));
        socket.emit('notify', "Заявка отправлена!");
    });

    socket.on('adminGiveStars', async (data) => {
        const admin = await User.findOne({ userId: socket.userId });
        if (admin && admin.username === ADMIN_USERNAME) {
            const target = await User.findOneAndUpdate({ username: data.targetUsername.replace('@','') }, { $inc: { balance: parseInt(data.amount) } }, { new: true });
            if (target) io.emit('updateUserDataTrigger', { id: target.userId, data: target });
        }
    });

    socket.on('createInvoice', async (amount) => {
        if (!BOT_TOKEN) return socket.emit('error', "Платежи не настроены");
        try {
            const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: `Пополнение ${amount} ⭐`,
                    description: `Slide Roulette`,
                    payload: `dep_${socket.userId}`,
                    currency: "XTR",
                    prices: [{ label: "Stars", amount: amount }]
                })
            });
            const data = await res.json();
            if (data.ok) socket.emit('invoiceLink', { url: data.result, amount });
        } catch (e) { console.error(e); }
    });

    socket.on('paymentSuccess', async (amount) => {
        await User.updateOne({ userId: socket.userId }, { $inc: { balance: amount } });
        socket.emit('updateUserData', await User.findOne({ userId: socket.userId }));
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
    gameState.spinStartTime = Date.now();
    
    const currentBank = gameState.bank;
    const winnerRandom = Math.random() * currentBank;
    
    let current = 0; 
    let winner = gameState.players[0];
    for (let p of gameState.players) {
        current += p.bet;
        if (winnerRandom <= current) { winner = p; break; }
    }

    let tape = [];
    const players = gameState.players;
    for(let i=0; i<100; i++) {
        const randomP = players[Math.floor(Math.random() * players.length)];
        tape.push({ photo: randomP.photo, color: randomP.color });
    }
    
    const winIdx = 80;
    tape[winIdx] = { photo: winner.photo, color: winner.color };
    
    gameState.tapeLayout = tape;
    gameState.winnerIndex = winIdx;

    io.emit('startSpin', gameState);

    setTimeout(async () => {
        const winAmount = Math.floor(currentBank * 0.95);
        const playerIds = gameState.players.map(p => p.userId);
        
        await User.updateMany({ userId: { $in: playerIds } }, { $inc: { gamesPlayed: 1 } });
        await User.updateOne({ userId: winner.userId }, { $inc: { balance: winAmount } });

        io.emit('winnerUpdate', { winner, winAmount, winnerBet: winner.bet });

        const allUsers = await User.find({ userId: { $in: playerIds } });
        allUsers.forEach(u => io.emit('updateUserDataTrigger', { id: u.userId, data: u }));

        // ОЖИДАЕМ 5 СЕКУНД (пока на клиенте висит модальное окно) прежде чем разрешить ставки
        setTimeout(() => {
            gameState.players = []; 
            gameState.bank = 0; 
            gameState.isSpinning = false; // РАЗРЕШАЕМ СТАВКИ ТУТ
            gameState.spinStartTime = 0;
            gameState.tapeLayout = [];
            io.emit('sync', gameState);
        }, 5000);
        
    }, 11000);
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server started`));
