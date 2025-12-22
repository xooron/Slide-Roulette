const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_USERNAME = 'maesexs';

const GIFT_MARKET = {
    "PlushPepe": { 
        price: 650000, 
        img: "https://cache.tonapi.io/imgproxy/P0Z2Vj7bG1tucX0LSvES-_W7cGHKtb3KUKxFtaoN3wM/rs:fill:500:500:1/g:no/aHR0cHM6Ly9uZnQuZnJhZ21lbnQuY29tL2dpZnQvcGx1c2hwZXBlLTE3OC53ZWJw.webp" 
    }
};

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
    referredBy: { type: String, default: null },
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

// Вебхук для обработки платежей
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
        const userId = payload.split('_')[1];
        const amount = parseInt(update.message.successful_payment.total_amount);
        const user = await User.findOneAndUpdate({ userId }, { $inc: { balance: amount } }, { new: true });
        if (user) io.to(userId).emit('updateUserData', user);
    }
    res.sendStatus(200);
});

let gameState = { players: [], bank: 0, potNFTs: [], isSpinning: false, timeLeft: 0, onlineCount: 0, tapeLayout: [], winnerIndex: 85 };
let countdownInterval = null;

io.on('connection', (socket) => {
    gameState.onlineCount = io.engine.clientsCount;
    io.emit('sync', gameState);

    socket.on('auth', async (userData) => {
        if (!userData || !userData.id) return;
        const sId = userData.id.toString();
        socket.join(sId);
        socket.userId = sId;
        let user = await User.findOne({ userId: sId });
        if (!user) {
            user = new User({ userId: sId, username: userData.username, name: userData.name, balance: 10 });
            await user.save();
        }
        socket.emit('updateUserData', user);
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning || !socket.userId) return;
        const amt = parseInt(data.bet);
        if (isNaN(amt) || amt < 1) return;
        const user = await User.findOne({ userId: socket.userId });
        if (!user || user.balance < amt) return;
        
        const updatedUser = await User.findOneAndUpdate({ userId: socket.userId }, { $inc: { balance: -amt } }, { new: true });
        socket.emit('updateUserData', updatedUser);
        addPlayer(socket.userId, user.name, data.photo, amt, null);
    });

    socket.on('betWithNFT', async (itemId) => {
        if (gameState.isSpinning || !socket.userId) return;
        const user = await User.findOne({ userId: socket.userId });
        if (!user) return;
        const item = user.inventory.find(i => i.itemId === itemId);
        if (!item || item.isStaked) return;

        const val = item.price;
        const nftData = { itemId: item.itemId, name: item.name, image: item.image, price: item.price };
        const updatedUser = await User.findOneAndUpdate({ userId: socket.userId }, { $pull: { inventory: { itemId: itemId } } }, { new: true });
        socket.emit('updateUserData', updatedUser);

        gameState.potNFTs.push(nftData);
        addPlayer(socket.userId, user.name, "", val, item.image);
    });

    function addPlayer(userId, name, photo, amt, nftImg) {
        let p = gameState.players.find(x => x.userId === userId);
        if (p) { 
            p.bet += amt; 
            if(nftImg) p.nftImg = nftImg; 
        } else {
            gameState.players.push({ userId, name, photo, bet: amt, color: `hsl(${Math.random()*360}, 70%, 60%)`, nftImg });
        }
        gameState.bank += amt;
        if (gameState.players.length >= 2 && !countdownInterval) startCountdown();
        io.emit('sync', gameState);
    }

    socket.on('createInvoice', async (amount) => {
        if(!socket.userId) return;
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: `Купить ${amount} ⭐`,
                description: `Пополнение баланса в Slide Roulette`,
                payload: `dep_${socket.userId}`,
                provider_token: "", currency: "XTR",
                prices: [{ label: "Stars", amount: amount }]
            })
        });
        const d = await res.json();
        if (d.ok) socket.emit('invoiceLink', { url: d.result });
    });

    socket.on('exchangeNFT', async (itemId) => {
        const user = await User.findOne({ userId: socket.userId });
        if(!user) return;
        const item = user.inventory.find(i => i.itemId === itemId);
        if (!item || item.isStaked) return;
        await User.updateOne({ userId: socket.userId }, { $inc: { balance: item.price }, $pull: { inventory: { itemId: itemId } } });
        socket.emit('updateUserData', await User.findOne({ userId: socket.userId }));
    });

    socket.on('toggleStake', async (itemId) => {
        const user = await User.findOne({ userId: socket.userId });
        const item = user.inventory.find(i => i.itemId === itemId);
        if (!item) return;
        const newState = !item.isStaked;
        await User.updateOne({ userId: socket.userId, "inventory.itemId": itemId }, { $set: { "inventory.$.isStaked": newState, "inventory.$.stakeStart": newState ? new Date() : null } });
        socket.emit('updateUserData', await User.findOne({ userId: socket.userId }));
    });

    socket.on('adminGiveStars', async (data) => {
        const admin = await User.findOne({ userId: socket.userId });
        if (admin?.username !== ADMIN_USERNAME) return;
        const cleanUser = data.targetUsername.replace('@','').trim();
        const gift = GIFT_MARKET[data.amount];
        if (gift) {
            await User.findOneAndUpdate({ username: new RegExp(`^${cleanUser}$`, "i") }, { $push: { inventory: { itemId: Date.now().toString(), name: data.amount, image: gift.img, price: gift.price } } });
        } else {
            const amt = parseInt(data.amount);
            if (!isNaN(amt)) await User.findOneAndUpdate({ username: new RegExp(`^${cleanUser}$`, "i") }, { $inc: { balance: amt } });
        }
        const target = await User.findOne({ username: new RegExp(`^${cleanUser}$`, "i") });
        if (target) io.to(target.userId).emit('updateUserData', target);
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
    const currentNFTs = [...gameState.potNFTs];
    const winnerRandom = Math.random() * currentBank;
    let current = 0, winner = gameState.players[0];
    for (let p of gameState.players) { current += p.bet; if (winnerRandom <= current) { winner = p; break; } }

    let tape = [];
    while (tape.length < 110) {
        gameState.players.forEach(p => {
            let count = Math.ceil((p.bet / (currentBank || 1)) * 20);
            for(let i=0; i<count; i++) if(tape.length < 110) tape.push({ photo: p.photo, color: p.color, name: p.name });
        });
    }
    tape = tape.sort(() => Math.random() - 0.5);
    tape[85] = { photo: winner.photo, color: winner.color, name: winner.name };

    gameState.tapeLayout = tape;
    gameState.winnerIndex = 85;
    io.emit('startSpin', gameState);

    const winAmount = Math.floor(currentBank * 0.95);
    const multiplier = (winAmount / (winner.bet || 1)).toFixed(2);

    setTimeout(async () => {
        const winDoc = await User.findOneAndUpdate(
            { userId: winner.userId }, 
            { $inc: { balance: winAmount, gamesPlayed: 1 }, $push: { inventory: { $each: currentNFTs } } }, 
            { new: true }
        );
        io.emit('winnerUpdate', { winner, winAmount, multiplier });
        if(winDoc) io.to(winner.userId).emit('updateUserData', winDoc);
        setTimeout(() => { 
            gameState.players = []; gameState.bank = 0; gameState.potNFTs = []; gameState.isSpinning = false; io.emit('sync', gameState); 
        }, 6000);
    }, 11000);
}

server.listen(process.env.PORT || 10000, '0.0.0.0', () => console.log(`Server started`));
