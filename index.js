require('dotenv').config();
const config = require('./bot_config');

process.env.BOT_TOKEN     = process.env.BOT_TOKEN     || config.BOT_TOKEN;
process.env.ADMIN_ROLE_ID = process.env.ADMIN_ROLE_ID || config.ADMIN_ROLE_ID;
process.env.WEBHOOK_URL   = process.env.WEBHOOK_URL   || config.WEBHOOK_URL;
process.env.API_PORT      = process.env.API_PORT      || config.API_PORT;
process.env.PROJECT_NAME  = process.env.PROJECT_NAME  || config.PROJECT_NAME || 'Yn';

const {
  Client, GatewayIntentBits, SlashCommandBuilder,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, PermissionsBitField, MessageFlags
} = require('discord.js');
const express   = require('express');
const rateLimit = require('express-rate-limit');
const axios     = require('axios');
const crypto    = require('crypto');
const fs        = require('fs');
const path      = require('path');

// GuildMembers intent จำเป็นสำหรับ Get Role
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const app = express();
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use('/auth', limiter);

// ─── JSON Database ─────────────────────────────────────────────────────────

const DB_KEYS   = path.join(__dirname, 'keys.json');
const DB_CONFIG = path.join(__dirname, 'guild_config.json');
// เก็บ key ที่ผูกกับ userId แล้ว  { userId: keyString }
const DB_USERS  = path.join(__dirname, 'users.json');

function readDB(file) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, '{}', 'utf8');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return {}; }
}
function writeDB(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ── Key helpers ──────────────────────────────────────────────────────────
function getKey(key) {
  const db = readDB(DB_KEYS);
  return db[key] || null;
}
function saveKey(keyDoc) {
  const db = readDB(DB_KEYS);
  db[keyDoc.key] = keyDoc;
  writeDB(DB_KEYS, db);
}
function deleteKey(key) {
  const db = readDB(DB_KEYS);
  if (!db[key]) return false;
  delete db[key];
  writeDB(DB_KEYS, db);
  // ── ลบ users.json entry ที่อ้างอิง key นี้ด้วย ────────────────────────
  const users = readDB(DB_USERS);
  for (const [uid, k] of Object.entries(users)) {
    if (k === key) delete users[uid];
  }
  writeDB(DB_USERS, users);
  return true;
}
function countKeys() {
  return Object.keys(readDB(DB_KEYS)).length;
}

// ── User binding helpers ─────────────────────────────────────────────────
function getUserKey(userId) {
  const db = readDB(DB_USERS);
  return db[userId] || null; // คืน key string หรือ null
}
function setUserKey(userId, keyString) {
  const db = readDB(DB_USERS);
  db[userId] = keyString;
  writeDB(DB_USERS, db);
}
function removeUserKey(userId) {
  const db = readDB(DB_USERS);
  delete db[userId];
  writeDB(DB_USERS, db);
}

// ── Guild Config helpers ─────────────────────────────────────────────────
function getGuildConfig(guildId) {
  const db = readDB(DB_CONFIG);
  return db[guildId] || { guildId, projectName: process.env.PROJECT_NAME, hwidCooldown: 60 };
}
function saveGuildConfig(guildId, data) {
  const db = readDB(DB_CONFIG);
  db[guildId] = { ...getGuildConfig(guildId), ...data };
  writeDB(DB_CONFIG, db);
}

console.log('📁 JSON Storage mode');
console.log(`   keys.json         → ${DB_KEYS}`);
console.log(`   guild_config.json → ${DB_CONFIG}`);
console.log(`   users.json        → ${DB_USERS}`);

// ─── Helpers ───────────────────────────────────────────────────────────────

async function sendWebhookEmbed(title, description, color = '#00ff00') {
  if (!process.env.WEBHOOK_URL || process.env.WEBHOOK_URL.includes('xxxxxxxx')) return;
  try {
    const embed = new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
    await axios.post(process.env.WEBHOOK_URL, { embeds: [embed.toJSON()] });
  } catch (err) {
    console.error('Webhook Error:', err.message);
  }
}

function isAdmin(interaction) {
  return interaction.member.roles.cache.has(process.env.ADMIN_ROLE_ID);
}

function makeModal(customId, title, fields) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  const rows = fields.map(f =>
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId(f.id)
        .setLabel(f.label)
        .setStyle(f.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(f.required !== false)
        .setPlaceholder(f.placeholder || '')
    )
  );
  modal.addComponents(...rows);
  return modal;
}

