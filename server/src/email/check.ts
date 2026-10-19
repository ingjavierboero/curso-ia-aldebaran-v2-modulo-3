// Prueba el envío por Gmail (SMTP) sin facturar nada: manda un email de prueba.
//   npm run email:check -- vos@ejemplo.com
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT_DIR } from '../config.js';
import { SmtpMailer } from './smtp.js';

const envFile = path.join(ROOT_DIR, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const to = process.argv[2];

try {
  if (!to) throw new Error('Indicá el destinatario: npm run email:check -- vos@ejemplo.com');
  const config = loadConfig();
  if (config.mockMode || !config.gmail) throw new Error('Con MOCK_MODE=true no se usa Gmail. Corré el chequeo sin modo mock.');

  const mailer = new SmtpMailer({ ...config.gmail, redirectTo: config.emailRedirectTo });
  const sent = await mailer.send({
    to,
    subject: 'Aldebaran: prueba de envío',
    text: 'Este es un email de prueba de Aldebaran. Si lo recibiste, el envío por Gmail funciona.',
  });
  console.log(`Email enviado desde ${mailer.from} a ${sent.to} (Message-ID ${sent.messageId}).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
