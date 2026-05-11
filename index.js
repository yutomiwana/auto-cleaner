const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
} = require('discord.js');
const buffer = require('env-nodejs');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

const PREFIX = ',';
const DATA_FILE = path.join(__dirname, 'nukeData.json');

let nukeData = loadData();
const activeTimers = {};
const nukingChannels = new Set();

// ─── Data Persistence ───────────────────────────────────────────────────────

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return {};

  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('Failed to load nukeData.json:', err);
    return {};
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// nukeData structure:
//
// {
//   [channelId]: {
//     guildId,
//     message,
//     intervalMs,
//     enabled,
//     nextNuke
//   }
// }

// ─── Time Helpers ────────────────────────────────────────────────────────────

function parseTime(str) {
  const match = str.match(
    /^(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)$/i
  );

  if (!match) return null;

  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  if (unit.startsWith('d')) return val * 86_400_000;
  if (unit.startsWith('h')) return val * 3_600_000;
  if (unit.startsWith('m')) return val * 60_000;
  if (unit.startsWith('s')) return val * 1_000;

  return null;
}

function formatMs(ms) {
  if (ms >= 86_400_000) {
    return `${(ms / 86_400_000).toFixed(2).replace(/\.?0+$/, '')}d`;
  }

  if (ms >= 3_600_000) {
    return `${(ms / 3_600_000).toFixed(2).replace(/\.?0+$/, '')}hr`;
  }

  if (ms >= 60_000) {
    return `${(ms / 60_000).toFixed(2).replace(/\.?0+$/, '')}min`;
  }

  return `${(ms / 1_000).toFixed(2).replace(/\.?0+$/, '')}s`;
}

// ─── Permission Check ───────────────────────────────────────────────────────

function requireAdmin(member) {
  return (
    member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.permissions.has(PermissionsBitField.Flags.ManageChannels)
  );
}

// ─── Channel Resolver ───────────────────────────────────────────────────────

function resolveTargetChannel(message, rawArg) {
  return (
    message.mentions.channels.first() ||
    (rawArg ? message.guild.channels.cache.get(rawArg.replace(/\D/g, '')) : null) ||
    message.channel
  );
}

// ─── Fresh Snapshot Logic ───────────────────────────────────────────────────

async function snapshotChannel(channel) {
  const freshChannel = await channel.guild.channels.fetch(channel.id, {
    force: true,
  });

  if (!freshChannel) {
    throw new Error('Channel no longer exists.');
  }

  return {
    name: freshChannel.name,
    type: freshChannel.type,
    topic: freshChannel.topic ?? null,
    nsfw: freshChannel.nsfw ?? false,
    rateLimitPerUser: freshChannel.rateLimitPerUser ?? 0,
    position: freshChannel.position,
    parentId: freshChannel.parentId ?? null,

    permissionOverwrites: freshChannel.permissionOverwrites.cache.map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow.bitfield.toString(),
      deny: overwrite.deny.bitfield.toString(),
    })),
  };
}

async function nukeChannel(channel, firstMessage = null) {
  if (nukingChannels.has(channel.id)) {
    throw new Error('This channel is already being nuked.');
  }

  nukingChannels.add(channel.id);

  try {
    const guild = channel.guild;

    // Fresh instant snapshot before deletion.
    // This cache is local only and disappears after this function ends.
    const cache = await snapshotChannel(channel);

    await channel.delete('Nuke command');

    const newChannel = await guild.channels.create({
      name: cache.name,
      type: cache.type,
      topic: cache.topic || undefined,
      nsfw: cache.nsfw,
      rateLimitPerUser: cache.rateLimitPerUser,
      parent: cache.parentId || undefined,
      permissionOverwrites: cache.permissionOverwrites,
      reason: 'Nuke — recreating channel',
    });

    try {
      await newChannel.setPosition(cache.position);
    } catch (err) {
      console.warn('Failed to restore channel position:', err.message);
    }

    if (firstMessage) {
      await newChannel.send(firstMessage).catch(() => {});
    }

    return newChannel;
  } finally {
    nukingChannels.delete(channel.id);
  }
}

// ─── Nuke Data Migration ────────────────────────────────────────────────────

