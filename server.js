const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_USERNAME = 'maesexs';

// База цен и данных подарков
const GIFT_MARKET = {
    "Lollipop": { price: 150, img: "https://stickers.fullyst.com/967291c8-a210-5ea4-9cdd-8b656eedba6a/full/AgADYmAAAkD2uUs.webp" },
    "Rose": { price: 100, img: "https://static.tgstat.ru/stickers/v2/a/123.webp" }, // Замените на реальные URL
    "Diamond": { price: 500, img: "https://static.tgstat.ru/stickers/v2/a/456.webp" },
    "Cake": { price: 200, img: "https://static.tgstat.ru/stickers/v2/a/789.webp" },
    "Heart": { price: 300, img: "https://static.tgstat.ru/stickers/v2/a/101.webp" }
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

let gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, onlineCount: 0, tapeLayout: [], winnerIndex: 85 };
let countdownInterval = null;

io.on('connection', (socket) => {
    gameState.onlineCount = io.engine.clientsCount;
    io.emit('sync', gameState);

    socket.on('auth', async (userData) => {
        if (!userData?.id) return;
        const sId = userData.id.toString();
        socket.join(sId);
        let user = await User.findOne({ userId: sId });
        if (!user) {
            user = new User({ userId: sId, username: userData.username, name: userData.name, referredBy: userData.start_param, balance: 10 });
            await user.save();
        }
        socket.userId = sId;
        socket.emit('updateUserData', user);
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning) return;
        const amt = parseInt(data.bet);
        if (isNaN(amt) || amt < 1) return;
        const user = await User.findOne({ userId: socket.userId });
        if (!user || user.balance < amt) return;

        await User.updateOne({ userId: socket.userId }, { $inc: { balance: -amt } });
        let p = gameState.players.find(x => x.userId === socket.userId);
        if (p) { p.bet += amt; } else {
            gameState.players.push({ userId: socket.userId, name: data.name, photo: data.photo, bet: amt, color: `hsl(${Math.random()*360}, 70%, 60%)` });
        }
        gameState.bank += amt;
        if (gameState.players.length >= 2 && !countdownInterval) startCountdown();
        io.emit('sync', gameState);
        socket.emit('updateUserData', await User.findOne({ userId: socket.userId }));
    });

    // Админ-панель: выдача Звезд или конкретного Подарка
    socket.on('adminGiveStars', async (data) => {
        const admin = await User.findOne({ userId: socket.userId });
        if (admin?.username !== ADMIN_USERNAME) return;
        const cleanUser = data.targetUsername.replace('@', '').trim();
        const gift = GIFT_MARKET[data.amount]; // Если в поле "amount" введено название подарка

        if (gift) {
            const target = await User.findOneAndUpdate(
                { username: new RegExp(`^${cleanUser}$`, "i") },
                { $push: { inventory: { itemId: Date.now().toString(), name: data.amount, image: gift.img, price: gift.price } } },
                { new: true }
            );
            if (target) io.to(target.userId).emit('updateUserData', target);
        } else {
            const amt = parseInt(data.amount);
            const target = await User.findOneAndUpdate(
                { username: new RegExp(`^${cleanUser}$`, "i") },
                { $inc: { balance: amt } },
                { new: true }
            );
            if (target) io.to(target.userId).emit('updateUserData', target);
        }
    });

    // Обмен NFT на Звезды
    socket.on('exchangeNFT', async (itemId) => {
        const user = await User.findOne({ userId: socket.userId });
        const item = user.inventory.find(i => i.itemId === itemId);
        if (!item || item.isStaked) return;

        await User.updateOne(
            { userId: socket.userId },
            { $inc: { balance: item.price }, $pull: { inventory: { itemId: itemId } } }
        );
        socket.emit('updateUserData', await User.findOne({ userId: socket.userId }));
    });

    // Стейкинг
    socket.on('toggleStake', async (itemId) => {
        const user = await User.findOne({ userId: socket.userId });
        const item = user.inventory.find(i => i.itemId === itemId);
        if (!item) return;

        const newState = !item.isStaked;
        await User.updateOne(
            { userId: socket.userId, "inventory.itemId": itemId },
            { $set: { "inventory.$.isStaked": newState, "inventory.$.stakeStart": newState ? new Date() : null } }
        );
        socket.emit('updateUserData', await User.findOne({ userId: socket.userId }));
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
    while (tape.length < 110) {
        gameState.players.forEach(p => {
            let count = Math.ceil((p.bet / currentBank) * 20);
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
        const winDoc = await User.findOneAndUpdate({ userId: winner.userId }, { $inc: { balance: winAmount, gamesPlayed: 1 } }, { new: true });
        io.emit('winnerUpdate', { winner, winAmount, multiplier });
        io.to(winner.userId).emit('updateUserData', winDoc);
        setTimeout(() => { gameState.players = []; gameState.bank = 0; gameState.isSpinning = false; io.emit('sync', gameState); }, 6000);
    }, 11000);
}

server.listen(process.env.PORT || 10000, '0.0.0.0', () => console.log(`Server started`));
