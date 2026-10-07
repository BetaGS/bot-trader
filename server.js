// resgate.js — link de resgate de uso único + login com Discord + cargo por 365 dias
// Dependências: npm i express better-sqlite3
// Variáveis de ambiente: BASE_URL, CLIENT_ID, CLIENT_SECRET, BOT_TOKEN, GUILD_ID, CARGO_VIP_ID, DB_PATH
const express = require('express');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const {
  BASE_URL, CLIENT_ID, CLIENT_SECRET, BOT_TOKEN, GUILD_ID, CARGO_VIP_ID,
} = process.env;
const DIAS = 365;
const VALIDADE_LINK_MS = 24 * 60 * 60 * 1000; // o link expira em 24h se ninguém usar

// DB_PATH deve apontar para um Volume da Railway (ex.: /data/bot.db), senão some a cada deploy
const db = new Database(process.env.DB_PATH || './bot.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    token TEXT PRIMARY KEY,
    bound_user_id TEXT,
    expira_link INTEGER NOT NULL,
    usado INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS assinaturas (
    user_id TEXT PRIMARY KEY,
    expira_em INTEGER NOT NULL
  );
`);

// Gera o link. Se passar boundUserId, SÓ aquele usuário do Discord consegue resgatar.
function gerarLink(boundUserId = null) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO links (token, bound_user_id, expira_link) VALUES (?, ?, ?)')
    .run(token, boundUserId, Date.now() + VALIDADE_LINK_MS);
  return `${BASE_URL}/resgatar/${token}`;
}

function linkValido(token) {
  const l = db.prepare('SELECT * FROM links WHERE token = ?').get(token);
  if (!l || l.usado || l.expira_link < Date.now()) return null;
  return l;
}

const discord = (path, opts = {}) =>
  fetch(`https://discord.com/api/v10${path}`, {
    ...opts,
    headers: { Authorization: `Bot ${BOT_TOKEN}`, 'Content-Type': 'application/json', ...opts.headers },
  });

const app = express();

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
    // troca o code pelo access_token do usuário
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
    if (!tk.access_token) return res.status(400).send('Falha no login com o Discord.');

    const user = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${tk.access_token}` },
    }).then((r) => r.json());

    // link amarrado a outro usuário? bloqueia (repassar o link não adianta)
    if (link.bound_user_id && link.bound_user_id !== user.id) {
      return res.status(403).send('Este link pertence a outra conta do Discord.');
    }

    // trava o link de forma atômica: só uma pessoa consegue passar daqui
    const r = db.prepare('UPDATE links SET usado = 1 WHERE token = ? AND usado = 0').run(token);
    if (r.changes !== 1) return res.status(410).send('Link já utilizado.');

    // entra no servidor já com o cargo (204 = já era membro)
    const add = await discord(`/guilds/${GUILD_ID}/members/${user.id}`, {
      method: 'PUT',
      body: JSON.stringify({ access_token: tk.access_token, roles: [CARGO_VIP_ID] }),
    });
    if (add.status === 204) {
      await discord(`/guilds/${GUILD_ID}/members/${user.id}/roles/${CARGO_VIP_ID}`, { method: 'PUT' });
    } else if (!add.ok) {
      db.prepare('UPDATE links SET usado = 0 WHERE token = ?').run(token); // libera de novo se falhou
      return res.status(500).send('Não consegui adicionar você ao servidor. Tente novamente.');
    }

    db.prepare('INSERT OR REPLACE INTO assinaturas (user_id, expira_em) VALUES (?, ?)')
      .run(user.id, Date.now() + DIAS * 24 * 60 * 60 * 1000);

    res.send('Pronto! Você já está no servidor com o cargo VIP. Pode fechar esta página.');
  } catch (e) {
    console.error(e);
    res.status(500).send('Erro inesperado.');
  }
});

module.exports = { app, db, gerarLink };

// No seu index.js:
//   const { app, gerarLink } = require('./resgate');
//   app.listen(process.env.PORT || 3000);
//
// Comando /gerarlink (só você), com opção "usuario" (opcional):
//   if (interaction.commandName === 'gerarlink') {
//     if (interaction.user.id !== process.env.OWNER_ID) return interaction.reply({ content: 'Sem permissão.', ephemeral: true });
//     const alvo = interaction.options.getUser('usuario');
//     return interaction.reply({ content: gerarLink(alvo?.id), ephemeral: true });
//   }