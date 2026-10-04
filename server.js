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

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME;

if (!BOT_TOKEN) console.error("ОШИБКА: BOT_TOKEN не задан!");

const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
    db.run("PRAGMA journal_mode = WAL;");
    db.run("PRAGMA busy_timeout = 5000;");

    db.run(`CREATE TABLE IF NOT EXISTS guests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT UNIQUE,
        name TEXT,
        avatar_url TEXT DEFAULT '',
        count INTEGER DEFAULT 0,
        bombs INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`ALTER TABLE guests ADD COLUMN avatar_url TEXT DEFAULT ''`, () => {});
    db.run(`ALTER TABLE guests ADD COLUMN bombs INTEGER DEFAULT 0`, () => {});
    db.run(`ALTER TABLE guests ADD COLUMN wins INTEGER DEFAULT 0`, () => {});
});

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
    console.error(`[Telegram Polling Error] ${error.code || error.message}`);
});

const userStates = {};
const activeBattles = {}; 
let activeTicTacToe = null;

// Получение URL аватарки напрямую из Telegram
async function getTelegramAvatarUrl(userId) {
    try {
        const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
        if (photos && photos.photos && photos.photos.length > 0) {
            const fileId = photos.photos[0][0].file_id;
            const file = await bot.getFile(fileId);
            return `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
        }
    } catch (e) {
        console.error(`Не удалось подтянуть аватарку TG для ${userId}:`, e.message);
    }
    return '';
}

// Авто-обновление аватарки в базе данных
async function syncUserAvatar(tgId) {
    const avatarUrl = await getTelegramAvatarUrl(tgId);
    if (avatarUrl) {
        db.run(`UPDATE guests SET avatar_url = ? WHERE telegram_id = ?`, [avatarUrl, tgId], (err) => {
            if (!err) io.emit('update_board');
        });
    }
}

const mainMenuKeyboard = {
    reply_markup: {
        keyboard: [
            [{ text: "💬 Написать на ТВ" }, { text: "🎯 Кинуть реакцию" }],
            [{ text: "⚔️ Баттлы" }, { text: "🔥 Кто в баре" }],
            [{ text: "🏆 Мой профиль" }, { text: "📊 Топ бара" }]
        ],
        resize_keyboard: true
    }
};

bot.onText(/\/start|\/scan/, (msg) => {
    const chatId = msg.chat.id;
    const tgId = msg.from.id.toString();
    const text = msg.text || '';

    syncUserAvatar(tgId);

    if (text.includes('scan')) {
        handleScan(chatId, tgId, msg.from.first_name || 'Гость');
    } else {
        bot.sendMessage(chatId, `🍹 *Добро пожаловать на ДНО!*`, mainMenuKeyboard);
    }
});

function handleScan(chatId, tgId, defaultName) {
    db.get(`SELECT * FROM guests WHERE telegram_id = ?`, [tgId], async (err, guest) => {
        if (err) return console.error(err);
        const avatarUrl = await getTelegramAvatarUrl(tgId);

        if (!guest) {
            userStates[chatId] = { action: 'ENTER_NAME', tgId, defaultName, avatarUrl };
            bot.sendMessage(chatId, `🍹 *Добро пожаловать в бар НА ДНЕ!*\nКак тебя подписать на ТВ?`, {
                reply_markup: {
                    inline_keyboard: [[{ text: `Использовать "${defaultName}"`, callback_data: `use_default_name` }]]
                }
            });
        } else {
            db.run(`UPDATE guests SET count = count + 1, avatar_url = COALESCE(NULLIF(?, ''), avatar_url) WHERE id = ?`, [avatarUrl, guest.id], (err) => {
                if (err) return console.error(err);
                io.emit('update_board');
                bot.sendMessage(chatId, `🔥 *+1 ШОТ ЗАЧИСЛЕН!* Выпито: *${guest.count + 1}* шотов.`, mainMenuKeyboard);
            });
        }
    });
}

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const tgId = msg.from.id.toString();
    const text = msg.text ? msg.text.trim() : '';

    if (!text || text.startsWith('/')) return;

    const state = userStates[chatId];

    if (state && state.action === 'ENTER_NAME') {
        registerNewGuest(chatId, state.tgId, text, state.avatarUrl);
        return;
    }

    if (state && state.action === 'AWAITING_CHAT_MESSAGE') {
        delete userStates[chatId];
        db.get(`SELECT name FROM guests WHERE telegram_id = ?`, [tgId], (err, guest) => {
            const senderName = guest ? guest.name : (msg.from.first_name || 'Гость');
            io.emit('tv_chat_message', { sender: senderName, text });
            bot.sendMessage(chatId, `🚀 *Сообщение отправлено на ТВ-экран!*`, mainMenuKeyboard);
        });
        return;
    }

    if (text === "💬 Написать на ТВ") {
        userStates[chatId] = { action: 'AWAITING_CHAT_MESSAGE' };
        bot.sendMessage(chatId, `✍️️ *Напиши сообщение для ТВ:*`);
        return;
    }

    if (text === "🎯 Кинуть реакцию") {
        sendReactionTargetList(chatId, tgId);
        return;
    }

    if (text === "⚔️ Баттлы") {
        bot.sendMessage(chatId, `🎯 *ВЫБЕРИ ТИП БАТТЛА:*`, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "💣 Бомба на скорость", callback_data: "select_battle_type_bomb" }],
                    [{ text: "❌⭕ Крестики-Нолики", callback_data: "select_battle_type_ttt" }]
                ]
            }
        });
        return;
    }

    if (text === "🔥 Кто в баре") { sendGuestsList(chatId); return; }
    if (text === "🏆 Мой профиль") { sendUserProfile(chatId, tgId); return; }
    if (text === "📊 Топ бара") { sendLeaderboardList(chatId); return; }
});

