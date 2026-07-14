'use strict';

// Notificaciones por email (opcional). Se activa si hay SMTP configurado por env:
//   ARCANUM_SMTP_HOST, ARCANUM_SMTP_PORT, ARCANUM_SMTP_USER, ARCANUM_SMTP_PASS,
//   ARCANUM_SMTP_FROM, ARCANUM_NOTIFY_EMAIL (destinatario de los avisos).
// Complementa a los webhooks: los mismos eventos disparan un mail si esta seteado.

const nodemailer = require('nodemailer');

let transport;
let inited = false;

function init() {
  if (inited) return transport;
  inited = true;
  if (!process.env.ARCANUM_SMTP_HOST) return null;
  const port = parseInt(process.env.ARCANUM_SMTP_PORT || '587', 10);
  transport = nodemailer.createTransport({
    host: process.env.ARCANUM_SMTP_HOST,
    port,
    secure: port === 465,
    auth: process.env.ARCANUM_SMTP_USER
      ? { user: process.env.ARCANUM_SMTP_USER, pass: process.env.ARCANUM_SMTP_PASS }
      : undefined,
  });
  return transport;
}

function enabled() {
  return !!(process.env.ARCANUM_SMTP_HOST && process.env.ARCANUM_NOTIFY_EMAIL);
}

const ASUNTOS = {
  comprobante_emitido: 'Comprobante emitido',
  comprobante_rechazado: 'Comprobante rechazado',
  cert_por_vencer: 'Certificado por vencer',
  arca_caido: 'ARCA no responde',
  arca_restablecido: 'ARCA restablecido',
};

async function notify(evento, data) {
  const t = init();
  const to = process.env.ARCANUM_NOTIFY_EMAIL;
  if (!t || !to) return;
  try {
    await t.sendMail({
      from: process.env.ARCANUM_SMTP_FROM || 'arcanum@localhost',
      to,
      subject: `[Arcanum] ${ASUNTOS[evento] || evento}`,
      text: `Evento: ${evento}\n\n${JSON.stringify(data, null, 2)}`,
    });
  } catch (e) {
    console.error('[arcanum][mail]', e.message);
  }
}

// Envio directo a un destinatario (ej. solicitar comprobante a un profesional).
async function send(to, subject, text) {
  const t = init();
  if (!t) throw Object.assign(new Error('SMTP no configurado (defini ARCANUM_SMTP_HOST)'), { httpStatus: 422 });
  if (!to) throw Object.assign(new Error('Falta el destinatario'), { httpStatus: 422 });
  await t.sendMail({ from: process.env.ARCANUM_SMTP_FROM || 'arcanum@localhost', to, subject: `[Arcanum] ${subject}`, text });
  return { enviado: true, to };
}

module.exports = { notify, enabled, send };
