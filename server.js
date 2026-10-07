require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
const { Resend } = require('resend');

const app = express();
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

// Inicializa o cliente do Discord
const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds]
});

discordClient.login(process.env.DISCORD_BOT_TOKEN);

discordClient.once('ready', () => {
  console.log(`Bot do Discord conectado como: ${discordClient.user.tag}`);
});

// Endpoint Webhook para receber a notificação da InfinitePay
app.post('/webhook/infinitepay', async (req, res) => {
  try {
    const payload = req.body;
    console.log('Webhook recebido da InfinitePay:', JSON.stringify(payload, null, 2));

    // Adapte o campo conforme o payload que a InfinitePay envia (ex: payload.data.status ou payload.event)
    const isPaid = payload.event === 'transaction.paid' || payload.status === 'paid' || payload.data?.status === 'paid';

    if (isPaid) {
      const customerEmail = payload.customer?.email || payload.data?.customer?.email;

      if (!customerEmail) {
        console.error('E-mail do cliente não foi encontrado no payload.');
        return res.status(400).json({ error: 'E-mail do cliente ausente.' });
      }

      // 1. Procura o canal do Discord e cria o convite único
      const channel = await discordClient.channels.fetch(process.env.DISCORD_CHANNEL_ID);
      const invite = await channel.createInvite({
        maxAge: 7 * 24 * 3600, // Convite válido por 7 dias
        maxUses: 1,            // Apenas 1 utilização
        unique: true
      });

      // 2. Envia o e-mail através da API do Resend
      await resend.emails.send({
        from: 'onboarding@resend.dev', // Altere para o seu domínio próprio quando configurado
        to: customerEmail,
        subject: 'Seu acesso ao Servidor VIP do Discord',
        html: `
          <div style="font-family: sans-serif; padding: 20px; color: #333;">
            <h2>Obrigado pela sua assinatura!</h2>
            <p>O seu pagamento foi confirmado com sucesso.</p>
            <p>Clique no botão abaixo para entrar no nosso servidor exclusivo do Discord:</p>
            <a href="${invite.url}" style="background-color: #5865F2; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold; margin-top: 10px;">Entrar no Discord</a>
            <p style="margin-top: 20px; font-size: 12px; color: #777;">Este convite é individual e válido apenas para uma utilização.</p>
          </div>
        `
      });

      console.log(`Convite enviado com sucesso para ${customerEmail}`);
      return res.status(200).json({ success: true, message: 'Convite enviado por e-mail.' });
    }

    return res.status(200).send('Evento recebido sem necessidade de envio.');
  } catch (error) {
    console.error('Erro ao processar o webhook:', error);
    return res.status(500).json({ error: 'Erro interno do servidor.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});