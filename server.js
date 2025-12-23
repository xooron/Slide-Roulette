const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_USERNAME = 'maesexs';

// Цены Fragment: Stars -> TON
const PACKAGES = {
    50: 1.25,
    100: 2.50,
    250: 6.25,
    500: 12.50,
    1000: 25.00,
    2500: 62.50
};

const app = express();
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.static(__dirname));

// ЗАПУСК СЕРВЕРА СРАЗУ (Важно для Render)
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`==> Server is running on port ${PORT}`);
});

const userSchema = new mongoose.Schema({
    wallet: { type: String, unique: true },
    tgId: String,
    username: String,
    balance: { type: Number, default: 0 },
    totalStakedIncome: { type: Number, default: 0 },
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

mongoose.connect(MONGODB_URI)
    .then(() => console.log("==> DB Connected Successfully"))
    .catch(err => console.error("==> DB Connection Error:", err));

// Расчет стейкинга (0.1% в день)
async function updateStaking(user) {
    let now = new Date();
    let earned = 0;
    let changed = false;

    user.inventory.forEach(item => {
        if (item.isStaked && item.stakeStart) {
            let diffMs = now - new Date(item.stakeStart);
            let diffDays = diffMs / (1000 * 60 * 60 * 24);
            if (diffDays > 0.0001) { // Начисляем даже за короткие периоды
                let yieldAmount = (item.price * 0.001) * diffDays;
                earned += yieldAmount;
                item.stakeStart = now;
                changed = true;
            }
        }
    });

    if (earned > 0) {
        user.balance += earned;
        user.totalStakedIncome += earned;
        await user.save();
    } else if (changed) {
        await user.save();
    }
    return user;
}

// Обработка платежей (Webhook)
app.post('/webhook', async (req, res) => {
    try {
        const update = req.body;
        if (update.pre_checkout_query) {
            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerPreCheckoutQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pre_checkout_query_id: update.pre_checkout_query.id, ok: true })
            });
        }
        if (update.message?.successful_payment) {
            const wallet = update.message.successful_payment.invoice_payload.split('_')[1];
            const stars = update.message.successful_payment.total_amount;
            const tonToAdd = PACKAGES[stars] || 0;
            const user = await User.findOneAndUpdate({ wallet }, { $inc: { balance: tonToAdd } }, { new: true });
            if (user) io.to(wallet).emit('updateUserData', user);
        }
    } catch (e) { console.error("Webhook Error:", e); }
    res.sendStatus(200);
});

let gameState = { bank: 0, players: [], isSpinning: false };

io.on('connection', (socket) => {
    socket.on('auth', async (data) => {
        if (!data.wallet) return;
        socket.join(data.wallet);
        socket.wallet = data.wallet;
        
        let user = await User.findOne({ wallet: data.wallet });
        if (!user) {
            user = new User({ wallet: data.wallet, tgId: data.tgId, username: data.username, balance: 0.1 });
            await user.save();
        }
        user = await updateStaking(user);
        socket.emit('updateUserData', user);
    });

    socket.on('toggleStake', async (itemId) => {
        if (!socket.wallet) return;
        let user = await User.findOne({ wallet: socket.wallet });
        if (!user) return;
        const item = user.inventory.find(i => i.itemId === itemId);
        if (item) {
            item.isStaked = !item.isStaked;
            item.stakeStart = item.isStaked ? new Date() : null;
            await user.save();
            socket.emit('updateUserData', user);
        }
    });

    socket.on('createInvoice', async (stars) => {
        if (!socket.wallet) return;
        try {
            const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: `Пополнение ${PACKAGES[stars]} TON`,
                    description: `Пакет ${stars} звезд (Fragment)`,
                    payload: `dep_${socket.wallet}`,
                    provider_token: "",
                    currency: "XTR",
                    prices: [{ label: "Stars", amount: stars }]
                })
            });
            const d = await res.json();
            if (d.ok) socket.emit('invoiceLink', { url: d.result });
        } catch (e) { console.error("Invoice Error:", e); }
    });

    socket.on('makeBet', async (data) => {
        if (gameState.isSpinning || !socket.wallet) return;
        const amt = parseFloat(data.bet);
        if (isNaN(amt) || amt <= 0) return;
        const user = await User.findOne({ wallet: socket.wallet });
        if (user && user.balance >= amt) {
            user.balance -= amt;
            await user.save();
            gameState.players.push({ wallet: user.wallet, name: user.username || 'User', bet: amt, photo: data.photo });
            gameState.bank += amt;
            socket.emit('updateUserData', user);
            io.emit('sync', gameState);
        }
    });
});