// ─── Dashboard Builder (Admin) ──────────────────────────────────────────────

function buildDashboardEmbed(guildId) {
  const cfg = getGuildConfig(guildId);
  const totalKeys = countKeys();

  const embed = new EmbedBuilder()
    .setTitle('👑  WHITELIST SERVICE  |  DASHBOARD')
    .setColor(0x2b2d31)
    .setDescription(
      '```\n' +
      '🔑  Generate Key\n' +
      '❌  Remove Key\n' +
      '🔍  Search Key\n' +
      '🌐  Webhook Settings\n' +
      '⏳  HWID Cooldown\n' +
      '⚙️  Configuration\n' +
      '```'
    )
    .addFields(
      { name: '🦅  Project Name', value: cfg.projectName || 'Yn', inline: true },
      { name: '⭐  All Keys',     value: `${totalKeys}`,           inline: true },
    )
    .setFooter({ text: 'Whitelist System • JSON Storage' })
    .setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_generatekey').setLabel('Generate Key').setEmoji('🔑').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_removekey').setLabel('Remove Key').setEmoji('❌').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('btn_searchkey').setLabel('Search Key').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_webhook').setLabel('Webhook Settings').setEmoji('🌐').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_hwid').setLabel('HWID Cooldown').setEmoji('⏳').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('btn_topup').setLabel('Top-up').setEmoji('💎').setStyle(ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_loader').setLabel('Loader Settings').setEmoji('🖥️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_buyerrole').setLabel('Buyer Role ID').setEmoji('👤').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_renew').setLabel('Renew Time').setEmoji('🕐').setStyle(ButtonStyle.Primary),
  );

  return { embeds: [embed], components: [row1, row2, row3] };
}

// ─── Buyer Panel Builder ────────────────────────────────────────────────────

