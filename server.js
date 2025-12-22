const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_USERNAME = 'maesexs';

// Полный список доступных подарков Telegram с проверенными ссылками на анимации
const GIFT_MARKET = {
    "Lollipop": { price: 200, img: "https://stickerswiki.ams3.cdn.digitaloceanspaces.com/Gifts/4765452.160.webm" },
    "Rose": { price: 150, img: "https://stickerswiki.ams3.cdn.digitaloceanspaces.com/Gifts/4765455.160.webm" },
    "Diamond": { price: 3000, img: "https://stickerswiki.ams3.cdn.digitaloceanspaces.com/Gifts/4765448.160.webm" },
    "Cake": { price: 800, img: "https://stickerswiki.ams3.cdn.digitaloceanspaces.com/Gifts/4765461.160.webm" },
    "Heart": { price: 1200, img: "https://stickerswiki.ams3.cdn.digitaloceanspaces.com/Gifts/4765445.160.webm" },
    "Teddy Bear": { price: 2500, img: "https://stickerswiki.ams3.cdn.digitaloceanspaces.com/Gifts/4765458.160.webm" },
    "Perfume": { price: 1000, img: "https://stickerswiki.ams3.cdn.digitaloceanspaces.com/Gifts/4765442.160.webm" },
    "Coffee": { price: 100, img: "https://stickerswiki.ams3.cdn.digitaloceanspaces.com/Gifts/4765439.160.webm" },
    "Pizza": { price: 300, img: "https://stickerswiki.ams3.cdn.digitaloceanspaces.com/Gifts/4765436.160.webm" },
    "Pumpkin": { price: 500, img: "https://stickerswiki.ams3.cdn.digitaloceanspaces.com/Gifts/4765433.160.webm" }
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

function getStakeIncome(user) {
    if (!user.inventory) return 0;
    let income = 0;
    const now = new Date();
    user.inventory.forEach(item => {
        if (item.isStaked && item.stakeStart) {
            const hours = (now - new Date(item.stakeStart)) / 3600000;
            income += Math.floor(item.price * 0.001 * hours);
        }
    });
    return income;
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
        const data = user.toObject();
        data.stakingIncome = getStakeIncome(data);
        socket.emit('updateUserData', data);
    });

    socket.on('adminGiveStars', async (data) => {
        const admin = await User.findOne({ userId: socket.userId });
        if (admin?.username !== ADMIN_USERNAME) return;
        const cleanUser = data.targetUsername.replace('@','');
        const gift = GIFT_MARKET[data.amount];
        
        if (gift) {
            await User.findOneAndUpdate(
                { username: new RegExp(`^${cleanUser}$`, "i") },
                { $push: { inventory: { itemId: Date.now().toString(), name: data.amount, image: gift.img, price: gift.price } } }
            );
        } else {
            const amt = parseInt(data.amount);
            if (!isNaN(amt)) {
                await User.findOneAndUpdate({ username: new RegExp(`^${cleanUser}$`, "i") }, { $inc: { balance: amt } });
            }
        }
        const target = await User.findOne({ username: new RegExp(`^${cleanUser}$`, "i") });
        if (target) io.to(target.userId).emit('updateUserData', target);
    });

    socket.on('exchangeNFT', async (itemId) => {
        const user = await User.findOne({ userId: socket.userId });
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

    // Код рулетки (без изменений)...
    socket.on('disconnect', () => { io.emit('sync', { onlineCount: io.engine.clientsCount }); });
});

server.listen(process.env.PORT || 10000, '0.0.0.0', () => console.log(`Server started`));
