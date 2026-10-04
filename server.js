const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Берем ключи из переменных окружения (Environment Variables) на Render
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME;

if (!BOT_TOKEN) {
    console.error("ОШИБКА: Не задан BOT_TOKEN в переменных окружения!");
}

// 1. БАЗА ДАННЫХ SQLite
const db = new sqlite3.Database('./database.sqlite');

db.run(`CREATE TABLE IF NOT EXISTS guests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id TEXT UNIQUE,
    name TEXT,
    count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

// 2. TELEGRAM-БОТ
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const userStates = {};

bot.onText(/\/start scan|\/scan/, (msg) => {
    const chatId = msg.chat.id;
    const tgId = msg.from.id.toString();
    const defaultName = msg.from.first_name || 'Гость';

    db.get(`SELECT * FROM guests WHERE telegram_id = ?`, [tgId], (err, guest) => {
        if (!guest) {
            // Новый гость — просим вписать имя
            userStates[chatId] = { tgId, defaultName };
            bot.sendMessage(chatId, `🍹 *Добро пожаловать в бар!*\n\nКак вас подписать на экране ТВ? Напишите имя в чат или нажмите кнопку ниже:`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: `Использовать имя "${defaultName}"`, callback_data: `use_default_name` }
                    ]]
                }
            });
        } else {
            // Гость уже заходил — автоматически +1 шот
            db.run(`UPDATE guests SET count = count + 1 WHERE id = ?`, [guest.id], () => {
                const newCount = guest.count + 1;
                io.emit('update_board');

                bot.sendMessage(chatId, `🔥 *+1 ШОТ ЗАЧИСЛЕН!*\n\nС возвращением, *${guest.name}*!\nВсего выпито: *${newCount}* шотов.\nСмотрите на табло в баре!`, {
                    parse_mode: 'Markdown'
                });
            });
        }
    });
});

bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const state = userStates[chatId];

    if (query.data === 'use_default_name' && state) {
        registerNewGuest(chatId, state.tgId, state.defaultName);
        bot.answerCallbackQuery(query.id);
    }
});

bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const state = userStates[chatId];

    if (state && msg.text && !msg.text.startsWith('/')) {
        const customName = msg.text.trim();
        registerNewGuest(chatId, state.tgId, customName);
    }
});

function registerNewGuest(chatId, tgId, name) {
    delete userStates[chatId];
    db.run(`INSERT INTO guests (telegram_id, name, count) VALUES (?, ?, 1)`, [tgId, name], function(err) {
        io.emit('update_board');
        bot.sendMessage(chatId, `✅ *Отлично, ${name}!*\n\nВы зарегистрированы. Вам зачислен ваш *1-й шот*! 🎉\nПри следующем заказе просто сканируйте QR у бармена.`, {
            parse_mode: 'Markdown'
        });
    });
}

// 3. API Маршруты
app.get('/api/leaderboard', (req, res) => {
    db.all(`SELECT id, name, count FROM guests WHERE count > 0 ORDER BY count DESC`, [], (err, rows) => {
        if (err) res.status(500).json({ error: err.message });
        else res.json(rows);
    });
});

app.post('/api/reset', (req, res) => {
    db.run(`UPDATE guests SET count = 0`, [], () => {
        io.emit('update_board');
        res.json({ success: true });
    });
});

app.get('/api/config', (req, res) => {
    res.json({ botUsername: BOT_USERNAME });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});