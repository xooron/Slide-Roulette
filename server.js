const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const { TonClient, WalletContractV4, internal, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const MNEMONIC = process.env.MNEMONIC; 
const ADMIN_WALLET = "UQC279x6VA1CReWI28w7UtWuUBYC2YTmxYd0lmxqH-9CYgih"; // Сюда слать NFT и комиссии
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
    wallet: { type: String, unique: true },
    tgId: String,
    username: String,
    name: String,
    photo: String,
    balance: { type: Number, default: 0.5 },
    totalFarmed: { type: Number, default: 0 },
    inventory: [{ itemId: String, name: String, image: String, price: Number, isStaked: Boolean, stakeStart: Date }]
});
const User = mongoose.model('User', userSchema);
mongoose.connect(MONGODB_URI).then(() => console.log("==> DB Connected"));

const GIFT_MARKET = {
    "PlushPepe": { price: 100, img: "https://cache.tonapi.io/imgproxy/P0Z2Vj7bG1tucX0LSvES-_W7cGHKtb3KUKxFtaoN3wM/rs:fill:500:500:1/g:no/aHR0cHM6Ly9uZnQuZnJhZ21lbnQuY29tL2dpZnQvcGx1c2hwZXBlLTE3OC53ZWJw.webp" }
};

let gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, tapeLayout: [], winnerIndex: 85 };

io.on('connection', (socket) => {
    socket.on('auth', async (data) => {
        if (!data.wallet) return;
        socket.wallet = data.wallet; socket.join(data.wallet);
        let user = await User.findOne({ wallet: data.wallet });
        if (!user) {
            user = new User({ wallet: data.wallet, tgId: data.id, username: data.username, name: data.name, photo: data.photo });
            await user.save();
        } else {
            user.name = data.name; user.photo = data.photo; user.username = data.username; await user.save();
        }
        
        // Начисление стейкинга
        let earned = 0;
        user.inventory.forEach(i => {
            if (i.isStaked && i.stakeStart) {
                let diff = (new Date() - new Date(i.stakeStart)) / (1000 * 60 * 60 * 24);
                earned += (i.price * 0.001) * diff;
                i.stakeStart = new Date();
            }
        });
        if (earned > 0) { user.balance += earned; user.totalFarmed += earned; await user.save(); }
        socket.emit('updateUserData', user);
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning || !socket.wallet) return;
        const amt = parseFloat(data.bet);
        const user = await User.findOne({ wallet: socket.wallet });
        if (user && user.balance >= amt && amt > 0) {
            user.balance -= amt; await user.save();
            gameState.players.push({ wallet: user.wallet, name: user.name, photo: user.photo, bet: amt, color: `hsl(${Math.random()*360}, 70%, 60%)` });
            gameState.bank += amt;
            socket.emit('updateUserData', user);
            io.emit('sync', { ...gameState, onlineCount: io.engine.clientsCount });
            if (gameState.players.length >= 2 && gameState.timeLeft === 0) startTimer();
        }
    });

    socket.on('adminGive', async (data) => {
        const admin = await User.findOne({ wallet: socket.wallet });
        if (admin.username !== ADMIN_USERNAME) return;
        const target = await User.findOne({ username: data.user.replace('@','') });
        if (!target) return;
        if (GIFT_MARKET[data.amt]) {
            target.inventory.push({ itemId: Date.now().toString(), name: data.amt, image: GIFT_MARKET[data.amt].img, price: GIFT_MARKET[data.amt].price, isStaked: false });
        } else {
            target.balance += parseFloat(data.amt);
        }
        await target.save();
        io.to(target.wallet).emit('updateUserData', target);
    });

    socket.on('toggleStake', async (itemId) => {
        const user = await User.findOne({ wallet: socket.wallet });
        const item = user.inventory.find(i => i.itemId === itemId);
        if (item) {
            item.isStaked = !item.isStaked;
            item.stakeStart = item.isStaked ? new Date() : null;
            await user.save(); socket.emit('updateUserData', user);
        }
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
    const rake = gameState.bank * 0.05;
    const winNet = gameState.bank - rake;

    setTimeout(async () => {
        await User.findOneAndUpdate({ wallet: winner.wallet }, { $inc: { balance: winNet } });
        await User.findOneAndUpdate({ username: ADMIN_USERNAME }, { $inc: { balance: rake } });
        io.emit('winnerUpdate', { winner, winAmount: winNet });
        gameState = { players: [], bank: 0, isSpinning: false, timeLeft: 0, tapeLayout: [], winnerIndex: 85 };
        setTimeout(() => io.emit('sync', gameState), 1000);
    }, 11000);
}
