const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

// Настройки
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_USERNAME = 'maesexs';
const APP_URL = "https://slide-roulette.onrender.com"; // Твоя правильная ссылка

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

const userSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    username: String,
    name: String,
    balance: { type: Number, default: 0 },
    gamesPlayed: { type: Number, default: 0 }
});
const User = mongoose.model('User', userSchema);

// ВАЖНО: Сначала запускаем сервер, чтобы Render сразу увидел порт!
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
    
    // Подключаем БД только после старта сервера
    if (MONGODB_URI) {
        mongoose.connect(MONGODB_URI).then(() => {
            console.log("DB Connected");
            // Ставим вебхук
            fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${APP_URL}/webhook`)
                .then(() => console.log("Webhook updated to:", APP_URL))
                .catch(e => console.error("Webhook error:", e));
        });
    }
});

// Обработка платежей (Webhook)
app.post('/webhook', async (req, res) => {
    const update = req.body;
    
    // 1. Сразу отвечаем на PreCheckout (убирает бесконечную загрузку)
    if (update.pre_checkout_query) {
        try {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pre_checkout_query_id: update.pre_checkout_query.id,
                    ok: true
                })
            });
        } catch (e) { console.error("Error answering checkout:", e); }
    }

    // 2. Начисляем звезды
    if (update.message && update.message.successful_payment) {
        const payload = update.message.successful_payment.invoice_payload;
        const userId = payload.split('_')[1];
        const amount = update.message.successful_payment.total_amount;
        
        await User.updateOne({ userId: userId }, { $inc: { balance: amount } });
        const user = await User.findOne({ userId });
        io.to(userId).emit('updateUserData', user);
        io.to(userId).emit('notify', `Зачислено ${amount} ⭐!`);
    }

    res.sendStatus(200);
});

// Логика Socket.io
let gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, onlineCount: 0, tapeLayout: [], winnerIndex: 0, spinStartTime: 0 };
let countdownInterval = null;

io.on('connection', (socket) => {
    gameState.onlineCount = io.engine.clientsCount;
    io.emit('sync', gameState);

    socket.on('auth', async (userData) => {
        if (!userData || !userData.id) return;
        socket.join(userData.id.toString());
        let user = await User.findOne({ userId: userData.id.toString() });
        if (!user) {
            user = new User({ userId: userData.id.toString(), username: userData.username, name: userData.name });
            await user.save();
        }
        socket.userId = user.userId;
        socket.emit('updateUserData', user);
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning) return socket.emit('error', "Ставки закрыты!");
        const betAmount = parseInt(data.bet);
        if (isNaN(betAmount) || betAmount <= 0) return;
        
        const user = await User.findOne({ userId: socket.userId });
        if (!user || user.balance < betAmount) return socket.emit('error', "Недостаточно звезд!");

        await User.updateOne({ userId: socket.userId }, { $inc: { balance: -betAmount } });
        let ex = gameState.players.find(p => p.userId === socket.userId);
        if (ex) { ex.bet += betAmount; } else {
            gameState.players.push({ userId: socket.userId, name: data.name, photo: data.photo, bet: betAmount, color: `hsl(${Math.random()*360}, 70%, 60%)` });
        }
        gameState.bank += betAmount;
        if (gameState.players.length >= 2 && !countdownInterval && !gameState.isSpinning) startCountdown();
        io.emit('sync', gameState);
        socket.emit('updateUserData', await User.findOne({ userId: socket.userId }));
    });

    socket.on('createInvoice', async (amount) => {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: `Пополнение ${amount} ⭐`,
                description: `Stars for Slide Roulette`,
                payload: `dep_${socket.userId}`,
                provider_token: "", 
                currency: "XTR",
                prices: [{ label: "Stars", amount: amount }]
            })
        });
        const d = await res.json();
        if (d.ok) socket.emit('invoiceLink', { url: d.result, amount });
    });

    socket.on('disconnect', () => { 
        gameState.onlineCount = io.engine.clientsCount; 
        io.emit('sync', gameState); 
    });
});

function startCountdown() {
    if (countdownInterval) return;
    gameState.timeLeft = 10;
    countdownInterval = setInterval(() => {
        gameState.timeLeft--;
        io.emit('timer', gameState.timeLeft);
        if (gameState.timeLeft <= 0) { clearInterval(countdownInterval); countdownInterval = null; runGame(); }
    }, 1000);
}

function runGame() {
    if (gameState.isSpinning || gameState.players.length < 2) return;
    gameState.isSpinning = true;
    gameState.spinStartTime = Date.now();
    const currentBank = gameState.bank;
    const winnerRandom = Math.random() * currentBank;
    let current = 0, winner = gameState.players[0];
    for (let p of gameState.players) { current += p.bet; if (winnerRandom <= current) { winner = p; break; } }
    
    let tape = [];
    for(let i=0; i<100; i++) {
        const randomP = gameState.players[Math.floor(Math.random() * gameState.players.length)];
        tape.push({ photo: randomP.photo, color: randomP.color });
    }
    const winIdx = 80; tape[winIdx] = { photo: winner.photo, color: winner.color };
    gameState.tapeLayout = tape; gameState.winnerIndex = winIdx;
    io.emit('startSpin', gameState);

    const winAmount = Math.floor(winner.bet + ((currentBank - winner.bet) * 0.95));

    setTimeout(async () => {
        await User.updateOne({ userId: winner.userId }, { $inc: { balance: winAmount, gamesPlayed: 1 } });
        io.emit('winnerUpdate', { winner, winAmount, winnerBet: winner.bet });
        setTimeout(() => { 
            gameState.players = []; gameState.bank = 0; gameState.isSpinning = false; 
            io.emit('sync', gameState); 
        }, 5000);
    }, 11000);
}
