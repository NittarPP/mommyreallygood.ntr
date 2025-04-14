require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { randomBytes } = require('node:crypto');
const { 
    Client, 
    GatewayIntentBits, 
    REST, 
    Routes, 
    SlashCommandBuilder, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    ActivityType
} = require('discord.js');
const http = require('http');
const WebSocket = require('ws');

// ========== CONFIG ==========
const CONFIG = {
    SERVER_PORT: process.env.PORT || 3000
};

const logger = {
    info: (...args) => console.log(`[INFO] ${new Date().toISOString()}`, ...args),
    warn: (...args) => console.warn(`[WARN] ${new Date().toISOString()}`, ...args),
    error: (...args) => console.error(`[ERROR] ${new Date().toISOString()}`, ...args),
    debug: (...args) => console.debug(`[DEBUG] ${new Date().toISOString()}`, ...args)
};

// ========== VALIDATE ENV ==========
if (!process.env.TOKEN || !process.env.CLIENT_ID) {
    logger.error('Missing required environment variables (TOKEN, CLIENT_ID)');
    process.exit(1);
}

// ========== GLOBAL STATE ==========
let userCount = 0;
const channelUpdateQueue = [];

// ========== CLIENT ==========
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.DirectMessages, 
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ] 
});

// ========== BOT INIT ==========
async function initialize() {
    try {
        await loadUserCount();

        const wss = setupWebSocketServer();

        const server = http.createServer(async (req, res) => {
            try {
                if (req.url === '/keepalive') {
                    res.writeHead(200, { 'Content-Type': 'text/plain' });
                    res.end('Bot is alive!');
                } else if (req.url === '/userupdate.dataserver') {
                    await handleUserUpdate(req, res, wss);
                } else {
                    res.writeHead(404, { 'Content-Type': 'text/plain' });
                    res.end('Not Found');
                }
            } catch (error) {
                logger.error('HTTP server error:', error);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Internal Server Error');
            }
        });

        // Attach WebSocket upgrade handling
        server.on('upgrade', (request, socket, head) => {
            wss.handleUpgrade(request, socket, head, ws => {
                wss.emit('connection', ws, request);
            });
        });

        server.listen(CONFIG.SERVER_PORT, () => {
            logger.info(`HTTP server running on port ${CONFIG.SERVER_PORT}`);
        });

        // Initial channel update
        setTimeout(() => {
            channelUpdateQueue.push(userCount);
            processChannelUpdateQueue(wss);
        }, 100);

        await registerCommands(); // Optional if you want to add slash commands
        await client.login(process.env.TOKEN);
    } catch (error) {
        logger.error('Initialization error:', error);
        process.exit(1);
    }
}

// ========== LOAD/SAVE USER COUNT ==========
async function loadUserCount() {
    try {
        const data = await fs.readFile('usercount.json', 'utf8');
        userCount = JSON.parse(data).count || 0;
        logger.info(`Loaded user count: ${userCount}`);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.error('Error loading user count:', error);
        }
    }
}

async function saveUserCount() {
    try {
        await fs.writeFile('usercount.json', JSON.stringify({ count: userCount }));
    } catch (error) {
        logger.error('Error saving user count:', error);
    }
}

setInterval(saveUserCount, 100);

// ========== WEBSOCKET SETUP ==========
function setupWebSocketServer() {
    const wss = new WebSocket.Server({ noServer: true });

    wss.on('connection', ws => {
        logger.info('New WebSocket connection');
        ws.send(JSON.stringify({ type: 'welcome', message: 'Connected to bot server' }));
    });

    return wss;
}

function processChannelUpdateQueue(wss) {
    while (channelUpdateQueue.length > 0) {
        const count = channelUpdateQueue.shift();
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'userCountUpdate', count }));
            }
        });
    }
}

// ========== HANDLE USER UPDATE ==========
async function handleUserUpdate(req, res, wss) {
    let body = '';
    for await (const chunk of req) body += chunk;

    try {
        const data = JSON.parse(body);
        if (typeof data.count === 'number') {
            userCount = data.count;
            channelUpdateQueue.push(userCount);
            processChannelUpdateQueue(wss);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, userCount }));
        } else {
            throw new Error('Invalid count');
        }
    } catch (error) {
        logger.error('Failed to handle user update:', error);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid data format' }));
    }
}

// ========== DISCORD STATUS ==========
const statusMessages = ["📃 Load Info", "👁 Watch Discord", "tralalelo tralala🔥"];
const statusTypes = ['dnd', 'idle'];
let currentStatusIndex = 0;
let currentTypeIndex = 0;

function updateStatus() {
    const currentStatus = statusMessages[currentStatusIndex];
    const currentType = statusTypes[currentTypeIndex];
    client.user.setPresence({
        activities: [{ name: currentStatus, type: ActivityType.Custom }],
        status: currentType,
    });
    console.log('\x1b[33m[ STATUS ]\x1b[0m', `Updated status to: ${currentStatus} (${currentType})`);
    currentStatusIndex = (currentStatusIndex + 1) % statusMessages.length;
    currentTypeIndex = (currentTypeIndex + 1) % statusTypes.length;
}

setInterval(() => {
    if (client.isReady()) updateStatus();
}, 10000);

// ========== READY EVENT ==========
client.once('ready', () => {
    logger.info(`Bot is online as ${client.user.tag}`);
});

// ========== REGISTER COMMANDS (Optional) ==========
async function registerCommands() {
    // Example command registration if needed
    // You can leave this empty or add real commands later
    logger.info('No slash commands registered.');
}

// ========== START ==========
initialize();