function buildBuyerPanel(guildId) {
  const cfg = getGuildConfig(guildId);
  const projectName = cfg.projectName || process.env.PROJECT_NAME || 'Yn';

  const embed = new EmbedBuilder()
    .setTitle(`${projectName} Control Panel`)
    .setColor(0x2b2d31)
    .setDescription(
      `This control panel is for the project: **${projectName}**\n` +
      `If you're a buyer, click on the buttons below to manage your whitelist access!`
    )
    .setFooter({ text: `Send by ${projectName}` })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('buyer_redeem').setLabel('Redeem Key').setEmoji('🔑').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('buyer_getscript').setLabel('Get Script').setEmoji('📋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('buyer_getrole').setLabel('Get Role').setEmoji('👤').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('buyer_resethwid').setLabel('Reset HWID').setEmoji('🖥️').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

// ─── Slash Command Registration ────────────────────────────────────────────

client.once('clientReady', async () => {
  console.log(`✅ Bot Online: ${client.user.tag}`);

  const commands = [
    // Admin commands
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('ติดตั้ง Admin Dashboard ลงในช่องที่เลือก')
      .addChannelOption(opt =>
        opt.setName('channel').setDescription('ช่องที่จะวาง Dashboard')
          .addChannelTypes(ChannelType.GuildText).setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('buyersetup')
      .setDescription('ติดตั้ง Buyer Panel ลงในช่องที่เลือก')
      .addChannelOption(opt =>
        opt.setName('channel').setDescription('ช่องที่จะวาง Buyer Panel')
          .addChannelTypes(ChannelType.GuildText).setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName('generatekey')
      .setDescription('Generate a new key')
      .addStringOption(o => o.setName('project').setDescription('Project name').setRequired(false))
      .addIntegerOption(o => o.setName('days').setDescription('Expiration days').setRequired(false))
      .addIntegerOption(o => o.setName('uses').setDescription('Uses left (-1 = unlimited)').setRequired(false))
      .addIntegerOption(o => o.setName('cooldown').setDescription('HWID cooldown minutes').setRequired(false)),
    new SlashCommandBuilder()
      .setName('removekey').setDescription('Remove a key')
      .addStringOption(o => o.setName('key').setDescription('Key to remove').setRequired(true)),
    new SlashCommandBuilder()
      .setName('searchkey').setDescription('Search for a key')
      .addStringOption(o => o.setName('key').setDescription('Key to search').setRequired(true)),
    new SlashCommandBuilder()
      .setName('renew').setDescription('Renew a key')
      .addStringOption(o => o.setName('key').setDescription('Key to renew').setRequired(true))
      .addIntegerOption(o => o.setName('days').setDescription('Days to add').setRequired(true)),
    new SlashCommandBuilder()
      .setName('topup').setDescription('Top-up uses for a key')
      .addStringOption(o => o.setName('key').setDescription('Key to top-up').setRequired(true))
      .addIntegerOption(o => o.setName('uses').setDescription('Uses to add').setRequired(true)),
  ];

  await client.application.commands.set(commands);
  console.log('✅ Slash Commands Registered');
});

// ─── Interaction Handler ───────────────────────────────────────────────────

client.on('interactionCreate', async interaction => {

  // ══════════════════════════════════════════
  //  SLASH COMMANDS
  // ══════════════════════════════════════════
  if (interaction.isChatInputCommand()) {
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: '🚫 คุณไม่มีสิทธิ์ใช้คำสั่งนี้', flags: MessageFlags.Ephemeral });
    }

    const cmd = interaction.commandName;

    // /setup — Admin Dashboard
    if (cmd === 'setup') {
      const channel = interaction.options.getChannel('channel');
      if (!channel.permissionsFor(interaction.guild.members.me).has(PermissionsBitField.Flags.SendMessages)) {
        return interaction.reply({ content: `❌ บอทไม่มีสิทธิ์ส่งข้อความในช่อง ${channel}`, flags: MessageFlags.Ephemeral });
      }
      saveGuildConfig(interaction.guildId, {});
      await channel.send(buildDashboardEmbed(interaction.guildId));
      return interaction.reply({ content: `✅ วาง Admin Dashboard เรียบร้อยที่ ${channel}`, flags: MessageFlags.Ephemeral });
    }

    // /buyersetup — Buyer Panel
    if (cmd === 'buyersetup') {
      const channel = interaction.options.getChannel('channel');
      if (!channel.permissionsFor(interaction.guild.members.me).has(PermissionsBitField.Flags.SendMessages)) {
        return interaction.reply({ content: `❌ บอทไม่มีสิทธิ์ส่งข้อความในช่อง ${channel}`, flags: MessageFlags.Ephemeral });
      }
      await channel.send(buildBuyerPanel(interaction.guildId));
      return interaction.reply({ content: `✅ วาง Buyer Panel เรียบร้อยที่ ${channel}`, flags: MessageFlags.Ephemeral });
    }

    // /generatekey
    if (cmd === 'generatekey') {
      const project  = interaction.options.getString('project')   || process.env.PROJECT_NAME;
      const days     = interaction.options.getInteger('days')     || 7;
      const uses     = interaction.options.getInteger('uses')     ?? -1;
      const cooldown = interaction.options.getInteger('cooldown') || 60;
      const rawKey   = crypto.randomBytes(16).toString('hex');
      const key = `YN-${rawKey.slice(0,8).toUpperCase()}-${rawKey.slice(8,16).toUpperCase()}-${rawKey.slice(16,24).toUpperCase()}`;
      saveKey({ key, project, expires: new Date(Date.now() + days * 864e5).toISOString(), usesLeft: uses, cooldown, hwid: null, lastUsed: null, createdBy: interaction.user.tag, createdAt: new Date().toISOString() });
      await sendWebhookEmbed('🔑 New Key Generated', `Key: **${key}**\nProject: ${project}\nExpires: ${days} days\nBy: ${interaction.user.tag}`);
      return interaction.reply({ content: `✅ Key: \`${key}\`\nProject: ${project} | Expires: ${days}d | Uses: ${uses} | Cooldown: ${cooldown}m`, flags: MessageFlags.Ephemeral });
    }

    // /removekey
    if (cmd === 'removekey') {
      const key = interaction.options.getString('key');
      if (!deleteKey(key)) return interaction.reply({ content: '❌ ไม่พบ Key นี้', flags: MessageFlags.Ephemeral });
      await sendWebhookEmbed('🗑️ Key Removed', `Key: **${key}**\nBy: ${interaction.user.tag}`, '#ff0000');
      return interaction.reply({ content: `✅ ลบ Key \`${key}\` แล้ว`, flags: MessageFlags.Ephemeral });
    }

    // /searchkey
    if (cmd === 'searchkey') {
      const key = interaction.options.getString('key');
      const doc = getKey(key);
      if (!doc) return interaction.reply({ content: '❌ ไม่พบ Key นี้', flags: MessageFlags.Ephemeral });
      const embed = new EmbedBuilder().setTitle('🔍 Key Information').setColor(0x5865f2)
        .addFields(
          { name: 'Key',       value: `\`${doc.key}\``,                              inline: false },
          { name: 'Project',   value: doc.project,                                   inline: true  },
          { name: 'Expires',   value: new Date(doc.expires).toLocaleString(),        inline: true  },
          { name: 'HWID',      value: doc.hwid || 'ยังไม่ผูก',                        inline: true  },
          { name: 'Uses Left', value: doc.usesLeft === -1 ? '∞' : `${doc.usesLeft}`, inline: true  },
          { name: 'Cooldown',  value: `${doc.cooldown} นาที`,                        inline: true  },
          { name: 'Last Used', value: doc.lastUsed ? new Date(doc.lastUsed).toLocaleString() : 'ไม่เคยใช้', inline: true },
        ).setTimestamp();
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    // /renew
    if (cmd === 'renew') {
      const key  = interaction.options.getString('key');
      const days = interaction.options.getInteger('days');
      const doc  = getKey(key);
      if (!doc) return interaction.reply({ content: '❌ ไม่พบ Key นี้', flags: MessageFlags.Ephemeral });
      doc.expires = new Date(new Date(doc.expires).getTime() + days * 864e5).toISOString();
      saveKey(doc);
      await sendWebhookEmbed('🔄 Key Renewed', `Key: **${key}**\nเพิ่ม ${days} วัน\nBy: ${interaction.user.tag}`);
      return interaction.reply({ content: `✅ ต่ออายุ \`${key}\` อีก ${days} วัน | หมดอายุใหม่: ${new Date(doc.expires).toLocaleString()}`, flags: MessageFlags.Ephemeral });
    }

    // /topup
    if (cmd === 'topup') {
      const key  = interaction.options.getString('key');
      const uses = interaction.options.getInteger('uses');
      const doc  = getKey(key);
      if (!doc) return interaction.reply({ content: '❌ ไม่พบ Key นี้', flags: MessageFlags.Ephemeral });
      if (doc.usesLeft === -1) {
        return interaction.reply({ content: `⚠️ Key \`${key}\` ตั้งไว้เป็น **ไม่จำกัด** อยู่แล้ว ไม่ต้องเติมครับ`, flags: MessageFlags.Ephemeral });
      }
      doc.usesLeft += uses;
      saveKey(doc);
      await sendWebhookEmbed('💎 Key Top-Up', `Key: **${key}**\nเพิ่ม ${uses} uses\nBy: ${interaction.user.tag}`);
      return interaction.reply({ content: `✅ เติม \`${key}\` อีก ${uses} uses | ยังเหลือ: **${doc.usesLeft}**`, flags: MessageFlags.Ephemeral });
    }
  }

  // ══════════════════════════════════════════
  //  BUTTON
  // ══════════════════════════════════════════
  if (interaction.isButton()) {
    const id = interaction.customId;

    // ── Admin Buttons (ต้อง Admin เท่านั้น) ────────────────────────────────
    if (id.startsWith('btn_')) {
      if (!isAdmin(interaction)) {
        return interaction.reply({ content: '🚫 เฉพาะ Admin เท่านั้น', flags: MessageFlags.Ephemeral });
      }

      if (id === 'btn_generatekey') {
        return interaction.showModal(makeModal('modal_generatekey', '🔑 Generate Key', [
          { id: 'project',  label: 'Project Name',         placeholder: process.env.PROJECT_NAME },
          { id: 'days',     label: 'Expiration (วัน)',      placeholder: '7' },
          { id: 'uses',     label: 'Uses (-1 = ไม่จำกัด)', placeholder: '-1' },
          { id: 'cooldown', label: 'HWID Cooldown (นาที)', placeholder: '60' },
        ]));
      }
      if (id === 'btn_removekey') {
        return interaction.showModal(makeModal('modal_removekey', '❌ Remove Key', [
          { id: 'key', label: 'Key ที่ต้องการลบ', placeholder: 'YN-XXXXXXXX-XXXXXXXX-XXXXXXXX' },
        ]));
      }
      if (id === 'btn_searchkey') {
        return interaction.showModal(makeModal('modal_searchkey', '🔍 Search Key', [
          { id: 'key', label: 'Key ที่ต้องการค้นหา', placeholder: 'YN-XXXXXXXX-XXXXXXXX-XXXXXXXX' },
        ]));
      }
      if (id === 'btn_webhook') {
        const cfg = getGuildConfig(interaction.guildId);
        return interaction.showModal(makeModal('modal_webhook', '🌐 Webhook Settings', [
          { id: 'url', label: 'Discord Webhook URL', placeholder: cfg?.webhookUrl || 'https://discord.com/api/webhooks/...' },
        ]));
      }
      if (id === 'btn_hwid') {
        const cfg = getGuildConfig(interaction.guildId);
        return interaction.showModal(makeModal('modal_hwid', '⏳ HWID Cooldown', [
          { id: 'minutes', label: 'Cooldown (นาที)', placeholder: `${cfg?.hwidCooldown || 60}` },
        ]));
      }
      if (id === 'btn_topup') {
        return interaction.showModal(makeModal('modal_topup', '💎 Top-up Key', [
          { id: 'key',  label: 'Key',             placeholder: 'YN-XXXXXXXX-XXXXXXXX-XXXXXXXX' },
          { id: 'uses', label: 'Uses ที่จะเพิ่ม', placeholder: '10' },
        ]));
      }
      if (id === 'btn_loader') {
        const cfg = getGuildConfig(interaction.guildId);
        return interaction.showModal(makeModal('modal_loader', '🖥️ Loader Settings', [
          { id: 'url', label: 'Loader URL / Script Link', placeholder: cfg?.loaderUrl || 'https://...' },
        ]));
      }
      if (id === 'btn_buyerrole') {
        const cfg = getGuildConfig(interaction.guildId);
        return interaction.showModal(makeModal('modal_buyerrole', '👤 Buyer Role ID', [
          { id: 'roleid', label: 'Role ID (copy จาก Discord)', placeholder: cfg?.buyerRoleId || '123456789012345678' },
        ]));
      }
      if (id === 'btn_renew') {
        return interaction.showModal(makeModal('modal_renew', '🕐 Renew Key', [
          { id: 'key',  label: 'Key ที่ต้องการต่ออายุ', placeholder: 'YN-XXXXXXXX-XXXXXXXX-XXXXXXXX' },
          { id: 'days', label: 'จำนวนวันที่เพิ่ม',      placeholder: '7' },
        ]));
      }
    }

    // ── Buyer Buttons (ทุกคนกดได้) ─────────────────────────────────────────
    if (id.startsWith('buyer_')) {
      const userId = interaction.user.id;

      // 🔑 Redeem Key — กรอก Key แล้วผูกกับ User
      if (id === 'buyer_redeem') {
        return interaction.showModal(makeModal('modal_buyer_redeem', '🔑 Redeem Key', [
          { id: 'key', label: 'กรอก Key ของคุณ', placeholder: 'YN-XXXXXXXX-XXXXXXXX-XXXXXXXX' },
        ]));
      }

      // 📋 Get Script — ส่ง Loader URL ให้แบบ ephemeral
      if (id === 'buyer_getscript') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const boundKey = getUserKey(userId);
        if (!boundKey) {
          return interaction.editReply({ content: '❌ คุณยังไม่ได้ Redeem Key กด **Redeem Key** ก่อนครับ' });
        }
        const doc = getKey(boundKey);
        if (!doc || new Date(doc.expires) < new Date()) {
          return interaction.editReply({ content: '❌ Key ของคุณหมดอายุแล้ว ติดต่อ Admin ครับ' });
        }
        const cfg = getGuildConfig(interaction.guildId);
        const scriptUrl = cfg.loaderUrl || 'ยังไม่มี Script URL (Admin ยังไม่ตั้งค่า)';
        return interaction.editReply({
          content: `📋 **Script / Loader ของคุณ:**\n\`\`\`${scriptUrl}\`\`\`\n⚠️ ห้าม share ให้คนอื่นนะครับ`
        });
      }

      // 👤 Get Role — ให้ Role Buyer อัตโนมัติ
      if (id === 'buyer_getrole') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const boundKey = getUserKey(userId);
        if (!boundKey) {
          return interaction.editReply({ content: '❌ คุณยังไม่ได้ Redeem Key กด **Redeem Key** ก่อนครับ' });
        }
        const doc = getKey(boundKey);
        if (!doc || new Date(doc.expires) < new Date()) {
          return interaction.editReply({ content: '❌ Key ของคุณหมดอายุแล้ว ติดต่อ Admin ครับ' });
        }
        const cfg = getGuildConfig(interaction.guildId);
        if (!cfg.buyerRoleId) {
          return interaction.editReply({ content: '❌ Admin ยังไม่ได้ตั้ง Buyer Role ID ครับ' });
        }
        try {
          const member = await interaction.guild.members.fetch(userId);
          const role = interaction.guild.roles.cache.get(cfg.buyerRoleId);
          if (!role) return interaction.editReply({ content: '❌ ไม่พบ Role ใน Server ครับ ติดต่อ Admin' });
          if (member.roles.cache.has(cfg.buyerRoleId)) {
            return interaction.editReply({ content: '✅ คุณมี Role นี้อยู่แล้วครับ' });
          }
          await member.roles.add(role);
          await sendWebhookEmbed('👤 Role Assigned', `User: ${interaction.user.tag}\nKey: **${boundKey}**`);
          return interaction.editReply({ content: `✅ ได้รับ Role **${role.name}** แล้วครับ!` });
        } catch (err) {
          console.error('Get Role Error:', err.message);
          return interaction.editReply({ content: '❌ ไม่สามารถให้ Role ได้ ตรวจสอบสิทธิ์บอทครับ' });
        }
      }

      // 🖥️ Reset HWID — ล้าง HWID ของ Key ที่ผูกอยู่
      if (id === 'buyer_resethwid') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const boundKey = getUserKey(userId);
        if (!boundKey) {
          return interaction.editReply({ content: '❌ คุณยังไม่ได้ Redeem Key กด **Redeem Key** ก่อนครับ' });
        }
        const doc = getKey(boundKey);
        if (!doc) {
          return interaction.editReply({ content: '❌ ไม่พบ Key ในระบบ ติดต่อ Admin ครับ' });
        }
        const cfg = getGuildConfig(interaction.guildId);
        const cooldownMs = (cfg.hwidCooldown || 60) * 60000;

        // ตรวจ cooldown ของการ reset
        const resetKey = `reset_${userId}`;
        const resetDB = readDB(path.join(__dirname, 'reset_cooldown.json'));
        if (resetDB[resetKey]) {
          const elapsed = Date.now() - new Date(resetDB[resetKey]).getTime();
          if (elapsed < cooldownMs) {
            const remaining = Math.ceil((cooldownMs - elapsed) / 60000);
            return interaction.editReply({ content: `⏳ Reset HWID ได้อีกครั้งใน **${remaining} นาที** ครับ` });
          }
        }

        doc.hwid = null;
        saveKey(doc);

        // บันทึกเวลา reset
        resetDB[resetKey] = new Date().toISOString();
        writeDB(path.join(__dirname, 'reset_cooldown.json'), resetDB);

        await sendWebhookEmbed('🖥️ HWID Reset', `User: ${interaction.user.tag}\nKey: **${boundKey}**`, '#ffaa00');
        return interaction.editReply({ content: `✅ Reset HWID สำเร็จแล้วครับ!\nรันโปรแกรมแล้วระบบจะผูก HWID ใหม่อัตโนมัติ` });
      }
    }
  }

  // ══════════════════════════════════════════
  //  MODAL SUBMIT
  // ══════════════════════════════════════════
  if (interaction.isModalSubmit()) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const mid = interaction.customId;

    // ── Admin Modals ──────────────────────────────────────────────────────

    if (mid === 'modal_generatekey') {
      const project  = interaction.fields.getTextInputValue('project')  || process.env.PROJECT_NAME;
      const days     = parseInt(interaction.fields.getTextInputValue('days'))     || 7;
      const uses     = parseInt(interaction.fields.getTextInputValue('uses'))     ?? -1;
      const cooldown = parseInt(interaction.fields.getTextInputValue('cooldown')) || 60;
      const rawKey   = crypto.randomBytes(16).toString('hex');
      const key = `YN-${rawKey.slice(0,8).toUpperCase()}-${rawKey.slice(8,16).toUpperCase()}-${rawKey.slice(16,24).toUpperCase()}`;
      saveKey({ key, project, expires: new Date(Date.now() + days * 864e5).toISOString(), usesLeft: uses, cooldown, hwid: null, lastUsed: null, createdBy: interaction.user.tag, createdAt: new Date().toISOString() });
      await sendWebhookEmbed('🔑 New Key Generated', `Key: **${key}**\nProject: ${project} | Expires: ${days}d\nBy: ${interaction.user.tag}`);
      return interaction.editReply({ content: `✅ **Key สร้างแล้ว!**\n\`\`\`${key}\`\`\`Project: ${project} | Expires: ${days}d | Uses: ${uses} | Cooldown: ${cooldown}m` });
    }

    if (mid === 'modal_removekey') {
      const key = interaction.fields.getTextInputValue('key').trim();
      if (!deleteKey(key)) return interaction.editReply({ content: '❌ ไม่พบ Key นี้' });
      await sendWebhookEmbed('🗑️ Key Removed', `Key: **${key}**\nBy: ${interaction.user.tag}`, '#ff0000');
      return interaction.editReply({ content: `✅ ลบ Key \`${key}\` แล้ว` });
    }

    if (mid === 'modal_searchkey') {
      const key = interaction.fields.getTextInputValue('key').trim();
      const doc = getKey(key);
      if (!doc) return interaction.editReply({ content: '❌ ไม่พบ Key นี้' });
      const embed = new EmbedBuilder().setTitle('🔍 Key Information').setColor(0x5865f2)
        .addFields(
          { name: 'Key',       value: `\`${doc.key}\``,                              inline: false },
          { name: 'Project',   value: doc.project,                                   inline: true  },
          { name: 'Expires',   value: new Date(doc.expires).toLocaleString(),        inline: true  },
          { name: 'HWID',      value: doc.hwid || 'ยังไม่ผูก',                        inline: true  },
          { name: 'Uses Left', value: doc.usesLeft === -1 ? '∞' : `${doc.usesLeft}`, inline: true  },
          { name: 'Cooldown',  value: `${doc.cooldown} นาที`,                        inline: true  },
          { name: 'Last Used', value: doc.lastUsed ? new Date(doc.lastUsed).toLocaleString() : 'ไม่เคยใช้', inline: true },
        ).setTimestamp();
      return interaction.editReply({ embeds: [embed] });
    }

    if (mid === 'modal_webhook') {
      const url = interaction.fields.getTextInputValue('url').trim();
      saveGuildConfig(interaction.guildId, { webhookUrl: url });
      process.env.WEBHOOK_URL = url;
      return interaction.editReply({ content: `✅ บันทึก Webhook URL แล้ว` });
    }

    if (mid === 'modal_hwid') {
      const minutes = parseInt(interaction.fields.getTextInputValue('minutes')) || 60;
      saveGuildConfig(interaction.guildId, { hwidCooldown: minutes });
      return interaction.editReply({ content: `✅ ตั้ง HWID Cooldown เป็น **${minutes} นาที** แล้ว` });
    }

    if (mid === 'modal_topup') {
      const key  = interaction.fields.getTextInputValue('key').trim();
      const uses = parseInt(interaction.fields.getTextInputValue('uses')) || 0;
      const doc  = getKey(key);
      if (!doc) return interaction.editReply({ content: '❌ ไม่พบ Key นี้' });
      if (doc.usesLeft === -1) {
        return interaction.editReply({ content: `⚠️ Key \`${key}\` ตั้งไว้เป็น **ไม่จำกัด** อยู่แล้ว ไม่ต้องเติมครับ` });
      }
      doc.usesLeft += uses;
      saveKey(doc);
      await sendWebhookEmbed('💎 Key Top-Up', `Key: **${key}**\nเพิ่ม ${uses} uses\nBy: ${interaction.user.tag}`);
      return interaction.editReply({ content: `✅ เติม \`${key}\` อีก ${uses} uses | ยังเหลือ: **${doc.usesLeft}**` });
    }

    if (mid === 'modal_loader') {
      const url = interaction.fields.getTextInputValue('url').trim();
      saveGuildConfig(interaction.guildId, { loaderUrl: url });
      return interaction.editReply({ content: `✅ บันทึก Loader URL แล้ว` });
    }

    if (mid === 'modal_buyerrole') {
      const roleId = interaction.fields.getTextInputValue('roleid').trim();
      saveGuildConfig(interaction.guildId, { buyerRoleId: roleId });
      return interaction.editReply({ content: `✅ ตั้ง Buyer Role ID เป็น \`${roleId}\` แล้ว` });
    }

    if (mid === 'modal_renew') {
      const key  = interaction.fields.getTextInputValue('key').trim();
      const days = parseInt(interaction.fields.getTextInputValue('days')) || 7;
      const doc  = getKey(key);
      if (!doc) return interaction.editReply({ content: '❌ ไม่พบ Key นี้' });
      doc.expires = new Date(new Date(doc.expires).getTime() + days * 864e5).toISOString();
      saveKey(doc);
      await sendWebhookEmbed('🔄 Key Renewed', `Key: **${key}**\nเพิ่ม ${days} วัน\nBy: ${interaction.user.tag}`);
      return interaction.editReply({ content: `✅ ต่ออายุ \`${key}\` อีก **${days} วัน** | หมดอายุใหม่: ${new Date(doc.expires).toLocaleString()}` });
    }

    // ── Buyer Modal — Redeem Key ──────────────────────────────────────────

    if (mid === 'modal_buyer_redeem') {
      const keyInput = interaction.fields.getTextInputValue('key').trim();
      const userId   = interaction.user.id;

      // ตรวจว่า User นี้ Redeem แล้วหรือยัง
      const existingKey = getUserKey(userId);
      if (existingKey) {
        const existDoc = getKey(existingKey);
        if (existDoc && new Date(existDoc.expires) > new Date()) {
          return interaction.editReply({ content: `❌ คุณมี Key อยู่แล้วครับ: \`${existingKey}\`\nถ้าต้องการเปลี่ยนติดต่อ Admin` });
        }
        // Key เก่าหมดอายุแล้ว ให้ Redeem ใหม่ได้
        removeUserKey(userId);
      }

      const doc = getKey(keyInput);
      if (!doc) return interaction.editReply({ content: '❌ Key ไม่ถูกต้องครับ' });
      if (new Date(doc.expires) < new Date()) return interaction.editReply({ content: '❌ Key นี้หมดอายุแล้วครับ' });
      if (doc.usesLeft === 0) return interaction.editReply({ content: '❌ Key นี้ใช้หมดแล้วครับ' });

      // ตรวจว่า Key นี้ถูก Redeem โดย User อื่นอยู่แล้วหรือยัง
      const users = readDB(DB_USERS);
      const alreadyOwner = Object.entries(users).find(([uid, k]) => k === keyInput && uid !== userId);
      if (alreadyOwner) {
        return interaction.editReply({ content: '❌ Key นี้ถูก Redeem ไปแล้วครับ' });
      }

      // ผูก User กับ Key
      setUserKey(userId, keyInput);

      await sendWebhookEmbed('🔑 Key Redeemed', `User: ${interaction.user.tag}\nKey: **${keyInput}**\nExpires: ${new Date(doc.expires).toLocaleString()}`);

      return interaction.editReply({
        content:
          `✅ **Redeem สำเร็จ!**\n` +
          `Key: \`${keyInput}\`\n` +
          `Project: ${doc.project} | หมดอายุ: ${new Date(doc.expires).toLocaleString()}\n\n` +
          `กด **Get Role** เพื่อรับ Role และ **Get Script** เพื่อดู Script ได้เลยครับ`
      });
    }
  }
});