function sendReactionTargetList(chatId, tgId) {
    db.all(`SELECT id, name FROM guests WHERE count > 0 OR bombs > 0 LIMIT 20`, [], (err, rows) => {
        if (err || !rows || rows.length === 0) {
            bot.sendMessage(chatId, "⚠️ В баре пока никого нет!", mainMenuKeyboard);
        } else {
            const buttons = rows.map(r => [{
                text: `🎯 Кинуть в: ${r.name}`,
                callback_data: `react_target_${r.id}_${r.name}`
            }]);
            bot.sendMessage(chatId, "🎯 *В КОГО БРОСАЕМ?*", {
                reply_markup: { inline_keyboard: buttons }
            });
        }
    });
}

function sendUserProfile(chatId, tgId) {
    syncUserAvatar(tgId);
    db.get(`SELECT * FROM guests WHERE telegram_id = ?`, [tgId], (err, guest) => {
        if (!guest) return bot.sendMessage(chatId, "⚠️ Сканируй QR у бармена для старта!", mainMenuKeyboard);
        const winrate = guest.bombs > 0 ? Math.round((guest.wins / guest.bombs) * 100) : 0;
        bot.sendMessage(chatId, `👤 *ТВОЙ ПРОФИЛЬ*\n\n🏷 *Имя:* ${guest.name}\n🍹 *Шотов:* ${guest.count}\n💣 *Дуэлей:* ${guest.bombs}\n👑 *Побед:* ${guest.wins}\n🎯 *Винрейт:* ${winrate}%`, mainMenuKeyboard);
    });
}

function sendGuestsList(chatId) {
    db.all(`SELECT name, count, bombs FROM guests WHERE count > 0 OR bombs > 0 ORDER BY count DESC LIMIT 15`, [], (err, rows) => {
        let text = "🔥 *СЕЙЧАС В БАРЕ:*\n\n";
        (rows || []).forEach((r, i) => text += `${i + 1}. *${r.name}* — ${r.count} шотов | 💣 ${r.bombs}\n`);
        bot.sendMessage(chatId, text || "В баре пока тихо.", mainMenuKeyboard);
    });
}

function sendLeaderboardList(chatId) {
    db.all(`SELECT name, count, wins FROM guests ORDER BY count DESC, wins DESC LIMIT 10`, [], (err, rows) => {
        let text = "📊 *ТОП-10 ЛИДЕРОВ:*\n\n";
        (rows || []).forEach((r, i) => text += `${i + 1}. *${r.name}* — ${r.count} шотов (👑 ${r.wins} побед)\n`);
        bot.sendMessage(chatId, text, mainMenuKeyboard);
    });
}

function showOpponentsList(chatId, tgId, type) {
    db.all(`SELECT id, name, telegram_id FROM guests WHERE (count > 0 OR bombs > 0) AND telegram_id != ? LIMIT 15`, [tgId], (err, rows) => {
        if (!rows || rows.length === 0) {
            bot.sendMessage(chatId, "⚠️ Нет доступных соперников!");
        } else {
            const buttons = rows.map(r => [{
                text: `⚔️ Вызвать: ${r.name}`,
                callback_data: `challenge_${type}_${r.telegram_id}_${r.name}`
            }]);
            bot.sendMessage(chatId, `🎯 *ВЫБЕРИ СОПЕРНИКА:*`, {
                reply_markup: { inline_keyboard: buttons }
            });
        }
    });
}

