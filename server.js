// resgate.js — link de resgate de uso único + login com Discord + cargo por 365 dias
// Dependências: npm i express better-sqlite3 discord.js
// Variáveis: BASE_URL, CLIENT_ID, CLIENT_SECRET, BOT_TOKEN, GUILD_ID, CARGO_VIP_ID, OWNER_ID, DB_PATH
const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const {
  Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder, MessageFlags,
} = require('discord.js');

// Remove espaços/quebras de linha sobrando nas variáveis (erro comum ao colar na Railway)
for (const nome of ['BASE_URL', 'CLIENT_ID', 'CLIENT_SECRET', 'BOT_TOKEN', 'GUILD_ID', 'CARGO_VIP_ID', 'OWNER_ID', 'DB_PATH']) {
  if (process.env[nome]) process.env[nome] = process.env[nome].trim();
}

const {
  CLIENT_ID, CLIENT_SECRET, BOT_TOKEN, GUILD_ID, CARGO_VIP_ID, OWNER_ID,
} = process.env;
const BASE_URL = (process.env.BASE_URL || '').replace(/\/+$/, ''); // sem barra no final
const DIAS = 365;
const DIA_MS = 24 * 60 * 60 * 1000;
const VALIDADE_LINK_MS = DIA_MS; // o link expira em 24h se ninguém usar

// Avisa nos logs se faltar alguma variável (causa comum de bot offline)
for (const nome of ['BASE_URL', 'CLIENT_ID', 'CLIENT_SECRET', 'BOT_TOKEN', 'GUILD_ID', 'CARGO_VIP_ID', 'OWNER_ID']) {
  if (!process.env[nome]) console.error(`[resgate] Variável ausente: ${nome}`);
}

// DB_PATH deve apontar para o Volume da Railway (ex.: /data/bot.db)
// Tabelas com prefixo "resgate_" para não conflitar com as do fluxo da InfinitePay
const db = new Database(process.env.DB_PATH || './bot.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS resgate_links (
    token TEXT PRIMARY KEY,
    bound_user_id TEXT,
    expira_link INTEGER NOT NULL,
    usado INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS resgate_assinaturas (
    user_id TEXT PRIMARY KEY,
    expira_em INTEGER NOT NULL
  );
`);

// Gera o link. Se passar boundUserId, SÓ aquele usuário do Discord consegue resgatar.
function gerarLink(boundUserId = null) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO resgate_links (token, bound_user_id, expira_link) VALUES (?, ?, ?)')
    .run(token, boundUserId, Date.now() + VALIDADE_LINK_MS);
  return `${BASE_URL}/resgatar/${token}`;
}

function linkValido(token) {
  const l = db.prepare('SELECT * FROM resgate_links WHERE token = ?').get(token);
  if (!l || l.usado || l.expira_link < Date.now()) return null;
  return l;
}

const discord = (path, opts = {}) =>
  fetch(`https://discord.com/api/v10${path}`, {
    ...opts,
    headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json', ...opts.headers },
  });

// Remove o cargo de quem passou do vencimento
async function removerVencidos() {
  const vencidos = db.prepare('SELECT user_id FROM resgate_assinaturas WHERE expira_em <= ?').all(Date.now());
  for (const { user_id } of vencidos) {
    try {
      const r = await discord(`/guilds/${GUILD_ID}/members/${user_id}/roles/${CARGO_VIP_ID}`, { method: 'DELETE' });
      // 404 = a pessoa já saiu do servidor; também encerra o registro
      if (r.ok || r.status === 404) {
        db.prepare('DELETE FROM resgate_assinaturas WHERE user_id = ?').run(user_id);
        console.log(`[resgate] Cargo removido (vencido): ${user_id}`);
      } else {
        console.error(`[resgate] Falha ao remover cargo de ${user_id}: HTTP ${r.status}`);
      }
    } catch (e) {
      console.error('[resgate] Erro ao remover vencido:', e.message);
    }
  }
}

