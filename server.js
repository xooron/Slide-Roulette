const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_USERNAME = 'maesexs';

// База данных подарков с официальными анимированными ресурсами (webm/stickers)
const GIFT_MARKET = {
    "Lollipop": { price: 500, img: "https://stickerswiki.ams3.cdn.digitaloceanspaces.com/Gifts/4765452.160.webm" },
    "Rose": { price: 200, img: "https://stickerswiki.ams3.cdn.digitaloceanspaces.com/Gifts/4765455.160.webm" },
    "Diamond": { price: 2500, img: "https://stickerswiki.ams3.cdn.digitaloceanspaces.com/Gifts/4765448.160.webm" },
    "Cake": { price: 1000, img: "https://stickerswiki.ams3.cdn.digitaloceanspaces.com/Gifts/4765461.160.webm" },
    "Heart": { price: 1500, img: "https://stickerswiki.ams3.cdn.digitaloceanspaces.com/Gifts/4765445.160.webm" }
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

// Функция расчета дохода стейкинга (0.1% в час от цены)
function calculateStake(user) {
    if (!user.inventory) return 0;
    let total = 0;
    const now = new Date();
    user.inventory.forEach(item => {
        if (item.isStaked && item.stakeStart) {
            const hours = (now - new Date(item.stakeStart)) / 3600000;
            total += Math.floor(item.price * 0.001 * hours);
        }
    });
    return total;
}

io.on('connection', (socket) => {
    socket.on('auth', async (userData) => {
        if (!userData?.id) return;
        const sId = userData.id.toString();
        socket.join(sId);
        socket.userId = sId;
        let user = await User.findOne({ userId: sId });
        if (!user) {
            user = new User({ userId: sId, username: userData.username, name: userData.name, referredBy: userData.start_param, balance: 10 });
            await user.save();
        }
        user = user.toObject();
        user.stakingIncome = calculateStake(user);
        socket.emit('updateUserData', user);
    });

    // Выдача NFT через админку
    socket.on('adminGiveGift', async (data) => {
        const admin = await User.findOne({ userId: socket.userId });
        if (admin?.username !== ADMIN_USERNAME) return;
        const gift = GIFT_MARKET[data.giftName];
        if (!gift) return;

        const target = await User.findOneAndUpdate(
            { username: new RegExp(`^${data.targetUsername.replace('@','')}$`, "i") },
            { $push: { inventory: { itemId: Date.now().toString(), name: data.giftName, image: gift.img, price: gift.price } } },
            { new: true }
        );
        if (target) io.to(target.userId).emit('updateUserData', target);
    });

    socket.on('adminGiveStars', async (data) => {
        const admin = await User.findOne({ userId: socket.userId });
        if (admin?.username !== ADMIN_USERNAME) return;
        const amt = parseInt(data.amount);
        if (isNaN(amt)) return;

        const target = await User.findOneAndUpdate(
            { username: new RegExp(`^${data.targetUsername.replace('@','')}$`, "i") },
            { $inc: { balance: amt } },
            { new: true }
        );
        if (target) io.to(target.userId).emit('updateUserData', target);
    });

    socket.on('toggleStake', async (itemId) => {
        let user = await User.findOne({ userId: socket.userId });
        if (!user) return;
        const item = user.inventory.find(i => i.itemId === itemId);
        if (!item) return;

        const newState = !item.isStaked;
        await User.updateOne(
            { userId: socket.userId, "inventory.itemId": itemId },
            { $set: { "inventory.$.isStaked": newState, "inventory.$.stakeStart": newState ? new Date() : null } }
        );
        user = await User.findOne({ userId: socket.userId });
        const userData = user.toObject();
        userData.stakingIncome = calculateStake(userData);
        socket.emit('updateUserData', userData);
    });

    // Остальные функции (makeBet, exchangeNFT, createInvoice) остаются без изменений...
    socket.on('makeBet', async (data) => {
        if (!socket.userId) return;
        const amt = parseInt(data.bet);
        const user = await User.findOne({ userId: socket.userId });
        if (!user || user.balance < amt) return;
        await User.updateOne({ userId: socket.userId }, { $inc: { balance: -amt } });
        // ... (логика игры)
    });
});

// Запуск сервера (оставил как в оригинале)
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server started`));
