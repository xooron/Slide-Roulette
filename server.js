const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_USERNAME = 'maesexs';
const STARS_TO_TON = 0.02; // 50 звезд = 1 TON

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server started on ${PORT}`));

const userSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    wallet: { type: String, unique: true, sparse: true }, // sparse позволяет иметь несколько пользователей без кошелька
    username: String,
    name: String,
    photo: String,
    balance: { type: Number, default: 0 },
    referralIncome: { type: Number, default: 0 },
    inventory: [{
        itemId: String, name: String, image: String, price: Number,
        isStaked: { type: Boolean, default: false }, stakeStart: Date
    }]
});
const User = mongoose.model('User', userSchema);

mongoose.connect(MONGODB_URI).then(() => console.log("DB Connected"));

// Стейкинг доход
async function processStake(user) {
    const now = new Date();
    let earned = 0;
    user.inventory.forEach(item => {
        if (item.isStaked && item.stakeStart) {
            const diffDays = (now - new Date(item.stakeStart)) / (1000 * 60 * 60 * 24);
            if (diffDays > 0) {
                earned += (item.price * 0.001) * diffDays;
                item.stakeStart = now;
            }
        }
    });
    if (earned > 0) {
        user.referralIncome += earned;
        user.balance += earned;
        await user.save();
    }
    return user;
}

let gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, tapeLayout: [], winnerIndex: 85, onlineCount: 0 };
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
            user = new User({ userId: sId, username: userData.username, name: userData.name, photo: userData.photo, balance: 0.1 });
        }
        
        // Если прилетел кошелек, обновляем его только если он еще не занят
        if (userData.wallet) {
            const existingWallet = await User.findOne({ wallet: userData.wallet });
            if (!existingWallet || existingWallet.userId === sId) {
                user.wallet = userData.wallet;
            }
        }
        
        user.name = userData.name;
        user.photo = userData.photo;
        await user.save().catch(e => console.log("Save error ignored"));
        
        user = await processStake(user);
        socket.emit('updateUserData', user);
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning || !socket.userId) return;
        const amt = parseFloat(data.bet);
        const user = await User.findOne({ userId: socket.userId });
        if (user && user.balance >= amt && amt > 0) {
            user.balance -= amt;
            await user.save();
            socket.emit('updateUserData', user);
            addPlayer(socket.userId, user.name, data.photo, amt);
        }
    });

    function addPlayer(userId, name, photo, amt) {
        let p = gameState.players.find(x => x.userId === userId);
        if (p) { p.bet += amt; } 
        else { gameState.players.push({ userId, name, photo, bet: amt, color: `hsl(${Math.random()*360}, 70%, 60%)` }); }
        gameState.bank += amt;
        if (gameState.players.length >= 2 && !countdownInterval) startCountdown();
        io.emit('sync', gameState);
    }

    socket.on('toggleStake', async (itemId) => {
        const user = await User.findOne({ userId: socket.userId });
        const item = user.inventory.find(i => i.itemId === itemId);
        if (item) {
            item.isStaked = !item.isStaked;
            item.stakeStart = item.isStaked ? new Date() : null;
            await user.save();
            socket.emit('updateUserData', await processStake(user));
        }
    });

    socket.on('adminGive', async (data) => {
        const admin = await User.findOne({ userId: socket.userId });
        if (admin?.username !== ADMIN_USERNAME) return;
        const target = await User.findOne({ username: data.user.replace('@','') });
        if (target) {
            target.balance += parseFloat(data.amt);
            await target.save();
            io.to(target.userId).emit('updateUserData', target);
        }
    });

    socket.on('createInvoice', async (stars) => {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: `TON Balance`, payload: `dep_${socket.userId}`,
                currency: "XTR", prices: [{ label: "Stars", amount: stars }]
            })
        });
        const d = await res.json();
        if (d.ok) socket.emit('invoiceLink', { url: d.result });
    });
});

function startCountdown() {
    gameState.timeLeft = 15;
    countdownInterval = setInterval(() => {
        gameState.timeLeft--; io.emit('timer', gameState.timeLeft);
        if (gameState.timeLeft <= 0) { clearInterval(countdownInterval); countdownInterval = null; runGame(); }
    }, 1000);
}

async function runGame() {
    if (gameState.players.length < 2) return;
    gameState.isSpinning = true;
    const winnerRandom = Math.random() * gameState.bank;
    let current = 0, winner = gameState.players[0];
    for (let p of gameState.players) { current += p.bet; if (winnerRandom <= current) { winner = p; break; } }

    let tape = [];
    while (tape.length < 110) {
        gameState.players.forEach(p => {
            let count = Math.ceil((p.bet / (gameState.bank || 1)) * 20);
            for(let i=0; i<count; i++) if(tape.length < 110) tape.push({ photo: p.photo, color: p.color });
        });
    }
    tape = tape.sort(() => Math.random() - 0.5);
    tape[85] = { photo: winner.photo, color: winner.color };
    gameState.tapeLayout = tape;

    io.emit('startSpin', gameState);

    setTimeout(async () => {
        const winAmount = gameState.bank * 0.95;
        await User.findOneAndUpdate({ userId: winner.userId }, { $inc: { balance: winAmount } });
        await User.findOneAndUpdate({ username: ADMIN_USERNAME }, { $inc: { balance: gameState.bank * 0.05 } });
        io.emit('winnerUpdate', { winner, winAmount });
        setTimeout(() => {
            gameState.players = []; gameState.bank = 0; gameState.isSpinning = false;
            io.emit('sync', gameState);
        }, 5000);
    }, 11000);
}
