require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const { Resend } = require('resend');

const app = express();
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds]
});

discordClient.login(process.env.DISCORD_BOT_TOKEN);

discordClient.once('clientReady', () => {
  console.log(`Bot do Discord conectado como: ${discordClient.user.tag}`);
});

app.post('/webhook/infinitepay', async (req, res) => {
  try {
    const payload = req.body;
    console.log('Webhook recebido da InfinitePay:', JSON.stringify(payload, null, 2));

    // A InfinitePay enviou os dados com paid_amount e transaction_nsu
    const isPaid = payload.paid_amount > 0 || payload.event === 'transaction.paid' || payload.status === 'paid';

    // Procura o e-mail no payload (ou utiliza o e-mail configurado em fallback)
    const customerEmail = payload.customer?.email || payload.buyer?.email || payload.email || 'gssmvilar@gmail.com';

    if (!isPaid) {
      return res.status(200).send('Evento recebido sem confirmação de pagamento.');
    }

    if (!customerEmail) {
      console.error('Aviso: E-mail não encontrado no payload da InfinitePay.');
      return res.status(400).json({ error: 'E-mail do cliente não encontrado no payload.' });
    }

    // 1. Gera convite único no Discord
    const channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
    const invite = await channel.createInvite({
      maxAge: 7 * 24 * 3600, // 7 dias
      maxUses: 1,            // Apenas 1 uso
      unique: true
    });

    // 2. Envia e-mail via Resend
    await resend.emails.send({
      from: 'onboarding@resend.dev',
      to: customerEmail,
      subject: 'Seu acesso ao Servidor VIP do Discord',
      html: `
        <div style="font-family: sans-serif; padding: 20px; color: #333;">
          <h2>Obrigado pela sua assinatura!</h2>
          <p>O seu pagamento foi confirmado com sucesso.</p>
          <p>Clique no botão abaixo para entrar no nosso servidor exclusivo do Discord:</p>
          <a href="${invite.url}" style="background-color: #5865F2; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold; margin-top: 10px;">Entrar no Discord</a>
        </div>
      `
    });

    console.log(`Convite gerado e e-mail enviado com sucesso para: ${customerEmail}`);
    return res.status(200).json({ success: true, message: 'Convite enviado por e-mail.' });

  } catch (error) {
    console.error('Erro ao processar o webhook:', error);
    return res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});