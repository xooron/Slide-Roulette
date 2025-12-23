const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const { TonClient, WalletContractV4, internal, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const MNEMONIC = process.env.MNEMONIC; 
const ADMIN_WALLET = "ВАШ_ТОН_АДРЕС_ДЛЯ_ПРИЕМА"; // Тот, куда придут деньги
const ADMIN_USERNAME = 'maesexs';

const app = express();
app.use(express.json());
app.use(express.static(__dirname));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`==> Server started on ${PORT}`));

const tonClient = new TonClient({ endpoint: 'https://toncenter.com/api/v2/jsonRPC' });

const userSchema = new mongoose.Schema({
    userId: { type: String, unique: true },
    wallet: { type: String, default: null },
    username: String,
    name: String,
    photo: String,
    balance: { type: Number, default: 0 },
    totalFarmed: { type: Number, default: 0 },
    referralsCount: { type: Number, default: 0 },
    inventory: [{ itemId: String, name: String, image: String, price: Number, isStaked: { type: Boolean, default: false }, stakeStart: Date }]
});
const User = mongoose.model('User', userSchema);
mongoose.connect(MONGODB_URI).then(() => console.log("==> DB Connected"));

// Функция начисления стейкинга
async function updateStake(user) {
    let earned = 0;
    user.inventory.forEach(i => {
        if (i.isStaked && i.stakeStart) {
            let diff = (new Date() - new Date(i.stakeStart)) / (1000 * 60 * 60 * 24);
            earned += (i.price * 0.001) * diff; // 0.1% в день
            i.stakeStart = new Date();
        }
    });
    if (earned > 0) {
        user.balance += earned;
        user.totalFarmed += earned;
        await user.save();
    }
    return user;
}

let gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, tapeLayout: [], winnerIndex: 85 };

io.on('connection', (socket) => {
    socket.on('auth', async (data) => {
        if (!data.id) return;
        const sId = data.id.toString();
        socket.join(sId);
        socket.userId = sId;

        let user = await User.findOne({ userId: sId });
        if (!user) {
            user = new User({ userId: sId, username: data.username, name: data.name, photo: data.photo });
            await user.save();
        }
        if (data.wallet) user.wallet = data.wallet;
        user = await updateStake(user);
        socket.emit('updateUserData', user);
    });

    // Пополнение кошельком (сервер подтверждает баланс)
    socket.on('depositConfirmed', async (data) => {
        const user = await User.findOneAndUpdate({ userId: socket.userId }, { $inc: { balance: parseFloat(data.amount) } }, { new: true });
        if (user) socket.emit('updateUserData', user);
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning || !socket.userId) return;
        const amt = parseFloat(data.bet);
        const user = await User.findOne({ userId: socket.userId });
        if (user && user.balance >= amt && amt > 0) {
            user.balance -= amt; await user.save();
            let p = gameState.players.find(x => x.userId === socket.userId);
            if (p) p.bet += amt; else gameState.players.push({ userId: socket.userId, name: user.name, photo: user.photo, bet: amt, color: `hsl(${Math.random()*360}, 70%, 60%)` });
            gameState.bank += amt;
            socket.emit('updateUserData', user);
            io.emit('sync', { ...gameState, onlineCount: io.engine.clientsCount });
            if (gameState.players.length >= 2 && gameState.timeLeft === 0) startTimer();
        }
    });

    socket.on('requestWithdraw', async (data) => {
        const user = await User.findOne({ userId: socket.userId });
        const amt = parseFloat(data.amount);
        if (user && user.wallet && user.balance >= amt && amt >= 1) {
            user.balance -= amt; await user.save();
            try {
                const key = await mnemonicToWalletKey(MNEMONIC.split(" "));
                const wallet = WalletContractV4.create({ publicKey: key.publicKey, workchain: 0 });
                const contract = tonClient.open(wallet);
                await contract.transfer({ secretKey: key.secretKey, seqno: await contract.getSeqno(), messages: [internal({ to: user.wallet, value: toNano((amt * 0.95).toString()), bounce: false, body: "Withdraw Roulette" })] });
                socket.emit('msg', "Выплата отправлена!");
            } catch (e) { user.balance += amt; await user.save(); socket.emit('msg', "Ошибка сети"); }
            socket.emit('updateUserData', user);
        }
    });

    socket.on('toggleStake', async (itemId) => {
        const user = await User.findOne({ userId: socket.userId });
        const item = user.inventory.find(i => i.itemId === itemId);
        if (item) {
            item.isStaked = !item.isStaked;
            item.stakeStart = item.isStaked ? new Date() : null;
            await user.save();
            socket.emit('updateUserData', await updateStake(user));
        }
    });

    socket.on('createInvoice', async (stars) => {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: `TopUp TON`, payload: `dep_${socket.userId}`, currency: "XTR", prices: [{ label: "Stars", amount: stars }] })
        });
        const d = await res.json();
        if (d.ok) socket.emit('invoiceLink', { url: d.result });
    });
});

function startTimer() {
    gameState.timeLeft = 15;
    let t = setInterval(() => {
        gameState.timeLeft--; io.emit('timer', gameState.timeLeft);
        if (gameState.timeLeft <= 0) { clearInterval(t); runGame(); }
    }, 1000);
}

async function runGame() {
    gameState.isSpinning = true;
    const currentBank = gameState.bank;
    const winnerRandom = Math.random() * currentBank;
    let current = 0, winner = gameState.players[0];
    for (let p of gameState.players) { current += p.bet; if (winnerRandom <= current) { winner = p; break; } }

    let tape = [];
    while (tape.length < 110) {
        gameState.players.forEach(p => {
            let count = Math.ceil((p.bet / (currentBank || 1)) * 20);
            for(let i=0; i<count; i++) if(tape.length < 110) tape.push({ photo: p.photo, color: p.color });
        });
    }
    tape = tape.sort(() => Math.random() - 0.5);
    tape[85] = { photo: winner.photo, color: winner.color };
    gameState.tapeLayout = tape;

    io.emit('startSpin', gameState);

    setTimeout(async () => {
        const winAmount = currentBank * 0.95;
        await User.findOneAndUpdate({ userId: winner.userId }, { $inc: { balance: winAmount } });
        await User.findOneAndUpdate({ username: ADMIN_USERNAME }, { $inc: { balance: currentBank * 0.05 } });
        io.emit('winnerUpdate', { winner, winAmount });
        gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, tapeLayout: [], winnerIndex: 85 };
        setTimeout(() => io.emit('sync', gameState), 2000);
    }, 11000);
}