function moveNukeData(oldChannelId, newChannelId, guildId) {
  const existingEntry = nukeData[oldChannelId];

  if (!existingEntry) return null;

  if (activeTimers[oldChannelId]) {
    clearTimeout(activeTimers[oldChannelId]);
    delete activeTimers[oldChannelId];
  }

  delete nukeData[oldChannelId];

  nukeData[newChannelId] = {
    ...existingEntry,
    guildId,
    nextNuke: Date.now() + existingEntry.intervalMs,
  };

  saveData(nukeData);

  if (nukeData[newChannelId].enabled) {
    scheduleNuke(newChannelId);
  }

  return nukeData[newChannelId];
}

// ─── Timer Scheduling ───────────────────────────────────────────────────────

function scheduleNuke(channelId) {
  if (activeTimers[channelId]) {
    clearTimeout(activeTimers[channelId]);
    delete activeTimers[channelId];
  }

  const entry = nukeData[channelId];

  if (!entry || !entry.enabled) return;

  const delay = entry.nextNuke - Date.now();

  const fire = async () => {
    const currentEntry = nukeData[channelId];

    if (!currentEntry || !currentEntry.enabled) return;

    try {
      const guild = await client.guilds.fetch(currentEntry.guildId);
      const channel = await guild.channels.fetch(channelId).catch(() => null);

      if (!channel) {
        delete nukeData[channelId];
        saveData(nukeData);
        return;
      }

      const newChannel = await nukeChannel(channel, currentEntry.message);

      delete nukeData[channelId];

      nukeData[newChannel.id] = {
        ...currentEntry,
        guildId: guild.id,
        nextNuke: Date.now() + currentEntry.intervalMs,
      };

      saveData(nukeData);
      scheduleNuke(newChannel.id);
    } catch (err) {
      console.error(`Scheduled nuke error for ${channelId}:`, err);

      const failedEntry = nukeData[channelId];

      if (failedEntry) {
        failedEntry.nextNuke = Date.now() + failedEntry.intervalMs;
        saveData(nukeData);
        scheduleNuke(channelId);
      }
    }
  };

  if (delay <= 0) {
    fire();
  } else {
    activeTimers[channelId] = setTimeout(fire, delay);
  }
}

function rescheduleAll() {
  for (const channelId of Object.keys(nukeData)) {
    scheduleNuke(channelId);
  }
}