bot.on('callback_query', (query) => {
    const chatId = query.message.chat.id;
    const tgId = query.from.id.toString();
    const data = query.data;

    const state = userStates[chatId];
    if (data === 'use_default_name' && state) {
        registerNewGuest(chatId, state.tgId, state.defaultName, state.avatarUrl);
        bot.answerCallbackQuery(query.id).catch(() => {});
        return;
    }

    if (data.startsWith('react_target_')) {
        const parts = data.split('_');
        const targetId = parts[2];
        const targetName = parts[3];

        bot.sendMessage(chatId, `🚀 *ЧЕМ КИДАЕМ В ${targetName.toUpperCase()}?*`, {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "🍅 Помидор", callback_data: `throw_🍅_${targetId}` },
                        { text: "💵 Деньги", callback_data: `throw_💵_${targetId}` },
                        { text: "🍺 Пиво", callback_data: `throw_🍺_${targetId}` }
                    ],
                    [
                        { text: "💩 Какашка", callback_data: `throw_💩_${targetId}` },
                        { text: "💖 Сердечко", callback_data: `throw_💖_${targetId}` }
                    ]
                ]
            }
        });
        bot.answerCallbackQuery(query.id).catch(() => {});
        return;
    }

    if (data.startsWith('throw_')) {
        const parts = data.split('_');
        const item = parts[1];
        const targetId = parts[2];

        db.get(`SELECT id, name FROM guests WHERE telegram_id = ?`, [tgId], (err, sender) => {
            const senderId = sender ? sender.id : null;
            const senderName = sender ? sender.name : 'Аноним';

            io.emit('throw_reaction', { item, senderId, senderName, targetId });
            bot.sendMessage(chatId, `🎯 *${item} полетел в цель! Смотри на экран ТВ!*`, mainMenuKeyboard);
        });
        bot.answerCallbackQuery(query.id).catch(() => {});
        return;
    }

    if (data === 'select_battle_type_bomb') { showOpponentsList(chatId, tgId, 'bomb'); bot.answerCallbackQuery(query.id).catch(() => {}); return; }
    if (data === 'select_battle_type_ttt') { showOpponentsList(chatId, tgId, 'ttt'); bot.answerCallbackQuery(query.id).catch(() => {}); return; }

    if (data.startsWith('challenge_')) {
        const parts = data.split('_');
        const type = parts[1];
        const targetTgId = parts[2];
        const targetName = parts[3];
        const battleId = `b_${Date.now()}`;

        db.get(`SELECT name FROM guests WHERE telegram_id = ?`, [tgId], (err, challenger) => {
            const challengerName = challenger ? challenger.name : 'Аноним';

            const timeoutTimer = setTimeout(() => {
                if (activeBattles[battleId] && !activeBattles[battleId].accepted) {
                    io.emit('battle_timeout', { challengerName, targetName });
                    bot.sendMessage(tgId, `⏱ *${targetName} не успел ответить на вызов за 5 секунд!*`);
                    bot.sendMessage(targetTgId, `⏱ *Время на принятие вызова от ${challengerName} истекло!*`);
                    delete activeBattles[battleId];
                }
            }, 5000);

            activeBattles[battleId] = { 
                battleId, 
                type, 
                challengerTgId: tgId, 
                challengerName, 
                targetTgId, 
                targetName,
                timeoutTimer,
                accepted: false
            };

            if (type === 'bomb') {
                io.emit('battle_announced', activeBattles[battleId]);
                bot.sendMessage(targetTgId, `🚨 *ВНИМАНИЕ! (5 секунд)*\nГость *${challengerName}* вызывает тебя на *БОМБУ НА СКОРОСТЬ*! 💣`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🔥 ПРИНЯТЬ ВЫЗОВ (5с) ⚔️", callback_data: `accept_bomb_${battleId}` }],
                            [{ text: "🐓 Зассал / Отмена", callback_data: `decline_battle_${battleId}` }]
                        ]
                    }
                });
            } else if (type === 'ttt') {
                io.emit('ttt_announced', activeBattles[battleId]);
                bot.sendMessage(targetTgId, `🚨 *ВНИМАНИЕ! (5 секунд)*\nГость *${challengerName}* вызывает тебя в *КРЕСТИКИ-НОЛИКИ* ❌⭕!`, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "⚔️ ПРИНЯТЬ БОЙ (5с) ❌⭕", callback_data: `accept_ttt_${battleId}` }],
                            [{ text: "🐓 Зассал / Отмена", callback_data: `decline_battle_${battleId}` }]
                        ]
                    }
                });
            }

            bot.sendMessage(chatId, `💣 Вызов брошен игроку *${targetName}*! У него 5 секунд!`);
        });
        bot.answerCallbackQuery(query.id).catch(() => {});
    }

    if (data.startsWith('accept_bomb_')) {
        const battleId = data.replace('accept_bomb_', '');
        const battle = activeBattles[battleId];
        if (battle) {
            battle.accepted = true;
            clearTimeout(battle.timeoutTimer);

            io.emit('battle_accepted', battle);
            bot.sendMessage(battle.challengerTgId, `🎉 *${battle.targetName} ПРИНЯЛ ТВОЙ ВЫЗОВ!* Бегом к стойке!`);
            bot.sendMessage(chatId, `🔥 *ТЫ ПРИНЯЛ ВЫЗОВ!* Марш к стойке!`);
        } else {
            bot.sendMessage(chatId, `⏱ *Время на принятие вызова уже истекло!*`);
        }
        bot.answerCallbackQuery(query.id).catch(() => {});
    }

    if (data.startsWith('accept_ttt_')) {
        const battleId = data.replace('accept_ttt_', '');
        const battle = activeBattles[battleId];
        if (battle) {
            battle.accepted = true;
            clearTimeout(battle.timeoutTimer);

            activeTicTacToe = {
                battleId,
                playerX: { tgId: battle.challengerTgId, name: battle.challengerName },
                playerO: { tgId: battle.targetTgId, name: battle.targetName },
                board: Array(9).fill(" "),
                turn: 'X'
            };
            io.emit('ttt_started', activeTicTacToe);
            sendTicTacToeBoard(activeTicTacToe.playerX.tgId);
            sendTicTacToeBoard(activeTicTacToe.playerO.tgId);
        } else {
            bot.sendMessage(chatId, `⏱ *Время на принятие вызова уже истекло!*`);
        }
        bot.answerCallbackQuery(query.id).catch(() => {});
    }

    if (data.startsWith('decline_battle_')) {
        const battleId = data.replace('decline_battle_', '');
        const battle = activeBattles[battleId];
        if (battle) {
            clearTimeout(battle.timeoutTimer);
            io.emit('battle_declined', battle);
            bot.sendMessage(battle.challengerTgId, `🐔 *${battle.targetName} слился с баттла...*`);
            bot.sendMessage(chatId, `🚫 Вызов отклонен.`);
            delete activeBattles[battleId];
        }
        bot.answerCallbackQuery(query.id).catch(() => {});
    }

    if (data.startsWith('ttt_move_')) {
        const cellIndex = parseInt(data.replace('ttt_move_', ''));
        if (!activeTicTacToe) return bot.answerCallbackQuery(query.id, { text: "Игра завершена." }).catch(() => {});

        const currentTurnTgId = activeTicTacToe.turn === 'X' ? activeTicTacToe.playerX.tgId : activeTicTacToe.playerO.tgId;

        if (tgId !== currentTurnTgId) {
            return bot.answerCallbackQuery(query.id, { text: "⏳ Сейчас ход соперника!", show_alert: true }).catch(() => {});
        }

        if (activeTicTacToe.board[cellIndex] !== " ") {
            return bot.answerCallbackQuery(query.id, { text: "⚠️ Клетка уже занята!" }).catch(() => {});
        }

        activeTicTacToe.board[cellIndex] = activeTicTacToe.turn;
        io.emit('ttt_update', activeTicTacToe);

        const winner = checkTicTacToeWinner(activeTicTacToe.board);

        if (winner) {
            handleTicTacToeEnd(winner);
        } else if (!activeTicTacToe.board.includes(" ")) {
            handleTicTacToeEnd('DRAW');
        } else {
            activeTicTacToe.turn = activeTicTacToe.turn === 'X' ? 'O' : 'X';
            sendTicTacToeBoard(activeTicTacToe.playerX.tgId);
            sendTicTacToeBoard(activeTicTacToe.playerO.tgId);
        }

        bot.answerCallbackQuery(query.id).catch(() => {});
    }
});

