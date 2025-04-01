require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('node:crypto');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const http = require('http');
const fetch = require('node-fetch');

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
const ADMIN_ROLE_ID = '1349042694776819763';
const CHANNEL_ID = '1356653521272963203';

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMessages] });

function loadData() {
    if (!fs.existsSync(DATA_FILE)) return {};
    try {
        const content = fs.readFileSync(DATA_FILE, 'utf8').trim();
        if (!content.startsWith('return {')) return {};

        const data = {};
        const keyRegex = /\["(.*?)"\] = {\s*userId = "(.*?)",\s*hwid = "(.*?)",\s*expiresAt = (\d+)\s*}/g;
        let match;
        
        while ((match = keyRegex.exec(content)) !== null) {
            data[match[1]] = { userId: match[2], hwid: match[3], expiresAt: parseInt(match[4], 10) };
        }

        return data;
    } catch (error) {
        console.error("Error parsing keys.lua, resetting data:", error);
        return {};
    }
}

function saveData(data) {
    let luaContent = 'return {\n';
    for (const key in data) {
        const entry = data[key];
        luaContent += `    ["${key}"] = { userId = "${entry.userId}", hwid = "${entry.hwid}", expiresAt = ${entry.expiresAt} },\n`;
    }
    luaContent += '}\n';
    fs.writeFileSync(DATA_FILE, luaContent);
}

function generateKey() {
    return `Photon-${randomBytes(8).toString('hex')}-${randomBytes(6).toString('hex')}`;
}

function formatExpirationTime(timestamp) {
    return new Date(timestamp).toLocaleString();
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
    
    if (updated) saveData(data);
}

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    setInterval(cleanExpiredKeys, 60 * 60 * 1000);
});

async function sendKeysLuaToChannel() {
    const channel = await client.channels.fetch(CHANNEL_ID).catch(console.error);
    if (channel) {
        channel.send({ content: 'Here is the updated keys.lua file:', files: [DATA_FILE] }).catch(console.error);
    }
}

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const userId = interaction.user.id;
    const hasRole = interaction.member.roles.cache.some(role => role.id === ADMIN_ROLE_ID);

    if (interaction.commandName === 'getkey') {
        const hwid = interaction.options.getString('hwid');
        let data = loadData();
        
        for (const key in data) {
            if (data[key].userId === userId) {
                return interaction.reply({ content: 'You already have a key!', ephemeral: true });
            }
            if (data[key].hwid === hwid) {
                return interaction.reply({ content: 'This HWID already has a key assigned!', ephemeral: true });
            }
        }

        const key = generateKey();
        data[key] = { userId, hwid, expiresAt: Date.now() + 86400000 };
        saveData(data);

        try {
            await interaction.user.send(`Your generated key: \`${key}\`\nExpires on: **${formatExpirationTime(data[key].expiresAt)}**`);
            await interaction.reply({ content: 'Key sent to your DMs!', ephemeral: true });
        } catch {
            await interaction.reply({ content: 'Failed to send DM. Enable DMs and try again.', ephemeral: true });
        }
        sendKeysLuaToChannel();
    }

    if (interaction.commandName === 'del' && hasRole) {
        const userIdToDelete = interaction.options.getString('userid');
        let data = loadData();
        const keyToDelete = Object.keys(data).find(key => data[key].userId === userIdToDelete);
        
        if (keyToDelete) {
            delete data[keyToDelete];
            saveData(data);
            await interaction.reply({ content: `Key for user ${userIdToDelete} deleted.`, ephemeral: true });
            sendKeysLuaToChannel();
        } else {
            await interaction.reply({ content: 'No key found for that user.', ephemeral: true });
        }
    }

    if (interaction.commandName === 'checklist') {
        let data = loadData();
        if (Object.keys(data).length === 0) {
            return interaction.reply({ content: 'No keys found in the database.', ephemeral: true });
        }
        let keyList = 'Here is the list of all keys:\n\n';
        for (const key in data) {
            keyList += `**Key**: \`${key}\`\n**User ID**: <@${data[key].userId}>\n**HWID**: ${data[key].hwid}\n**Expires At**: ${formatExpirationTime(data[key].expiresAt)}\n\n`;
        }
        await interaction.reply({ content: keyList, ephemeral: true });
    }
});

async function registerCommands() {
    const commands = [
        new SlashCommandBuilder().setName('getkey').setDescription('Generates a Photon key')
            .addStringOption(option => option.setName('hwid').setDescription('Enter your HWID').setRequired(true)),
        new SlashCommandBuilder().setName('del').setDescription('Delete a key by user ID')
            .addStringOption(option => option.setName('userid').setDescription('User ID to delete').setRequired(true)),
        new SlashCommandBuilder().setName('checklist').setDescription('View all keys in the database')
    ].map(command => command.toJSON());

    await new REST({ version: '10' }).setToken(TOKEN).put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Commands registered.');
}

registerCommands();
const PORT = 8080;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot is alive!');
}).listen(PORT);

setInterval(() => { http.get(`http://localhost:${PORT}/keepalive`).on('error', console.error); }, 10 * 60 * 1000);
client.login(TOKEN);