// ─── Command Handler ────────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  if (!command) return;

  // ── ,set nuke #channel <time> <message...> ──────────────────────────────

  if (command === 'set' && args[0]?.toLowerCase() === 'nuke') {
    if (!requireAdmin(message.member)) {
      return message.reply('❌ You need **Manage Channels** or **Administrator** permission.');
    }

    const channelArg = args[1];
    const timeStr = args[2];
    const firstMsg = args.slice(3).join(' ');

    const targetChannel = resolveTargetChannel(message, channelArg);

    if (!targetChannel) {
      return message.reply('❌ Please mention a valid channel.');
    }

    if (!timeStr) {
      return message.reply('❌ Please provide a time, example: `5hr`, `30min`, `2d`.');
    }

    if (!firstMsg) {
      return message.reply('❌ Please provide a message to send after each nuke.');
    }

    const intervalMs = parseTime(timeStr);

    if (!intervalMs) {
      return message.reply('❌ Invalid time format. Use `5hr`, `30min`, `10s`, `2d`, etc.');
    }

    if (nukeData[targetChannel.id]) {
      return message.reply(
        `❌ A nuke timer already exists for <#${targetChannel.id}>.\n` +
        `Use \`,edit nuke #channel <time> <message>\` to change it.`
      );
    }

    nukeData[targetChannel.id] = {
      guildId: message.guild.id,
      message: firstMsg,
      intervalMs,
      enabled: true,
      nextNuke: Date.now() + intervalMs,
    };

    saveData(nukeData);
    scheduleNuke(targetChannel.id);

    return message.reply(
      `✅ Nuke timer set for <#${targetChannel.id}> every **${formatMs(intervalMs)}**.\n` +
      `First message after nuke: *"${firstMsg}"`
    );
  }

  // ── ,edit nuke #channel <time> <message...> ─────────────────────────────

  if (command === 'edit' && args[0]?.toLowerCase() === 'nuke') {
    if (!requireAdmin(message.member)) {
      return message.reply('❌ You need **Manage Channels** or **Administrator** permission.');
    }

    const channelArg = args[1];
    const timeStr = args[2];
    const firstMsg = args.slice(3).join(' ');

    const targetChannel = resolveTargetChannel(message, channelArg);

    if (!targetChannel) {
      return message.reply('❌ Please mention a valid channel.');
    }

    const entry = nukeData[targetChannel.id];

    if (!entry) {
      return message.reply(`❌ No nuke timer found for <#${targetChannel.id}>. Use \`,set nuke\` first.`);
    }

    const intervalMs = timeStr ? parseTime(timeStr) : entry.intervalMs;

    if (timeStr && !intervalMs) {
      return message.reply('❌ Invalid time format.');
    }

    nukeData[targetChannel.id] = {
      ...entry,
      intervalMs,
      message: firstMsg || entry.message,
      nextNuke: Date.now() + intervalMs,
    };

    saveData(nukeData);
    scheduleNuke(targetChannel.id);

    return message.reply(
      `✅ Nuke timer updated for <#${targetChannel.id}>.\n` +
      `Interval: **${formatMs(intervalMs)}**\n` +
      `Message: *"${nukeData[targetChannel.id].message}"`
    );
  }

  // ── ,delete nuke #channel ───────────────────────────────────────────────

  if (command === 'delete' && args[0]?.toLowerCase() === 'nuke') {
    if (!requireAdmin(message.member)) {
      return message.reply('❌ You need **Manage Channels** or **Administrator** permission.');
    }

    const targetChannel = resolveTargetChannel(message, args[1]);

    if (!targetChannel) {
      return message.reply('❌ Please mention a valid channel.');
    }

    if (!nukeData[targetChannel.id]) {
      return message.reply(`❌ No nuke timer found for <#${targetChannel.id}>.`);
    }

    if (activeTimers[targetChannel.id]) {
      clearTimeout(activeTimers[targetChannel.id]);
      delete activeTimers[targetChannel.id];
    }

    delete nukeData[targetChannel.id];
    saveData(nukeData);

    return message.reply(`🗑️ Nuke timer for <#${targetChannel.id}> has been **deleted**.`);
  }

  // ── ,disable nuke #channel ──────────────────────────────────────────────

  if (command === 'disable' && args[0]?.toLowerCase() === 'nuke') {
    if (!requireAdmin(message.member)) {
      return message.reply('❌ You need **Manage Channels** or **Administrator** permission.');
    }

    const targetChannel = resolveTargetChannel(message, args[1]);

    if (!targetChannel) {
      return message.reply('❌ Please mention a valid channel.');
    }

    const entry = nukeData[targetChannel.id];

    if (!entry) {
      return message.reply(`❌ No nuke timer found for <#${targetChannel.id}>.`);
    }

    if (!entry.enabled) {
      return message.reply(`⚠️ Nuke timer for <#${targetChannel.id}> is already disabled.`);
    }

    entry.enabled = false;
    saveData(nukeData);

    if (activeTimers[targetChannel.id]) {
      clearTimeout(activeTimers[targetChannel.id]);
      delete activeTimers[targetChannel.id];
    }

    return message.reply(`⏸️ Nuke timer for <#${targetChannel.id}> has been **disabled**.`);
  }

  // ── ,enable nuke #channel ───────────────────────────────────────────────

  if (command === 'enable' && args[0]?.toLowerCase() === 'nuke') {
    if (!requireAdmin(message.member)) {
      return message.reply('❌ You need **Manage Channels** or **Administrator** permission.');
    }

    const targetChannel = resolveTargetChannel(message, args[1]);

    if (!targetChannel) {
      return message.reply('❌ Please mention a valid channel.');
    }

    const entry = nukeData[targetChannel.id];

    if (!entry) {
      return message.reply(`❌ No nuke timer found for <#${targetChannel.id}>. Use \`,set nuke\` first.`);
    }

    if (entry.enabled) {
      return message.reply(`⚠️ Nuke timer for <#${targetChannel.id}> is already enabled.`);
    }

    entry.enabled = true;
    entry.nextNuke = Date.now() + entry.intervalMs;

    saveData(nukeData);
    scheduleNuke(targetChannel.id);

    return message.reply(
      `▶️ Nuke timer for <#${targetChannel.id}> has been **enabled**.\n` +
      `Next nuke in **${formatMs(entry.intervalMs)}**.`
    );
  }

  // ── ,nuke status [#channel] or ,nukestatus [#channel] ───────────────────

  if (command === 'nukestatus' || (command === 'nuke' && args[0]?.toLowerCase() === 'status')) {
    const targetChannel = resolveTargetChannel(message, args[1]);
    const entry = nukeData[targetChannel.id];

    if (!entry) {
      return message.reply(`ℹ️ No nuke timer set for <#${targetChannel.id}>.`);
    }

    const timeLeft = entry.nextNuke - Date.now();
    const nextText = timeLeft > 0 ? formatMs(timeLeft) : 'Imminent';

    return message.reply(
      `📋 **Nuke Status for <#${targetChannel.id}>**\n` +
      `• Enabled: **${entry.enabled ? 'Yes ✅' : 'No ❌'}**\n` +
      `• Interval: **${formatMs(entry.intervalMs)}**\n` +
      `• Next nuke in: **${nextText}**\n` +
      `• Post-nuke message: *"${entry.message}"`
    );
  }

  // ── ,nuke [#channel] ────────────────────────────────────────────────────

  if (command === 'nuke') {
    if (!requireAdmin(message.member)) {
      return message.reply('❌ You need **Manage Channels** or **Administrator** permission.');
    }

    const targetChannel = message.mentions.channels.first() || message.channel;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`nuke_confirm_${targetChannel.id}`)
        .setLabel('💣 Confirm Nuke')
        .setStyle(ButtonStyle.Danger),

      new ButtonBuilder()
        .setCustomId(`nuke_cancel_${targetChannel.id}`)
        .setLabel('✖ Cancel')
        .setStyle(ButtonStyle.Secondary)
    );

    return message.reply({
      content:
        `⚠️ **Are you sure you want to nuke <#${targetChannel.id}>?**\n` +
        `This will delete and recreate the channel. Messages will be lost.\n` +
        `Current permissions, category, and channel settings will be freshly copied before deletion.`,
      components: [row],
    });
  }
});

