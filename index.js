require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  Events,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} = require('discord.js');

const axios = require('axios');

// ================= CLIENT =================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

// ================= ENV =================
const TOKEN = process.env.TOKEN;
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

if (!TOKEN) {
  console.error("❌ TOKEN missing in .env file");
  process.exit(1);
}

if (!GOOGLE_SCRIPT_URL) {
  console.error("❌ GOOGLE_SCRIPT_URL missing in .env file");
  process.exit(1);
}

// ================= CONFIG =================
const ADMIN_CHANNEL_NAME = "admin-commands";
const REGISTRATION_LOG_CHANNEL = "registration-log";
const REGISTRATION_PUBLIC_CHANNEL = "registration";

const SET_NAMES = ["SET-A", "SET-B", "SET-C", "SET-D"];
const MAX_TEAMS_PER_SET = 25;

const EMOJI_ACCEPTED = "✅";
const EMOJI_REVIEWED = "☑️";
const EMOJI_REJECTED = "❌";

// ================= CACHE =================
let db = {
  registeredTeams: [],
  lockedSets: {},
  registrationStatusMessageId: null,
  registrationPanelMessageId: null
};

// ================= GOOGLE SHEET API =================
async function apiGetAll() {
  try {
    const res = await axios.get(`${GOOGLE_SCRIPT_URL}?action=getAll`);
    return res.data;
  } catch (e) {
    console.log("apiGetAll error:", e.message);
    return { success: false, error: e.message };
  }
}

async function apiPost(payload) {
  try {
    const res = await axios.post(GOOGLE_SCRIPT_URL, payload, {
      headers: { 'Content-Type': 'application/json' }
    });
    return res.data;
  } catch (e) {
    console.log("apiPost error:", e.message);
    return { success: false, error: e.message };
  }
}

async function loadDBFromSheet() {
  const data = await apiGetAll();

  if (!data || !data.success) {
    console.log("⚠️ Failed to load data from Google Sheet");
    return false;
  }

  db.registeredTeams = (data.registrations || []).map(t => ({
    submitterDiscordId: String(t.submitterDiscordId || ""),
    teamName: String(t.teamName || ""),
    leaderId: String(t.leaderId || ""),
    player2: String(t.player2 || ""),
    player3: String(t.player3 || ""),
    player4: String(t.player4 || ""),
    slot: String(t.slot || ""),
    registeredAt: String(t.registeredAt || ""),
    player5: String(t.player5 || ""),
    player6: String(t.player6 || "")
  }));

  db.lockedSets = data.lockedSets || {};
  db.registrationStatusMessageId = data.meta?.registrationStatusMessageId || null;
  db.registrationPanelMessageId = data.meta?.registrationPanelMessageId || null;

  for (const setName of SET_NAMES) {
    if (db.lockedSets[setName] === undefined) {
      db.lockedSets[setName] = false;
    }
  }

  return true;
}

async function addRegistrationToSheet(teamData) {
  return await apiPost({
    action: "addRegistration",
    data: teamData
  });
}

async function removeTeamFromSheet(teamName) {
  return await apiPost({
    action: "removeTeam",
    teamName
  });
}

async function setLockInSheet(setName, locked) {
  return await apiPost({
    action: "setLock",
    setName,
    locked
  });
}

async function setMetaInSheet(key, value) {
  return await apiPost({
    action: "setMeta",
    key,
    value
  });
}

async function clearAllRegistrationsInSheet() {
  return await apiPost({
    action: "clearAllRegistrations"
  });
}

async function updateSubsInSheet(teamName, player5, player6) {
  return await apiPost({
    action: "updateSubs",
    teamName,
    player5,
    player6
  });
}

// ================= HELPERS =================
function normalizeId(id) {
  return String(id || '').trim();
}

function isValidBgmiId(id) {
  return /^\d{11}$/.test(normalizeId(id));
}

function getTeamsInSet(setName) {
  return db.registeredTeams.filter(t => t.slot === setName).length;
}

function getAvailableSet() {
  for (const setName of SET_NAMES) {
    if (db.lockedSets[setName]) continue;
    if (getTeamsInSet(setName) < MAX_TEAMS_PER_SET) return setName;
  }
  return null;
}

function totalTeams() {
  return db.registeredTeams.length;
}

