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
    currentWinner: null
};

let countdownInterval = null;

io.on('connection', (socket) => {
    gameState.onlineCount = io.engine.clientsCount;
    io.emit('sync', gameState);

    socket.on('auth', async (userData) => {
        if (!userData.id) return;
        let user = await User.findOne({ userId: userData.id.toString() });
        if (!user) {
            user = new User({ userId: userData.id.toString(), username: userData.username, name: userData.name });
            await user.save();
        }
        socket.userId = user.userId;
        socket.emit('updateUserData', user);
        
        if (gameState.isSpinning) {
            socket.emit('startSpin', { winner: gameState.currentWinner, tapeLayout: gameState.tapeLayout });
        }
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning) return;
        
        const betAmount = parseInt(data.bet);
        // ЗАЩИТА ОТ МИНУСОВЫХ И НЕКОРРЕКТНЫХ СТАВОК
        if (isNaN(betAmount) || betAmount <= 0) {
            return socket.emit('error', "Ставка должна быть больше 0!");
        }

        const user = await User.findOne({ userId: socket.userId });
        if (!user || user.balance < betAmount) {
            return socket.emit('error', "Недостаточно звезд на балансе!");
        }

        await User.updateOne({ userId: socket.userId }, { $inc: { balance: -betAmount } });
        
        let ex = gameState.players.find(p => p.userId === socket.userId);
        if (ex) {
            ex.bet += betAmount;
        } else {
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
        if (!socket.userId) return;
        const user = await User.findOne({ userId: socket.userId });
        if (!user || amount < 1000 || user.balance < amount) return socket.emit('error', "Минимум 1000 ⭐");

        await User.updateOne({ userId: socket.userId }, { $inc: { balance: -amount } });
        socket.emit('updateUserData', await User.findOne({ userId: socket.userId }));
        console.log(`💰 ВЫВОД: @${user.username} - ${amount} ⭐`);
        socket.emit('notify', "Заявка отправлена! Ожидайте выплату.");
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
                    description: `Пополнение баланса Slide Roulette`,
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
    const currentBank = gameState.bank;
    const winnerRandom = Math.random() * currentBank;
    
    let current = 0; 
    let winner = gameState.players[0];
    for (let p of gameState.players) {
        current += p.bet;
        if (winnerRandom <= current) { winner = p; break; }
    }
    gameState.currentWinner = winner;

    let pool = [];
    gameState.players.forEach(p => {
        let count = Math.max(Math.round((p.bet / currentBank) * 60), 1);
        for(let i=0; i<count; i++) pool.push({ photo: p.photo, color: p.color });
    });
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    let finalTape = [];
    while(finalTape.length < 300) finalTape = finalTape.concat(pool);
    gameState.tapeLayout = finalTape;

    io.emit('startSpin', { winner, bank: currentBank, tapeLayout: gameState.tapeLayout });

    setTimeout(async () => {
        const profit = currentBank - winner.bet;
        const winAmount = Math.floor(winner.bet + (profit * 0.95)); // Своя ставка без комиссии
        
        const playerIds = gameState.players.map(p => p.userId);
        await User.updateMany({ userId: { $in: playerIds } }, { $inc: { gamesPlayed: 1 } });
        
        if (!winner.isBot) {
            await User.updateOne({ userId: winner.userId }, { $inc: { balance: winAmount } });
        }

        io.emit('winnerUpdate', { winner, winAmount, winnerBet: winner.bet });

        // Мгновенное обновление балансов
        for (let id of playerIds) {
            const u = await User.findOne({ userId: id });
            if (u) io.emit('updateUserDataTrigger', { id, data: u });
        }

        gameState.players = []; gameState.bank = 0; gameState.isSpinning = false; 
        gameState.tapeLayout = []; gameState.currentWinner = null;
        io.emit('sync', gameState);
    }, 14500);
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server started`));
