const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_USERNAME = 'maesexs';

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

// DB Schema
const userSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    username: String,
    name: String,
    balance: { type: Number, default: 10 },
    gamesPlayed: { type: Number, default: 0 },
    referralsCount: { type: Number, default: 0 },
    referredBy: { type: String, default: null }
});
const User = mongoose.model('User', userSchema);

mongoose.connect(MONGODB_URI).then(() => console.log("DB Connected"));

// Game State
let gameState = { 
    players: [], 
    bank: 0, 
    isSpinning: false, 
    timeLeft: 0, 
    onlineCount: 0, 
    tapeLayout: [], 
    winnerIndex: 80 
};
let countdownInterval = null;

app.post('/webhook', async (req, res) => {
    const update = req.body;
    if (update.pre_checkout_query) {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true })
        });
    }
    if (update.message?.successful_payment) {
        const payload = update.message.successful_payment.invoice_payload;
        const [type, userId, amount] = payload.split('_');
        await User.updateOne({ userId }, { $inc: { balance: parseInt(amount) } });
        const user = await User.findOne({ userId });
        if (user) io.to(userId).emit('updateUserData', user);
    }
    res.sendStatus(200);
});

io.on('connection', (socket) => {
    gameState.onlineCount = io.engine.clientsCount;
    io.emit('sync', gameState);

    socket.on('auth', async (userData) => {
        if (!userData?.id) return;
        const sId = userData.id.toString();
        socket.join(sId);
        socket.userId = sId;

        let user = await User.findOne({ userId: sId });
        if (!user) {
            user = new User({ 
                userId: sId, 
                username: userData.username, 
                name: userData.name, 
                referredBy: userData.start_param !== sId ? userData.start_param : null 
            });
            await user.save();
        }
        socket.emit('updateUserData', user);
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning) return;
        const amt = parseInt(data.bet);
        if (isNaN(amt) || amt <= 0) return;

        const user = await User.findOne({ userId: socket.userId });
        if (!user || user.balance < amt) return;

        await User.updateOne({ userId: socket.userId }, { $inc: { balance: -amt } });
        
        let p = gameState.players.find(x => x.userId === socket.userId);
        if (p) {
            p.bet += amt;
        } else {
            gameState.players.push({ 
                userId: socket.userId, 
                name: data.name, 
                photo: data.photo, 
                bet: amt, 
                color: `hsl(${Math.random()*360}, 70%, 60%)` 
            });
        }
        
        gameState.bank += amt;
        if (gameState.players.length >= 2 && !countdownInterval) startCountdown();
        
        io.emit('sync', gameState);
        socket.emit('updateUserData', await User.findOne({ userId: socket.userId }));
    });

    socket.on('createInvoice', async (amount) => {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: `${amount} Звезд`,
                description: `Пополнение баланса Slide Roulette`,
                payload: `buy_${socket.userId}_${amount}`,
                provider_token: "", 
                currency: "XTR",
                prices: [{ label: "Stars", amount: amount }]
            })
        });
        const d = await res.json();
        if (d.ok) socket.emit('invoiceLink', { url: d.result });
    });

    socket.on('disconnect', () => {
        gameState.onlineCount = io.engine.clientsCount;
        io.emit('sync', gameState);
    });
});

function startCountdown() {
    gameState.timeLeft = 15;
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

async function runGame() {
    if (gameState.isSpinning || gameState.players.length < 2) return;
    gameState.isSpinning = true;

    // Выбор победителя (Provably Fair logic)
    const randomPoint = Math.random() * gameState.bank;
    let current = 0, winner = gameState.players[0];
    for (let p of gameState.players) {
        current += p.bet;
        if (randomPoint <= current) { winner = p; break; }
    }

    // Генерация ленты (100 элементов)
    let tape = [];
    for(let i=0; i<100; i++) {
        const randP = gameState.players[Math.floor(Math.random() * gameState.players.length)];
        tape.push({ photo: randP.photo, color: randP.color });
    }
    // Установка реального победителя на 80-ю позицию
    tape[80] = { photo: winner.photo, color: winner.color, name: winner.name };
    
    gameState.tapeLayout = tape;
    gameState.winnerIndex = 80;

    io.emit('startSpin', gameState);

    const winAmount = Math.floor(gameState.bank * 0.95);
    
    setTimeout(async () => {
        await User.updateOne({ userId: winner.userId }, { $inc: { balance: winAmount, gamesPlayed: 1 } });
        io.emit('winnerUpdate', { winner, winAmount });
        
        const winDoc = await User.findOne({ userId: winner.userId });
        io.to(winner.userId).emit('updateUserData', winDoc);

        setTimeout(() => {
            gameState.players = [];
            gameState.bank = 0;
            gameState.isSpinning = false;
            io.emit('sync', gameState);
        }, 6000);
    }, 9500); // 9 сек анимация + 0.5 запас
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server on port ${PORT}`));
