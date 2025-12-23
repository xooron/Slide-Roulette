const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_USERNAME = 'maesexs'; 
const RAKE_PERCENT = 0.05; // 5% комиссия вам

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.static(__dirname));

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server started on ${PORT}`));

const userSchema = new mongoose.Schema({
    userId: String,
    wallet: { type: String, unique: true, sparse: true },
    username: String,
    name: String,
    balance: { type: Number, default: 0 },
    inventory: [{
        itemId: String,
        name: String,
        image: String,
        price: Number,
        isStaked: { type: Boolean, default: false },
        stakeStart: Date
    }]
});
const User = mongoose.model('User', userSchema);

mongoose.connect(MONGODB_URI).then(() => console.log("DB Connected"));

// Вебхук для покупки TON за Звезды (Fragment Style)
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
        const wallet = payload.split('_')[1];
        const stars = update.message.successful_payment.total_amount;
        const ton = stars * 0.025; // Примерный курс
        const user = await User.findOneAndUpdate({ wallet }, { $inc: { balance: ton } }, { new: true });
        if (user) io.to(wallet).emit('updateUserData', user);
    }
    res.sendStatus(200);
});

let gameState = { players: [], bank: 0, potNFTs: [], isSpinning: false, timeLeft: 0, tapeLayout: [] };
let countdownInterval = null;

io.on('connection', (socket) => {
    socket.on('auth', async (data) => {
        if (!data.wallet) return;
        socket.join(data.wallet);
        socket.wallet = data.wallet;
        let user = await User.findOne({ wallet: data.wallet });
        if (!user) {
            user = new User({ wallet: data.wallet, userId: data.id, username: data.username, name: data.name, balance: 0.5 });
            await user.save();
        }
        socket.emit('updateUserData', user);
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning || !socket.wallet) return;
        const amt = parseFloat(data.bet);
        if (isNaN(amt) || amt <= 0) return;
        const user = await User.findOne({ wallet: socket.wallet });
        if (!user || user.balance < amt) return;
        
        user.balance -= amt;
        await user.save();
        socket.emit('updateUserData', user);
        addPlayer(user, amt, null);
    });

    socket.on('betWithNFT', async (itemId) => {
        if (gameState.isSpinning || !socket.wallet) return;
        const user = await User.findOne({ wallet: socket.wallet });
        const item = user.inventory.find(i => i.itemId === itemId);
        if (!item || item.isStaked) return;

        const val = item.price;
        const nftData = { itemId: item.itemId, name: item.name, image: item.image, price: item.price };
        user.inventory = user.inventory.filter(i => i.itemId !== itemId);
        await user.save();
        socket.emit('updateUserData', user);

        gameState.potNFTs.push(nftData);
        addPlayer(user, val, item.image);
    });

    function addPlayer(user, amt, nftImg) {
        let p = gameState.players.find(x => x.wallet === user.wallet);
        if (p) {
            p.bet += amt;
            if(nftImg) p.nftImg = nftImg;
        } else {
            gameState.players.push({ wallet: user.wallet, name: user.name, photo: user.photo, bet: amt, color: `hsl(${Math.random()*360}, 70%, 60%)`, nftImg });
        }
        gameState.bank += amt;
        if (gameState.players.length >= 2 && !countdownInterval) startCountdown();
        io.emit('sync', gameState);
    }

    socket.on('toggleStake', async (itemId) => {
        const user = await User.findOne({ wallet: socket.wallet });
        const item = user.inventory.find(i => i.itemId === itemId);
        if (item) {
            item.isStaked = !item.isStaked;
            item.stakeStart = item.isStaked ? new Date() : null;
            await user.save();
            socket.emit('updateUserData', user);
        }
    });

    socket.on('createInvoice', async (stars) => {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: `TON Balance`,
                description: `Top up via Stars`,
                payload: `dep_${socket.wallet}`,
                currency: "XTR",
                prices: [{ label: "Stars", amount: stars }]
            })
        });
        const d = await res.json();
        if (d.ok) socket.emit('invoiceLink', { url: d.result });
    });
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
    if (gameState.players.length < 2) return;
    gameState.isSpinning = true;
    const currentBank = gameState.bank;
    const currentNFTs = [...gameState.potNFTs];

    const winnerRandom = Math.random() * currentBank;
    let current = 0, winner = gameState.players[0];
    for (let p of gameState.players) { current += p.bet; if (winnerRandom <= current) { winner = p; break; } }

    io.emit('startSpin', { winnerWallet: winner.wallet });

    // Расчет комиссии (5%)
    const rake = currentBank * RAKE_PERCENT;
    const winAmount = currentBank - rake;

    setTimeout(async () => {
        // Начисляем победителю
        await User.findOneAndUpdate({ wallet: winner.wallet }, { $inc: { balance: winAmount }, $push: { inventory: { $each: currentNFTs } } });
        // Начисляем комиссию админу
        await User.findOneAndUpdate({ username: ADMIN_USERNAME }, { $inc: { balance: rake } });

        io.emit('winnerUpdate', { winner, winAmount });
        gameState = { players: [], bank: 0, potNFTs: [], isSpinning: false, timeLeft: 0, tapeLayout: [] };
        io.emit('sync', gameState);
    }, 10000);
}