function totalSlotsLeft() {
  return (SET_NAMES.length * MAX_TEAMS_PER_SET) - totalTeams();
}

function registrationsOpen() {
  return getAvailableSet() !== null;
}

function getSlotStatusText() {
  let txt = `📦 **Slot Status:**\n`;
  for (const setName of SET_NAMES) {
    const used = getTeamsInSet(setName);
    const left = MAX_TEAMS_PER_SET - used;
    const lock = db.lockedSets[setName] ? ' 🔒 LOCKED' : '';
    txt += `**${setName}** ➜ ${used}/${MAX_TEAMS_PER_SET} teams | ${left} slots left${lock}\n`;
  }
  txt += `\n🧮 **Total Registered:** ${totalTeams()}/${SET_NAMES.length * MAX_TEAMS_PER_SET}\n`;
  txt += `🟢 **Total Slots Left:** ${totalSlotsLeft()}`;
  return txt;
}

function getAllIdsFromTeam(team) {
  return [
    team.leaderId,
    team.player2,
    team.player3,
    team.player4,
    team.player5,
    team.player6
  ].map(normalizeId).filter(Boolean);
}

function hasInternalDuplicate(ids) {
  const normalized = ids.map(normalizeId).filter(Boolean);
  const s = new Set(normalized);
  return s.size !== normalized.length;
}

function isDuplicateAny(ids, excludeTeamName = null) {
  const existingIds = new Set();

  for (const team of db.registeredTeams) {
    if (excludeTeamName && team.teamName.toLowerCase() === excludeTeamName.toLowerCase()) {
      continue;
    }

    for (const id of getAllIdsFromTeam(team)) {
      existingIds.add(normalizeId(id));
    }
  }

  for (const id of ids.map(normalizeId).filter(Boolean)) {
    if (existingIds.has(id)) return true;
  }

  return false;
}

function isAdmin(member) {
  return member.permissions.has(PermissionFlagsBits.Administrator);
}

function isAdminChannel(interaction) {
  return interaction.channel && interaction.channel.name === ADMIN_CHANNEL_NAME;
}

async function safeReply(interaction, content, ephemeral = true) {
  try {
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply({ content });
    } else if (interaction.replied) {
      await interaction.followUp({ content, ephemeral });
    } else {
      await interaction.reply({ content, ephemeral });
    }
  } catch (e) {
    console.log("Reply error:", e.message);
  }
}

async function safeEditReply(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
    } else {
      await interaction.reply({ content, ephemeral: true });
    }
  } catch (e) {
    console.log("Edit reply error:", e.message);
  }
}

async function sendDM(guild, userId, content) {
  if (!userId) return false;

  try {
    const member = await guild.members.fetch(userId);
    await member.send(content);
    console.log(`📩 DM sent to ${member.user.tag}`);
    return true;
  } catch (e) {
    console.log(`⚠️ DM failed for userId ${userId}: ${e.message}`);
    return false;
  }
}

// ================= UI MESSAGES =================
async function updateRegistrationStatusMessage(guild) {
  try {
    await loadDBFromSheet();

    const regChannel = guild.channels.cache.find(
      ch => ch.type === ChannelType.GuildText && ch.name === REGISTRATION_PUBLIC_CHANNEL
    );
    if (!regChannel) {
      console.log(`⚠️ #${REGISTRATION_PUBLIC_CHANNEL} not found`);
      return;
    }

    const open = registrationsOpen();

    const embed = new EmbedBuilder()
      .setTitle(open ? '🟢 Registrations Open' : '🔴 Registrations Full / Locked')
      .setDescription(
        open
          ? `Fill the registration form below.\n\n${getSlotStatusText()}`
          : `All slots are full or locked by admins.\nPlease wait for an admin update.\n\n${getSlotStatusText()}`
      )
      .setColor(open ? 0x00ff66 : 0xff3333)
      .setFooter({ text: 'LUMA BGMI Registration Status' })
      .setTimestamp();

    if (db.registrationStatusMessageId) {
      try {
        const oldMsg = await regChannel.messages.fetch(db.registrationStatusMessageId);
        await oldMsg.edit({ embeds: [embed] });
        return;
      } catch {
        db.registrationStatusMessageId = null;
        await setMetaInSheet("registrationStatusMessageId", "");
      }
    }

    const recent = await regChannel.messages.fetch({ limit: 30 });
    const old = recent.find(m =>
      m.author.id === client.user.id &&
      m.embeds.length > 0 &&
      (
        m.embeds[0].title?.includes('Registrations Open') ||
        m.embeds[0].title?.includes('Registrations Full')
      )
    );

    if (old) {
      await old.edit({ embeds: [embed] });
      db.registrationStatusMessageId = old.id;
      await setMetaInSheet("registrationStatusMessageId", old.id);
      return;
    }

    const sent = await regChannel.send({ embeds: [embed] });
    db.registrationStatusMessageId = sent.id;
    await setMetaInSheet("registrationStatusMessageId", sent.id);

  } catch (e) {
    console.log("Status update error:", e.message);
  }
}

