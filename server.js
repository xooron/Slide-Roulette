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
    tapeLayout: [] 
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
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning) return;
        const user = await User.findOne({ userId: socket.userId });
        if (!user || user.balance < data.bet) return socket.emit('error', "Мало звезд!");

        await User.updateOne({ userId: socket.userId }, { $inc: { balance: -data.bet } });
        
        let ex = gameState.players.find(p => p.userId === socket.userId);
        if (ex) {
            ex.bet += data.bet;
        } else {
            gameState.players.push({ 
                userId: socket.userId, 
                name: data.name, 
                photo: data.photo, 
                bet: data.bet, 
                color: `hsl(${Math.random()*360}, 70%, 60%)` 
            });
        }

        gameState.bank += data.bet;
        if (gameState.players.length >= 2 && !countdownInterval) startCountdown();
        
        io.emit('sync', gameState);
        socket.emit('updateUserData', await User.findOne({ userId: socket.userId }));
    });

    socket.on('withdrawRequest', async (amount) => {
        if (!socket.userId) return;
        const user = await User.findOne({ userId: socket.userId });
        
        if (amount < 1000) return socket.emit('error', "Минимум для вывода: 1000 ⭐");
        if (!user || user.balance < amount) return socket.emit('error', "Недостаточно звезд!");

        await User.updateOne({ userId: socket.userId }, { $inc: { balance: -amount } });
        
        const updatedUser = await User.findOne({ userId: socket.userId });
        socket.emit('updateUserData', updatedUser);

        // Уведомление в консоль Render
        console.log(`\n🛑 ЗАЯВКА НА ВЫВОД 🛑\nЮзер: @${user.username}\nСумма: ${amount} ⭐\nID: ${user.userId}\n`);
        
        // Уведомление игроку
        socket.emit('notify', `Заявка на ${amount} ⭐ принята! Выплата придет в течение 24ч.`);
    });

    socket.on('adminGiveStars', async (data) => {
        const admin = await User.findOne({ userId: socket.userId });
        if (admin && admin.username === ADMIN_USERNAME) {
            const target = await User.findOneAndUpdate({ username: data.targetUsername.replace('@','') }, { $inc: { balance: parseInt(data.amount) } }, { new: true });
            if (target) io.emit('updateUserDataTrigger', { id: target.userId, data: target });
        }
    });

    socket.on('adminAddBot', () => {
        if (gameState.isSpinning) return;
        const botBet = Math.floor(Math.random() * 150) + 50;
        const botId = "bot_" + Math.random();
        gameState.players.push({ 
            userId: botId, name: "Bot_" + Math.random().toString(36).substr(2,3), 
            photo: `https://ui-avatars.com/api/?background=random&name=B`, 
            bet: botBet, isBot: true, color: `hsl(${Math.random()*360}, 70%, 60%)` 
        });
        gameState.bank += botBet;
        if (gameState.players.length >= 2 && !countdownInterval) startCountdown();
        io.emit('sync', gameState);
    });

    socket.on('createInvoice', async (amount) => {
        if (!BOT_TOKEN) return;
        try {
            const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: `Пополнение ${amount} ⭐`,
                    description: `Stars Roulette`,
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

    // Генерация ленты
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

    io.emit('startSpin', { winner, winnerRandom, bank: currentBank, tapeLayout: gameState.tapeLayout });

    // РАСЧЕТ ВЫИГРЫША БЕЗ КОМИССИИ НА СВОЮ СТАВКУ
    setTimeout(async () => {
        const profitPool = currentBank - winner.bet; // Ставки чужих игроков
        const commission = Math.floor(profitPool * 0.05); // 5% только с прибыли
        const winAmount = currentBank - commission; // Своя ставка + (прибыль - 5%)
        
        const ids = gameState.players.filter(p => !p.isBot).map(p => p.userId);
        await User.updateMany({ userId: { $in: ids } }, { $inc: { gamesPlayed: 1 } });
        
        if (!winner.isBot) {
            await User.updateOne({ userId: winner.userId }, { $inc: { balance: winAmount } });
        }

        io.emit('winnerUpdate', { winner, winAmount, winnerBet: winner.bet });
        
        gameState.players = []; gameState.bank = 0; gameState.isSpinning = false;
        io.emit('sync', gameState);
    }, 14500);
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`Server started on ${PORT}`));