// ---------- Rotas web ----------
function registrarRotas(app) {
  app.get('/', (req, res) => res.send('ok'));

  // 1) Usuário abre o link -> manda para o login do Discord
  app.get('/resgatar/:token', (req, res) => {
    if (!linkValido(req.params.token)) return res.status(410).send('Link inválido, expirado ou já utilizado.');
    const url = new URL('https://discord.com/api/oauth2/authorize');
    url.search = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: `${BASE_URL}/callback`,
      response_type: 'code',
      scope: 'identify guilds.join',
      state: req.params.token,
    });
    res.redirect(url.toString());
  });

  // 2) Discord devolve o usuário logado -> valida, trava o link e dá o cargo
  app.get('/callback', async (req, res) => {
    const { code, state: token } = req.query;
    const link = linkValido(token);
    if (!code || !link) return res.status(410).send('Link inválido, expirado ou já utilizado.');

    try {
      const tk = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: `${BASE_URL}/callback`,
        }),
      }).then((r) => r.json());
      if (!tk.access_token) {
        console.error('[resgate] Falha ao trocar o code:', tk);
        return res.status(400).send('Falha no login com o Discord.');
      }

      const user = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bearer ${tk.access_token}` },
      }).then((r) => r.json());

      // link amarrado a outro usuário? bloqueia (repassar o link não adianta)
      if (link.bound_user_id && link.bound_user_id !== user.id) {
        return res.status(403).send('Este link pertence a outra conta do Discord.');
      }

      // trava o link de forma atômica: só uma pessoa consegue passar daqui
      const r = db.prepare('UPDATE resgate_links SET usado = 1 WHERE token = ? AND usado = 0').run(token);
      if (r.changes !== 1) return res.status(410).send('Link já utilizado.');

      // entra no servidor já com o cargo (204 = já era membro)
      const add = await discord(`/guilds/${GUILD_ID}/members/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify({ access_token: tk.access_token, roles: [CARGO_VIP_ID] }),
      });
      if (add.status === 204) {
        const role = await discord(`/guilds/${GUILD_ID}/members/${user.id}/roles/${CARGO_VIP_ID}`, { method: 'PUT' });
        if (!role.ok) {
          console.error('[resgate] Falha ao dar cargo:', role.status, await role.text());
          db.prepare('UPDATE resgate_links SET usado = 0 WHERE token = ?').run(token);
          return res.status(500).send('Não consegui dar o cargo. Tente novamente.');
        }
      } else if (!add.ok) {
        console.error('[resgate] Falha ao adicionar ao servidor:', add.status, await add.text());
        db.prepare('UPDATE resgate_links SET usado = 0 WHERE token = ?').run(token); // libera de novo
        return res.status(500).send('Não consegui adicionar você ao servidor. Tente novamente.');
      }

      db.prepare('INSERT OR REPLACE INTO resgate_assinaturas (user_id, expira_em) VALUES (?, ?)')
        .run(user.id, Date.now() + DIAS * DIA_MS);
      console.log(`[resgate] Cargo concedido: ${user.id}`);

      res.send('Pronto! Você já está no servidor com o cargo VIP. Pode fechar esta página.');
    } catch (e) {
      console.error('[resgate] Erro no callback:', e);
      res.status(500).send('Erro inesperado.');
    }
  });
}

// ---------- Consulta de dias restantes ----------
const diasRestantes = (expiraEm) => Math.ceil((expiraEm - Date.now()) / DIA_MS);

// /dias            -> mostra os dias restantes de quem usou o comando
// /dias usuario:@x -> só o dono pode consultar outra pessoa
async function responderDias(interaction) {
  const alvo = interaction.options.getUser('usuario');
  if (alvo && interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: 'Só o dono pode consultar outro usuário.', flags: MessageFlags.Ephemeral });
  }
  const user = alvo || interaction.user;
  const a = db.prepare('SELECT expira_em FROM resgate_assinaturas WHERE user_id = ?').get(user.id);
  if (!a) {
    return interaction.reply({ content: `${user} não tem assinatura ativa.`, flags: MessageFlags.Ephemeral });
  }
  const ts = Math.floor(a.expira_em / 1000);
  return interaction.reply({
    content: `${user}: faltam **${diasRestantes(a.expira_em)} dia(s)**. Vence em <t:${ts}:D> (<t:${ts}:R>).`,
    flags: MessageFlags.Ephemeral,
  });
}

