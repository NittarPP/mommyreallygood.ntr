require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('node:crypto');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const http = require('http');  // Import the http module

const configPath = path.resolve(__dirname, 'config.json');
let config;

try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
    console.error('Error reading config.json:', error);
    process.exit(1);
}

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const DATA_FILE = path.resolve(__dirname, 'keys.lua');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMessages] });

function loadData() {
    if (fs.existsSync(DATA_FILE)) {
        try {
            const content = fs.readFileSync(DATA_FILE, 'utf8').trim();
            if (!content.startsWith('return {')) return {};

            const data = {};
            const keyRegex = /\["(.*?)"\] = {\s*userId = "(.*?)",\s*hwid = "(.*?)",\s*expiresAt = (\d+)\s*}/g;
            let match;
            
            while ((match = keyRegex.exec(content)) !== null) {
                data[match[1]] = {
                    userId: match[2],
                    hwid: match[3],
                    expiresAt: parseInt(match[4], 10)
                };
            }

            return data;
        } catch (error) {
            console.error("Error parsing keys.lua, resetting data:", error);
            return {};
        }
    }
    return {};
}

function saveData(data) {
    let luaContent = 'return {\n';
    for (const key in data) {
        const entry = data[key];
        luaContent += `    ["${key}"] = {\n        userId = "${entry.userId}",\n        hwid = "${entry.hwid}",\n        expiresAt = ${entry.expiresAt}\n    },\n`;
    }
    luaContent += '}\n';

    fs.writeFileSync(DATA_FILE, luaContent);
}

function generateKey() {
    return `Photon-${randomBytes(8).toString('hex')}-${randomBytes(6).toString('hex')}`;
}

function formatExpirationTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleString();
}

function cleanExpiredKeys() {
    let data = loadData();
    const now = Date.now();
    let updated = false;
    
    for (const key in data) {
        if (data[key].expiresAt && now >= data[key].expiresAt) {
            delete data[key];
            updated = true;
        }
    }
    
    if (updated) {
        saveData(data);
    }
}

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}!`);
    setInterval(cleanExpiredKeys, 60 * 60 * 1000);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    if (interaction.commandName === 'getkey') {
        const hwid = interaction.options.getString('hwid');
        const userId = interaction.user.id;
        
        let data = loadData();
        
        for (const key in data) {
            if (data[key].userId === userId) {
                return interaction.reply({ content: 'You already have a key in the database!', ephemeral: true });
            }
            if (data[key].hwid === hwid) {
                return interaction.reply({ content: 'This HWID already has a key assigned!', ephemeral: true });
            }
        }

        const key = generateKey();
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
        data[key] = { userId, hwid, expiresAt };
        saveData(data);

        await interaction.user.send(`Your generated key: \`${key}\`\nThis key will expire on: **${formatExpirationTime(expiresAt)}**`)
            .then(() => interaction.reply({ content: 'Key sent to your DMs!', ephemeral: true }))
            .catch(() => interaction.reply({ content: 'Failed to send DM. Please enable DMs and try again.', ephemeral: true }));
        
        return { key, hwid, expiresAt };
    }
});

async function registerCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('getkey')
            .setDescription('Generates a Photon key')
            .addStringOption(option => 
                option.setName('hwid')
                .setDescription('Enter your HWID')
                .setRequired(true)
            )
    ].map(command => command.toJSON());

    const rest = new REST({ version: '10' }).setToken(TOKEN);
    try {
        console.log('Registering slash commands...');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('Slash commands registered successfully!');
    } catch (error) {
        console.error(error);
    }
}

registerCommands();

// HTTP server to serve the keys.lua file
const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/keys.lua') {
        fs.readFile(DATA_FILE, 'utf8', (err, data) => {
            if (err) {
                res.statusCode = 500;
                res.end('Error reading keys.lua file');
                return;
            }
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/x-lua');
            res.end(data);
        });
    } else {
        res.statusCode = 404;
        res.end('Not Found');
    }
});

// Set the server to listen on a specific port (e.g., port 8080)
const PORT = 8080;
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

client.login(TOKEN);