async function ensureRegistrationPanel(guild) {
  try {
    const regChannel = guild.channels.cache.find(
      ch => ch.type === ChannelType.GuildText && ch.name === REGISTRATION_PUBLIC_CHANNEL
    );
    if (!regChannel) {
      console.log(`⚠️ #${REGISTRATION_PUBLIC_CHANNEL} not found for panel`);
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle('🎮 LUMA BGMI TOURNAMENT REGISTRATION')
      .setDescription(
`📌 Required in form:
• Team Name
• Leader BGMI ID (11 digits)
• Player 2 BGMI ID (11 digits)
• Player 3 BGMI ID (11 digits)
• Player 4 BGMI ID (11 digits)

➕ Optional substitutes:
Use \`/addsubs\` later for Player 5 and Player 6.

⚠️ Only submit once.
⚠️ All required BGMI IDs must be unique.

Tap the button below to register.`
      )
      .setColor(0x5865F2)
      .setFooter({ text: 'LUMA Registration Panel' });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('open_registration_modal')
        .setLabel('Registration Form')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('📄')
    );

    if (db.registrationPanelMessageId) {
      try {
        const oldMsg = await regChannel.messages.fetch(db.registrationPanelMessageId);
        await oldMsg.edit({ embeds: [embed], components: [row] });
        return;
      } catch {
        db.registrationPanelMessageId = null;
        await setMetaInSheet("registrationPanelMessageId", "");
      }
    }

    const recent = await regChannel.messages.fetch({ limit: 30 });
    const old = recent.find(m =>
      m.author.id === client.user.id &&
      m.embeds.length > 0 &&
      m.embeds[0].title?.includes('LUMA BGMI TOURNAMENT REGISTRATION')
    );

    if (old) {
      await old.edit({ embeds: [embed], components: [row] });
      db.registrationPanelMessageId = old.id;
      await setMetaInSheet("registrationPanelMessageId", old.id);
      return;
    }

    const sent = await regChannel.send({ embeds: [embed], components: [row] });
    db.registrationPanelMessageId = sent.id;
    await setMetaInSheet("registrationPanelMessageId", sent.id);

  } catch (e) {
    console.log("Panel create/update error:", e.message);
  }
}

// ================= LOG MESSAGE =================
async function sendRegistrationLog(guild, user, formData, accepted, reason = null, assignedSet = null) {
  try {
    const logChannel = guild.channels.cache.find(
      ch => ch.type === ChannelType.GuildText && ch.name === REGISTRATION_LOG_CHANNEL
    );
    if (!logChannel) {
      console.log(`⚠️ #${REGISTRATION_LOG_CHANNEL} not found`);
      return null;
    }

    const embed = new EmbedBuilder()
      .setTitle(accepted ? '✅ Registration Accepted' : '❌ Registration Rejected')
      .setColor(accepted ? 0x00ff66 : 0xff3333)
      .setDescription(`${user}`)
      .addFields(
        { name: 'Team name', value: formData.teamName },
        { name: 'Leader BGMI ID (11 digits)', value: formData.leaderId },
        { name: 'Player 2 BGMI ID (11 digits)', value: formData.p2 },
        { name: 'Player 3 BGMI ID (11 digits)', value: formData.p3 },
        { name: 'Player 4 BGMI ID (11 digits)', value: formData.p4 }
      )
      .setTimestamp();

    if (accepted && assignedSet) {
      embed.addFields({ name: 'Allocated Set', value: assignedSet });
    }

    if (!accepted && reason) {
      embed.addFields({ name: 'Rejection Reason', value: reason });
    }

    const msg = await logChannel.send({
      content: `${user}`,
      embeds: [embed]
    });

    if (accepted) {
      await msg.react(EMOJI_ACCEPTED);
      await msg.react(EMOJI_REVIEWED);
    } else {
      await msg.react(EMOJI_REJECTED);
    }

    return msg;
  } catch (e) {
    console.log("sendRegistrationLog error:", e.message);
    return null;
  }
}

