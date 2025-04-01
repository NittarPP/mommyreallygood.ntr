require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { randomBytes } = require('node:crypto');
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const http = require('http');

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

    // Handling `/getkey` command
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

        await interaction.reply({ content: 'Generating your key... Please wait.', ephemeral: true });

        await interaction.user.send(`Your generated key: \`${key}\`\nThis key will expire on: **${formatExpirationTime(expiresAt)}**`)
            .then(() => interaction.followUp({ content: 'Key sent to your DMs!', ephemeral: true }))
            .catch(() => interaction.followUp({ content: 'Failed to send DM. Please enable DMs and try again.', ephemeral: true }));
    }

    // Handling `/del` command
    if (interaction.commandName === 'del') {
        const userIdToDelete = interaction.options.getString('userid');
        const userRole = interaction.member.roles.cache.has('1349042694776819763'); // Check if the user has the required role

        if (!userRole) {
            return interaction.reply({ content: 'You do not have the necessary role to delete a user\'s key.', ephemeral: true });
        }

        let data = loadData();
        const keyToDelete = Object.keys(data).find(key => data[key].userId === userIdToDelete);

        if (!keyToDelete) {
            return interaction.reply({ content: 'No key found for the provided user ID.', ephemeral: true });
        }

        // Delete the key from the database
        delete data[keyToDelete];
        saveData(data);

        return interaction.reply({ content: `Key for user ${userIdToDelete} has been removed successfully.`, ephemeral: true });
    }

    // Handling `/checklist` command
    if (interaction.commandName === 'checklist') {
        let data = loadData();

        if (Object.keys(data).length === 0) {
            return interaction.reply({ content: 'No keys found in the database.', ephemeral: true });
        }

        // Prepare a more user-friendly view of the keys
        let keyList = 'Here is the list of all keys:\n\n';
        for (const key in data) {
            keyList += `**Key**: \`${key}\`\n`;
            keyList += `**User ID**: ${data[key].userId}\n`;
            keyList += `**HWID**: ${data[key].hwid}\n`;
            keyList += `**Expires At**: ${formatExpirationTime(data[key].expiresAt)}\n\n`;
        }

        // Respond with the formatted keys list
        return interaction.reply({ content: keyList, ephemeral: true });
    }

    // Handling `/addkey` command (for privileged users with the specified role)
    if (interaction.commandName === 'addkey') {
        const userRole = interaction.member.roles.cache.has('1349042694776819763'); // Check if the user has the required role

        if (!userRole) {
            return interaction.reply({ content: 'You do not have the necessary role to add a key.', ephemeral: true });
        }

        const userId = interaction.options.getString('userid');
        const hwid = interaction.options.getString('hwid');

        let data = loadData();

        // Check if the user already has a key
        for (const key in data) {
            if (data[key].userId === userId) {
                return interaction.reply({ content: 'This user already has a key in the database!', ephemeral: true });
            }
            if (data[key].hwid === hwid) {
                return interaction.reply({ content: 'This HWID already has a key assigned!', ephemeral: true });
            }
        }

        const key = generateKey();
        const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours expiration time
        data[key] = { userId, hwid, expiresAt };
        saveData(data);

        // Send the generated key to the user via DM
        const user = await client.users.fetch(userId);
        if (user) {
            await user.send(`Your generated key: \`${key}\`\nThis key will expire on: **${formatExpirationTime(expiresAt)}**`)
                .then(() => interaction.reply({ content: `Key has been generated and sent to ${user.tag}'s DMs.`, ephemeral: true }))
                .catch(() => interaction.reply({ content: 'Failed to send DM to the user. Please ensure they have DMs enabled.', ephemeral: true }));
        } else {
            interaction.reply({ content: 'User not found, unable to send the key.', ephemeral: true });
        }
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
            ),
        new SlashCommandBuilder()
            .setName('del')
            .setDescription('Delete a key by user ID')
            .addStringOption(option => 
                option.setName('userid')
                .setDescription('Enter the user ID to delete')
                .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName('checklist')
            .setDescription('View all keys in the database'),
        new SlashCommandBuilder()
            .setName('addkey')
            .setDescription('Generates a key for a user without using /getkey')
            .addStringOption(option => 
                option.setName('userid')
                .setDescription('Enter the user ID')
                .setRequired(true)
            )
            .addStringOption(option => 
                option.setName('hwid')
                .setDescription('Enter the user\'s HWID')
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

const PORT = 8080;

const server = http.createServer((req, res) => {
    if (req.url === '/keepalive') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Bot is alive!');
    } else if (req.url === '/keys.lua') {
        fs.readFile(DATA_FILE, 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error reading keys.lua file');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'application/x-lua' });
            res.end(data);
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

setInterval(() => {
    http.get(`http://localhost:${PORT}/keepalive`, (res) => {
        console.log('Keepalive ping successful');
    }).on('error', (e) => {
        console.error(`Keepalive ping failed: ${e.message}`);
    });
}, 10 * 60);

client.login(TOKEN);
