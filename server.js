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

const userSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    username: String,
    name: String,
    balance: { type: Number, default: 0 },
    gamesPlayed: { type: Number, default: 0 },
    referralsCount: { type: Number, default: 0 },
    referralIncome: { type: Number, default: 0 },
    referredBy: { type: String, default: null }
});
const User = mongoose.model('User', userSchema);

mongoose.connect(MONGODB_URI).then(() => {
    console.log("DB Connected");
});

app.post('/webhook', async (req, res) => {
    const update = req.body;
    if (update.pre_checkout_query) {
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true })
        });
    }
    if (update.message && update.message.successful_payment) {
        const payload = update.message.successful_payment.invoice_payload;
        const userId = payload.split('_')[1];
        const amount = parseInt(update.message.successful_payment.total_amount);
        await User.updateOne({ userId }, { $inc: { balance: amount } });
        const user = await User.findOne({ userId });
        io.to(userId).emit('updateUserData', user);
    }
    res.sendStatus(200);
});

let gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, onlineCount: 0, tapeLayout: [], winnerIndex: 85 };
let countdownInterval = null;

io.on('connection', (socket) => {
    gameState.onlineCount = io.engine.clientsCount;
    io.emit('sync', gameState);

    socket.on('auth', async (userData) => {
        if (!userData || !userData.id) return;
        const sId = userData.id.toString();
        socket.join(sId);
        let user = await User.findOne({ userId: sId });
        if (!user) {
            let rId = userData.start_param;
            user = new User({ userId: sId, username: userData.username, name: userData.name, referredBy: (rId && rId !== sId) ? rId : null, balance: 10 });
            await user.save();
            if (user.referredBy) {
                await User.updateOne({ userId: user.referredBy }, { $inc: { referralsCount: 1, balance: 5 } });
                const r = await User.findOne({ userId: user.referredBy });
                if (r) io.to(user.referredBy).emit('updateUserData', r);
            }
        }
        socket.userId = sId;
        socket.emit('updateUserData', user);
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning) return;
        const amt = parseInt(data.bet);
        if (isNaN(amt) || amt <= 0) return;
        const user = await User.findOne({ userId: socket.userId });
        if (!user || user.balance < amt) return;

        await User.updateOne({ userId: socket.userId }, { $inc: { balance: -amt } });
        let ex = gameState.players.find(p => p.userId === socket.userId);
        if (ex) { ex.bet += amt; } else {
            gameState.players.push({ userId: socket.userId, name: data.name, photo: data.photo, bet: amt, color: `hsl(${Math.random()*360}, 70%, 60%)` });
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
                title: `Купить ${amount} ⭐`,
                description: `Звезды для Slide Roulette`,
                payload: `dep_${socket.userId}`,
                provider_token: "", currency: "XTR",
                prices: [{ label: "Stars", amount: amount }]
            })
        });
        const d = await res.json();
        if (d.ok) socket.emit('invoiceLink', { url: d.result });
    });

    socket.on('adminGiveStars', async (data) => {
        const admin = await User.findOne({ userId: socket.userId });
        if (admin && admin.username === ADMIN_USERNAME) {
            const target = await User.findOneAndUpdate({ username: data.targetUsername.replace('@','') }, { $inc: { balance: parseInt(data.amount) } }, { new: true });
            if (target) io.to(target.userId).emit('updateUserData', target);
        }
    });

    socket.on('disconnect', () => { gameState.onlineCount = io.engine.clientsCount; io.emit('sync', gameState); });
});

function startCountdown() {
    gameState.timeLeft = 15;
    countdownInterval = setInterval(() => {
        gameState.timeLeft--;
        io.emit('timer', gameState.timeLeft);
        if (gameState.timeLeft <= 0) { clearInterval(countdownInterval); countdownInterval = null; runGame(); }
    }, 1000);
}

async function runGame() {
    if (gameState.isSpinning || gameState.players.length < 2) return;
    gameState.isSpinning = true;
    const currentBank = gameState.bank;
    const winnerRandom = Math.random() * currentBank;
    let current = 0, winner = gameState.players[0];
    for (let p of gameState.players) { current += p.bet; if (winnerRandom <= current) { winner = p; break; } }

    let tape = [];
    while (tape.length < 120) {
        gameState.players.forEach(p => {
            let count = Math.ceil((p.bet / currentBank) * 30);
            for(let i=0; i<count; i++) tape.push({ photo: p.photo, color: p.color, name: p.name });
        });
    }
    tape = tape.sort(() => Math.random() - 0.5).slice(0, 110);
    tape[85] = { photo: winner.photo, color: winner.color, name: winner.name };

    gameState.tapeLayout = tape;
    gameState.winnerIndex = 85;
    
    io.emit('startSpin', gameState);

    const winAmount = Math.floor(currentBank * 0.95);
    setTimeout(async () => {
        const winDoc = await User.findOneAndUpdate({ userId: winner.userId }, { $inc: { balance: winAmount, gamesPlayed: 1 } }, { new: true });
        if (winDoc.referredBy) {
            const b = Math.floor(winAmount * 0.01);
            if (b > 0) {
                await User.updateOne({ userId: winDoc.referredBy }, { $inc: { balance: b, referralIncome: b } });
                const rUser = await User.findOne({ userId: winDoc.referredBy });
                if (rUser) io.to(winDoc.referredBy).emit('updateUserData', rUser);
            }
        }
        io.emit('winnerUpdate', { winner, winAmount });
        io.to(winner.userId).emit('updateUserData', winDoc);
        setTimeout(() => { gameState.players = []; gameState.bank = 0; gameState.isSpinning = false; io.emit('sync', gameState); }, 5000);
    }, 11000);
}

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server started`));