// /assinaturas -> lista (só o dono) quem vence primeiro
async function responderLista(interaction) {
  if (interaction.user.id !== OWNER_ID) {
    return interaction.reply({ content: 'Sem permissão.', flags: MessageFlags.Ephemeral });
  }
  const total = db.prepare('SELECT COUNT(*) AS n FROM resgate_assinaturas').get().n;
  if (!total) return interaction.reply({ content: 'Nenhuma assinatura ativa.', flags: MessageFlags.Ephemeral });
  const linhas = db.prepare('SELECT user_id, expira_em FROM resgate_assinaturas ORDER BY expira_em ASC LIMIT 25').all();
  const texto = linhas
    .map((l) => `<@${l.user_id}> — ${diasRestantes(l.expira_em)} dia(s) (vence <t:${Math.floor(l.expira_em / 1000)}:d>)`)
    .join('\n');
  return interaction.reply({
    content: `**Assinaturas ativas: ${total}** (as 25 que vencem primeiro)\n${texto}`.slice(0, 1900),
    flags: MessageFlags.Ephemeral,
  });
}

// ---------- Bot: comandos + checagem de vencimentos ----------
function registrarBot(client) {
  const aoFicarOnline = async () => {
    console.log(`[resgate] Bot online como ${client.user.tag}`);
    try {
      const comandos = [
        new SlashCommandBuilder()
          .setName('gerarlink')
          .setDescription('Gera um link único de resgate do cargo VIP')
          .addUserOption((o) => o.setName('usuario').setDescription('Amarra o link a este usuário (opcional)')),
        new SlashCommandBuilder()
          .setName('dias')
          .setDescription('Mostra quantos dias faltam da assinatura')
          .addUserOption((o) => o.setName('usuario').setDescription('Consultar outro usuário (só o dono)')),
        new SlashCommandBuilder()
          .setName('assinaturas')
          .setDescription('Lista as assinaturas ativas e os dias restantes (só o dono)'),
      ];
      // POST cria/atualiza só estes comandos, sem apagar os outros do bot
      const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
      for (const c of comandos) {
        await rest.post(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: c.toJSON() });
      }
      console.log('[resgate] Comandos registrados: /gerarlink, /dias, /assinaturas');
    } catch (e) {
      console.error('[resgate] Erro ao registrar comando:', e.message);
    }
    removerVencidos();
    setInterval(removerVencidos, 60 * 60 * 1000); // a cada hora
  };
  if (client.isReady()) aoFicarOnline();
  else client.once(Events.ClientReady, aoFicarOnline);

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'dias') return responderDias(interaction);
    if (interaction.commandName === 'assinaturas') return responderLista(interaction);
    if (interaction.commandName !== 'gerarlink') return;
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ content: 'Sem permissão.', flags: MessageFlags.Ephemeral });
    }
    const alvo = interaction.options.getUser('usuario');
    const link = gerarLink(alvo?.id);
    const aviso = alvo ? `Amarrado a ${alvo}.` : 'Sem usuário definido: vale para quem abrir primeiro.';
    return interaction.reply({
      content: `${link}\n${aviso} Expira em 24h se não for usado.`,
      flags: MessageFlags.Ephemeral,
    });
  });
}

// ---------- Modo independente: node resgate.js ----------
function iniciar() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  client.on('error', (e) => console.error('[resgate] Erro do client:', e));
  registrarBot(client);
  client.login(BOT_TOKEN).catch((e) => console.error('[resgate] Falha no login:', e.message));

  process.on('unhandledRejection', (e) => console.error('[resgate] unhandledRejection:', e));
  process.on('uncaughtException', (e) => console.error('[resgate] uncaughtException:', e));

  const app = express();
  app.use((req, res, next) => { console.log(`[resgate] ${req.method} ${req.path.slice(0, 20)}`); next(); });
  registrarRotas(app);
  const porta = process.env.PORT || 3000;
  app.listen(porta, '0.0.0.0', () => console.log(`[resgate] Servidor web rodando na porta ${porta}`));
}

module.exports = { registrarRotas, registrarBot, gerarLink, removerVencidos, iniciar };

if (require.main === module) iniciar();

// COMO USAR
// A) Rodar sozinho (cria o próprio bot e servidor web):  node resgate.js
// B) Acoplar ao seu server.js, que já tem `client` e `app`:
//      const resgate = require('./resgate');
//      resgate.registrarRotas(app);
//      resgate.registrarBot(client);