function sendTicTacToeBoard(targetTgId) {
    if (!activeTicTacToe) return;

    const isTurn = (activeTicTacToe.turn === 'X' && targetTgId === activeTicTacToe.playerX.tgId) ||
                   (activeTicTacToe.turn === 'O' && targetTgId === activeTicTacToe.playerO.tgId);

    const turnSymbol = activeTicTacToe.turn === 'X' ? '❌' : '⭕';
    const currentPlayerName = activeTicTacToe.turn === 'X' ? activeTicTacToe.playerX.name : activeTicTacToe.playerO.name;

    const keyboard = [];
    for (let i = 0; i < 3; i++) {
        const row = [];
        for (let j = 0; j < 3; j++) {
            const index = i * 3 + j;
            const val = activeTicTacToe.board[index];
            const display = val === 'X' ? '❌' : val === 'O' ? '⭕' : ' ';
            row.push({ text: display, callback_data: `ttt_move_${index}` });
        }
        keyboard.push(row);
    }

    const statusText = isTurn ? `👉 *ТВОЙ ХОД (${turnSymbol})!*` : `⏳ Ходит *${currentPlayerName}* (${turnSymbol})...`;

    bot.sendMessage(targetTgId, `❌⭕ *КРЕСТИКИ-НОЛИКИ*\n${activeTicTacToe.playerX.name} (❌) vs ${activeTicTacToe.playerO.name} (⭕)\n\n${statusText}`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    }).catch(() => {});
}