// ─── REST API ──────────────────────────────────────────────────────────────

app.post('/auth', async (req, res) => {
  const { key, hwid, userid, gameid } = req.body;
  if (!key || !hwid) return res.status(400).json({ success: false, message: 'Missing key or HWID' });

  const doc = getKey(key);
  if (!doc) return res.json({ success: false, message: 'Invalid key' });
  if (new Date(doc.expires) < new Date()) return res.json({ success: false, message: 'Key expired' });
  if (doc.usesLeft === 0) return res.json({ success: false, message: 'No uses left' });

  // ตรวจ HWID
  if (!doc.hwid) {
    doc.hwid = hwid;
  } else if (doc.hwid !== hwid) {
    return res.json({ success: false, message: 'HWID mismatch' });
  }

  // ตรวจ cooldown หลัง HWID ผ่านแล้ว
  if (doc.lastUsed && (Date.now() - new Date(doc.lastUsed).getTime()) < doc.cooldown * 60000) {
    const remaining = Math.ceil((doc.cooldown * 60000 - (Date.now() - new Date(doc.lastUsed).getTime())) / 60000);
    return res.json({ success: false, message: `On cooldown. Wait ${remaining} minutes.` });
  }

  if (doc.usesLeft > 0) doc.usesLeft -= 1;
  doc.lastUsed = new Date().toISOString();
  saveKey(doc);

  await sendWebhookEmbed('✅ Key Used', `Key: **${key}**\nHWID: ${hwid}\nUserID: ${userid}\nGameID: ${gameid}`);
  res.json({ success: true, message: 'Authenticated' });
});

// ─── Start ─────────────────────────────────────────────────────────────────

const PORT = process.env.API_PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));
client.login(process.env.BOT_TOKEN);