// ─── Button Handler ─────────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const { customId, member, guild } = interaction;

  if (customId.startsWith('nuke_cancel_')) {
    return interaction.update({
      content: '✖ Nuke **cancelled**.',
      components: [],
    });
  }

  if (!customId.startsWith('nuke_confirm_')) return;

  if (!requireAdmin(member)) {
    return interaction.reply({
      content: '❌ You do not have permission to do this.',
      ephemeral: true,
    });
  }

  const channelId = customId.replace('nuke_confirm_', '');

  const channel = await guild.channels.fetch(channelId).catch(() => null);

  if (!channel) {
    return interaction.reply({
      content: '❌ Could not find that channel.',
      ephemeral: true,
    });
  }

  await interaction.update({
    content: `💣 **Nuking <#${channelId}>...**`,
    components: [],
  });

  try {
    const existingEntry = nukeData[channelId] || null;
    const firstMsg = existingEntry?.message || null;

    const newChannel = await nukeChannel(channel, firstMsg);

    if (existingEntry) {
      moveNukeData(channelId, newChannel.id, guild.id);
    }

    if (interaction.channel && interaction.channel.id !== channelId) {
      await interaction.channel.send(
        `✅ <#${newChannel.id}> has been **nuked and recreated** successfully.`
      ).catch(() => {});
    }
  } catch (err) {
    console.error('Manual nuke error:', err);

    await interaction.followUp({
      content: `❌ Nuke failed: ${err.message}`,
      ephemeral: true,
    }).catch(() => {});
  }
});

// ─── Ready ─────────────────────────────────────────────────────────────────

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  rescheduleAll();
});

// ─── Login ─────────────────────────────────────────────────────────────────

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('❌ DISCORD_TOKEN environment variable not set!');
  process.exit(1);
}

client.login(token);