// ================= REGISTER TEAM =================
async function handleRegistrationSubmit(interaction, formData) {
  try {
    const ids = [formData.leaderId, formData.p2, formData.p3, formData.p4];

    const alreadyByUser = db.registeredTeams.find(t => t.submitterDiscordId === interaction.user.id);
    if (alreadyByUser) {
      await sendRegistrationLog(
        interaction.guild,
        interaction.user,
        formData,
        false,
        `User already registered as team **${alreadyByUser.teamName}** in **${alreadyByUser.slot}**.`
      );

      return safeEditReply(
        interaction,
        `❌ You already registered a team (**${alreadyByUser.teamName}**) in **${alreadyByUser.slot}**.`
      );
    }

    if (!ids.every(isValidBgmiId)) {
      await sendRegistrationLog(
        interaction.guild,
        interaction.user,
        formData,
        false,
        'All required BGMI IDs must be exactly 11 digits.'
      );

      return safeEditReply(
        interaction,
        '❌ All required BGMI IDs must be exactly 11 digits.'
      );
    }

    if (hasInternalDuplicate(ids)) {
      await sendRegistrationLog(
        interaction.guild,
        interaction.user,
        formData,
        false,
        'Same BGMI ID is repeated inside the team.'
      );

      return safeEditReply(
        interaction,
        '❌ Duplicate BGMI ID inside your team. Leader/P2/P3/P4 must all be different.'
      );
    }

    if (isDuplicateAny(ids)) {
      await sendRegistrationLog(
        interaction.guild,
        interaction.user,
        formData,
        false,
        'One or more BGMI IDs are already used in another registered team.'
      );

      return safeEditReply(
        interaction,
        '❌ One or more BGMI IDs are already registered in another team.'
      );
    }

    const availableSet = getAvailableSet();
    if (!availableSet) {
      await sendRegistrationLog(
        interaction.guild,
        interaction.user,
        formData,
        false,
        'All sets are full or locked by admins.'
      );

      await updateRegistrationStatusMessage(interaction.guild);

      return safeEditReply(
        interaction,
        '❌ Registrations are currently full or all sets are locked.'
      );
    }

    const role = interaction.guild.roles.cache.find(r => r.name === availableSet);
    if (!role) {
      await sendRegistrationLog(
        interaction.guild,
        interaction.user,
        formData,
        false,
        `Role ${availableSet} not found in server.`
      );

      return safeEditReply(
        interaction,
        `❌ Role **${availableSet}** not found in server. Contact admin.`
      );
    }

    const teamData = {
      submitterDiscordId: interaction.user.id,
      teamName: formData.teamName,
      leaderId: formData.leaderId,
      player2: formData.p2,
      player3: formData.p3,
      player4: formData.p4,
      slot: availableSet,
      registeredAt: new Date().toISOString(),
      player5: "",
      player6: ""
    };

    const addResult = await addRegistrationToSheet(teamData);
    if (!addResult.success) {
      return safeEditReply(interaction, '❌ Failed to save registration in Google Sheet.');
    }

    await loadDBFromSheet();

    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      await member.roles.add(role);
      console.log(`✅ Role "${availableSet}" given to ${member.user.tag}`);
    } catch (e) {
      console.log(`⚠️ Role add failed: ${e.message}`);
    }

    await sendRegistrationLog(
      interaction.guild,
      interaction.user,
      formData,
      true,
      null,
      availableSet
    );

    await sendDM(
      interaction.guild,
      interaction.user.id,
`✅ **Your team is successfully registered!**

🏷️ **Team Name:** ${formData.teamName}
🎯 **Allocated Slot:** ${availableSet}

📌 Optional substitutes:
Use \`/addsubs\` in **#${ADMIN_CHANNEL_NAME}** (admin can do it) or ask admin to add:
- Player 5
- Player 6

📌 **What's next?**
- You have been given the **${availableSet}** role
- Check your set channel: **#${availableSet}**
- Match schedule: **#match-date-and-time**
- Points table: **#points-table**`
    );

    await updateRegistrationStatusMessage(interaction.guild);

    return safeEditReply(
      interaction,
      `✅ Registration successful!\n🎯 Your team **${formData.teamName}** is allocated to **${availableSet}**.\n📩 Check your DM.`
    );

  } catch (e) {
    console.log("handleRegistrationSubmit error:", e.message);
    return safeEditReply(interaction, '❌ Something went wrong while processing registration.');
  }
}