function checkTicTacToeWinner(b) {
    const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    for (let l of lines) {
        if (b[l[0]] !== " " && b[l[0]] === b[l[1]] && b[l[1]] === b[l[2]]) return b[l[0]];
    }
    return null;
}

function handleTicTacToeEnd(result) {
    if (result === 'DRAW') {
        io.emit('ttt_ended', { draw: true });
        bot.sendMessage(activeTicTacToe.playerX.tgId, "🤝 *НИЧЬЯ В КРЕСТИКАХ-НОЛИКАХ!*").catch(() => {});
        bot.sendMessage(activeTicTacToe.playerO.tgId, "🤝 *НИЧЬЯ В КРЕСТИКАХ-НОЛИКАХ!*").catch(() => {});
    } else {
        const winnerObj = result === 'X' ? activeTicTacToe.playerX : activeTicTacToe.playerO;
        const loserObj = result === 'X' ? activeTicTacToe.playerO : activeTicTacToe.playerX;

        db.run(`UPDATE guests SET wins = wins + 1 WHERE telegram_id = ?`, [winnerObj.tgId], () => {
            io.emit('update_board');
            io.emit('ttt_ended', { winnerName: winnerObj.name, draw: false });
            bot.sendMessage(winnerObj.tgId, `🏆 *ПОБЕДА В КРЕСТИКАХ-НОЛИКАХ!* Тебе зачислена 👑 +1 Победа!`).catch(() => {});
            bot.sendMessage(loserObj.tgId, `😢 *ПОРАЖЕНИЕ В КРЕСТИКАХ-НОЛИКАХ!* Победу одержал ${winnerObj.name}`).catch(() => {});
        });
    }

    if (activeTicTacToe && activeTicTacToe.battleId) {
        delete activeBattles[activeTicTacToe.battleId];
    }
    activeTicTacToe = null;
}

function registerNewGuest(chatId, tgId, name, avatarUrl) {
    delete userStates[chatId];
    db.run(`INSERT INTO guests (telegram_id, name, avatar_url, count, bombs, wins) VALUES (?, ?, ?, 1, 0, 0)`, [tgId, name, avatarUrl || ''], function(err) {
        io.emit('update_board');
        bot.sendMessage(chatId, `✅ *Отлично, ${name}!*`, mainMenuKeyboard);
    });
}

app.get('/api/leaderboard', (req, res) => {
    db.all(`SELECT id, name, avatar_url, count, bombs, wins FROM guests WHERE count > 0 OR bombs > 0 ORDER BY count DESC, wins DESC LIMIT 30`, [], (err, rows) => {
        if (err) res.status(500).json([]);
        else res.json(rows || []);
    });
});

app.post('/api/battle-winner', (req, res) => {
    const { winnerTgId, winnerName, loserTgId } = req.body;
    if (winnerTgId && loserTgId) {
        db.run(`UPDATE guests SET bombs = bombs + 1, wins = wins + 1 WHERE telegram_id = ?`, [winnerTgId], () => {
            db.run(`UPDATE guests SET bombs = bombs + 1 WHERE telegram_id = ?`, [loserTgId], () => {
                io.emit('update_board');
                io.emit('battle_winner_announcement', { winnerName });
                bot.sendMessage(winnerTgId, `🏆 *ПОБЕДА В БАТТЛЕ!*`).catch(() => {});
                bot.sendMessage(loserTgId, `💣 *БАТТЛ ЗАВЕРШЕН!*`).catch(() => {});
                res.json({ success: true });
            });
        });
    }
});

app.post('/api/reset', (req, res) => {
    db.run(`UPDATE guests SET count = 0, bombs = 0, wins = 0`, [], () => {
        io.emit('update_board');
        res.json({ success: true });
    });
});

app.get('/api/config', (req, res) => { res.json({ botUsername: BOT_USERNAME }); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