// ================= COMMANDS =================
const commands = [
  new SlashCommandBuilder()
    .setName('count')
    .setDescription('Show current slot count for all sets'),

  new SlashCommandBuilder()
    .setName('lockset')
    .setDescription('Lock a set to stop new registrations into it')
    .addStringOption(opt =>
      opt.setName('set')
        .setDescription('Which set to lock')
        .setRequired(true)
        .addChoices(...SET_NAMES.map(s => ({ name: s, value: s })))
    ),

  new SlashCommandBuilder()
    .setName('unlockset')
    .setDescription('Unlock a set to allow registrations again')
    .addStringOption(opt =>
      opt.setName('set')
        .setDescription('Which set to unlock')
        .setRequired(true)
        .addChoices(...SET_NAMES.map(s => ({ name: s, value: s })))
    ),

  new SlashCommandBuilder()
    .setName('setstatus')
    .setDescription('Show lock/unlock status of all sets'),

  new SlashCommandBuilder()
    .setName('removeteam')
    .setDescription('Remove a registered team and revoke their role')
    .addStringOption(opt =>
      opt.setName('teamname')
        .setDescription('Exact team name to remove')
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName('listteams')
    .setDescription('List all registered teams in a set')
    .addStringOption(opt =>
      opt.setName('set')
        .setDescription('Which set')
        .setRequired(true)
        .addChoices(...SET_NAMES.map(s => ({ name: s, value: s })))
    ),

  new SlashCommandBuilder()
    .setName('refreshpanel')
    .setDescription('Recreate/update registration panel and status messages'),

  new SlashCommandBuilder()
    .setName('resetall')
    .setDescription('Delete all registrations, reset all slots, unlock all sets'),

  new SlashCommandBuilder()
    .setName('nukechannel')
    .setDescription('Clone current channel and delete old one (full clear)'),

  new SlashCommandBuilder()
    .setName('addsubs')
    .setDescription('Add optional Player 5 / Player 6 to an existing team')
    .addStringOption(opt =>
      opt.setName('teamname')
        .setDescription('Exact team name')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('player5')
        .setDescription('Player 5 BGMI ID (11 digits)')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('player6')
        .setDescription('Player 6 BGMI ID (11 digits)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('removesubs')
    .setDescription('Remove Player 5 and Player 6 from a team')
    .addStringOption(opt =>
      opt.setName('teamname')
        .setDescription('Exact team name')
        .setRequired(true)
    )
];

// ================= READY =================
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  try {
    await loadDBFromSheet();
    console.log('✅ Google Sheet connected');
  } catch (e) {
    console.log('⚠️ Google Sheet initial load failed:', e.message);
  }

  try {
    await client.application.commands.set(commands);
    console.log('✅ Slash commands registered');
  } catch (e) {
    console.log('Command register error:', e.message);
  }

  setTimeout(async () => {
    try {
      for (const guild of client.guilds.cache.values()) {
        await ensureRegistrationPanel(guild);
        await updateRegistrationStatusMessage(guild);
      }
    } catch (e) {
      console.log("Startup setup error:", e.message);
    }
  }, 3000);
});

// ================= INTERACTIONS =================
client.on(Events.InteractionCreate, async interaction => {
  try {
    // ===== BUTTON =====
    if (interaction.isButton()) {
      if (interaction.customId === 'open_registration_modal') {
        const modal = new ModalBuilder()
          .setCustomId('registration_modal_submit')
          .setTitle('LUMA BGMI Registration');

        const teamNameInput = new TextInputBuilder()
          .setCustomId('team_name')
          .setLabel('Team Name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(50);

        const leaderInput = new TextInputBuilder()
          .setCustomId('leader_id')
          .setLabel('Leader BGMI ID (11 digits)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(11)
          .setMaxLength(11);

        const p2Input = new TextInputBuilder()
          .setCustomId('p2_id')
          .setLabel('Player 2 BGMI ID (11 digits)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(11)
          .setMaxLength(11);

        const p3Input = new TextInputBuilder()
          .setCustomId('p3_id')
          .setLabel('Player 3 BGMI ID (11 digits)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(11)
          .setMaxLength(11);

        const p4Input = new TextInputBuilder()
          .setCustomId('p4_id')
          .setLabel('Player 4 BGMI ID (11 digits)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMinLength(11)
          .setMaxLength(11);

        modal.addComponents(
          new ActionRowBuilder().addComponents(teamNameInput),
          new ActionRowBuilder().addComponents(leaderInput),
          new ActionRowBuilder().addComponents(p2Input),
          new ActionRowBuilder().addComponents(p3Input),
          new ActionRowBuilder().addComponents(p4Input)
        );

        return await interaction.showModal(modal);
      }
    }

    // ===== MODAL SUBMIT =====
    if (interaction.isModalSubmit()) {
      if (interaction.customId === 'registration_modal_submit') {
        await interaction.deferReply({ ephemeral: true });

        const loaded = await loadDBFromSheet();
        if (!loaded) {
          return safeEditReply(interaction, '❌ Failed to connect to Google Sheet.');
        }

        if (!registrationsOpen()) {
          return safeEditReply(
            interaction,
            '❌ Registrations are currently full or locked by admins.'
          );
        }

        const formData = {
          teamName: interaction.fields.getTextInputValue('team_name').trim(),
          leaderId: interaction.fields.getTextInputValue('leader_id').trim(),
          p2: interaction.fields.getTextInputValue('p2_id').trim(),
          p3: interaction.fields.getTextInputValue('p3_id').trim(),
          p4: interaction.fields.getTextInputValue('p4_id').trim()
        };

        return await handleRegistrationSubmit(interaction, formData);
      }
    }

    // ===== SLASH COMMANDS =====
   if (!interaction.isChatInputCommand()) return;

await interaction.deferReply({ ephemeral: true });

// Public command allowed only in #registration
if (interaction.commandName === 'addsubs') {
  if (!interaction.channel || interaction.channel.name !== REGISTRATION_PUBLIC_CHANNEL) {
    return safeReply(interaction, `❌ Please use /addsubs only in #${REGISTRATION_PUBLIC_CHANNEL}`);
  }
} else {
  // All other commands = admin only + admin channel only
  if (!isAdmin(interaction.member)) {
    return safeReply(interaction, '❌ Only admins can use this command.');
  }

  if (!isAdminChannel(interaction)) {
    return safeReply(interaction, `❌ Please use commands only in #${ADMIN_CHANNEL_NAME}`);
  }
}

    const loaded = await loadDBFromSheet();
    if (!loaded) {
      return safeReply(interaction, '❌ Failed to connect to Google Sheet.');
    }

    if (interaction.commandName === 'count') {
      return safeReply(interaction, getSlotStatusText());
    }

    if (interaction.commandName === 'lockset') {
      const setName = interaction.options.getString('set');
      const result = await setLockInSheet(setName, true);
      if (!result.success) return safeReply(interaction, '❌ Failed to lock set.');

      await loadDBFromSheet();
      await updateRegistrationStatusMessage(interaction.guild);
      return safeReply(interaction, `🔒 **${setName}** has been locked.\n\n${getSlotStatusText()}`);
    }

    if (interaction.commandName === 'unlockset') {
      const setName = interaction.options.getString('set');
      const result = await setLockInSheet(setName, false);
      if (!result.success) return safeReply(interaction, '❌ Failed to unlock set.');

      await loadDBFromSheet();
      await updateRegistrationStatusMessage(interaction.guild);
      return safeReply(interaction, `🔓 **${setName}** has been unlocked.\n\n${getSlotStatusText()}`);
    }

    if (interaction.commandName === 'setstatus') {
      let msg = `📋 **Set Status**\n\n`;
      for (const s of SET_NAMES) {
        msg += `**${s}** ➜ ${db.lockedSets[s] ? '🔒 LOCKED' : '🟢 OPEN'}\n`;
      }
      msg += `\n${getSlotStatusText()}`;
      return safeReply(interaction, msg);
    }

    if (interaction.commandName === 'removeteam') {
      const teamName = interaction.options.getString('teamname');

const team = db.registeredTeams.find(
  t => t.teamName.toLowerCase() === teamName.toLowerCase()
);

if (!team) {
  return safeReply(interaction, `❌ Team **${teamName}** not found.`);
}

const isTeamOwner = team.submitterDiscordId === interaction.user.id;
const adminUser = isAdmin(interaction.member);

if (!isTeamOwner && !adminUser) {
  return safeReply(interaction, '❌ You can only add substitutes for your own team.');
}
      const result = await removeTeamFromSheet(teamName);
      if (!result.success) {
        return safeReply(interaction, `❌ Failed to remove **${teamName}** from Google Sheet.`);
      }

      if (team.submitterDiscordId) {
        try {
          const member = await interaction.guild.members.fetch(team.submitterDiscordId);
          const role = interaction.guild.roles.cache.find(r => r.name === team.slot);
          if (role) {
            await member.roles.remove(role);
          }
        } catch (e) {
          console.log(`Role remove error: ${e.message}`);
        }
      }

      await loadDBFromSheet();
      await updateRegistrationStatusMessage(interaction.guild);

      return safeReply(
        interaction,
        `✅ Team **${team.teamName}** removed from **${team.slot}**.\n\n${getSlotStatusText()}`
      );
    }

    if (interaction.commandName === 'listteams') {
      const setName = interaction.options.getString('set');
      const teams = db.registeredTeams.filter(t => t.slot === setName);

      if (teams.length === 0) {
        return safeReply(interaction, `📋 No teams registered in **${setName}** yet.`);
      }

      let msg = `📋 **Teams in ${setName}** (${teams.length}/${MAX_TEAMS_PER_SET})\n\n`;

      teams.forEach((t, i) => {
        msg += `**${i + 1}.** ${t.teamName}\n`;
        msg += `Leader: \`${t.leaderId}\`\n`;
        msg += `P2: \`${t.player2}\` | P3: \`${t.player3}\` | P4: \`${t.player4}\`\n`;
        msg += `P5: \`${t.player5 || '—'}\` | P6: \`${t.player6 || '—'}\`\n\n`;
      });

      if (msg.length > 1900) {
        msg = msg.substring(0, 1900) + '\n... (truncated)';
      }

      return safeReply(interaction, msg);
    }

    if (interaction.commandName === 'refreshpanel') {
      await setMetaInSheet("registrationPanelMessageId", "");
      await setMetaInSheet("registrationStatusMessageId", "");

      await loadDBFromSheet();
      db.registrationPanelMessageId = null;
      db.registrationStatusMessageId = null;

      await ensureRegistrationPanel(interaction.guild);
      await updateRegistrationStatusMessage(interaction.guild);

      return safeReply(interaction, '✅ Registration panel and status embed refreshed.');
    }

    if (interaction.commandName === 'resetall') {
      for (const team of db.registeredTeams) {
        if (!team.submitterDiscordId) continue;

        try {
          const member = await interaction.guild.members.fetch(team.submitterDiscordId);
          const role = interaction.guild.roles.cache.find(r => r.name === team.slot);
          if (role) {
            await member.roles.remove(role);
          }
        } catch (e) {
          console.log(`Reset role remove error: ${e.message}`);
        }
      }

      const clearResult = await clearAllRegistrationsInSheet();
      if (!clearResult.success) {
        return safeReply(interaction, '❌ Failed to clear registrations from Google Sheet.');
      }

      for (const setName of SET_NAMES) {
        await setLockInSheet(setName, false);
      }

      await setMetaInSheet("registrationPanelMessageId", "");
      await setMetaInSheet("registrationStatusMessageId", "");

      await loadDBFromSheet();
      db.registrationPanelMessageId = null;
      db.registrationStatusMessageId = null;

      await ensureRegistrationPanel(interaction.guild);
      await updateRegistrationStatusMessage(interaction.guild);

      return safeReply(interaction, '✅ All player data cleared, all sets unlocked, roles removed, and panel reset.');
    }

    if (interaction.commandName === 'nukechannel') {
      const oldChannel = interaction.channel;

      await safeReply(interaction, `💣 Nuking channel **#${oldChannel.name}**...`, true);

      const newChannel = await oldChannel.clone({
        name: oldChannel.name,
        reason: `Nuked by ${interaction.user.tag}`
      });

      await newChannel.setPosition(oldChannel.position);

      const nukedRegistration = oldChannel.name === REGISTRATION_PUBLIC_CHANNEL;
      const nukedLog = oldChannel.name === REGISTRATION_LOG_CHANNEL;

      await oldChannel.delete(`Nuked by ${interaction.user.tag}`);

      if (nukedRegistration || nukedLog) {
        if (nukedRegistration) {
          await setMetaInSheet("registrationPanelMessageId", "");
          await setMetaInSheet("registrationStatusMessageId", "");
        }

        await loadDBFromSheet();
        db.registrationPanelMessageId = null;
        db.registrationStatusMessageId = null;

        if (nukedRegistration) {
          await ensureRegistrationPanel(interaction.guild);
          await updateRegistrationStatusMessage(interaction.guild);
        }
      }

      return;
    }

    if (interaction.commandName === 'addsubs') {
      const teamName = interaction.options.getString('teamname');
      const player5 = (interaction.options.getString('player5') || '').trim();
      const player6 = (interaction.options.getString('player6') || '').trim();

      const team = db.registeredTeams.find(
        t => t.teamName.toLowerCase() === teamName.toLowerCase()
      );

      if (!team) {
        return safeReply(interaction, `❌ Team **${teamName}** not found.`);
      }

      if (!player5 && !player6) {
        return safeReply(interaction, '❌ Enter at least one of Player 5 or Player 6.');
      }

      if (player5 && !isValidBgmiId(player5)) {
        return safeReply(interaction, '❌ Player 5 BGMI ID must be exactly 11 digits.');
      }

      if (player6 && !isValidBgmiId(player6)) {
        return safeReply(interaction, '❌ Player 6 BGMI ID must be exactly 11 digits.');
      }

      const newIds = [
        team.leaderId,
        team.player2,
        team.player3,
        team.player4,
        player5 || team.player5,
        player6 || team.player6
      ].filter(Boolean);

      if (hasInternalDuplicate(newIds)) {
        return safeReply(interaction, '❌ Duplicate BGMI ID inside the team after adding substitutes.');
      }

      const onlyNewSubs = [];
      if (player5) onlyNewSubs.push(player5);
      if (player6) onlyNewSubs.push(player6);

      if (isDuplicateAny(onlyNewSubs, team.teamName)) {
        return safeReply(interaction, '❌ Player 5 or Player 6 BGMI ID is already used in another team.');
      }

      const result = await updateSubsInSheet(team.teamName, player5 || team.player5, player6 || team.player6);
      if (!result.success) {
        return safeReply(interaction, '❌ Failed to update substitutes in Google Sheet.');
      }

      await loadDBFromSheet();

      return safeReply(
        interaction,
        `✅ Substitutes updated for **${team.teamName}**\nP5: \`${player5 || team.player5 || '—'}\`\nP6: \`${player6 || team.player6 || '—'}\``
      );
    }

    if (interaction.commandName === 'removesubs') {
      const teamName = interaction.options.getString('teamname');

      const team = db.registeredTeams.find(
        t => t.teamName.toLowerCase() === teamName.toLowerCase()
      );

      if (!team) {
        return safeReply(interaction, `❌ Team **${teamName}** not found.`);
      }

      const result = await updateSubsInSheet(team.teamName, "", "");
      if (!result.success) {
        return safeReply(interaction, '❌ Failed to remove substitutes in Google Sheet.');
      }

      await loadDBFromSheet();

      return safeReply(interaction, `✅ Player 5 and Player 6 removed from **${team.teamName}**.`);
    }

  } catch (e) {
    console.log("Interaction handler error:", e.message);

    try {
      if (interaction.isRepliable()) {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: '❌ Unexpected error occurred.' }).catch(() => {});
        } else {
          await interaction.reply({ content: '❌ Unexpected error occurred.', ephemeral: true }).catch(() => {});
        }
      }
    } catch {}

    return;
  }
});

// ================= ERROR SAFETY =================
client.on('error', (err) => {
  console.error('Client error:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

// ================= LOGIN =================
client.login(TOKEN).catch(err => {
  console.error('Login error:', err);
});