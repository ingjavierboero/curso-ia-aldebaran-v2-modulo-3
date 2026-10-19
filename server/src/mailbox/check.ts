// Prueba la lectura de la casilla de Gmail (IMAP) sin registrar nada: lista los emails
// recibidos en los últimos días con sus adjuntos.   npm run mailbox:check -- 3   (días)
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, ROOT_DIR } from '../config.js';
import { isValidAttachment } from './attachments.js';
import { ImapMailbox } from './imap.js';

const envFile = path.join(ROOT_DIR, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const days = Number(process.argv[2] ?? 3);

try {
  const config = loadConfig();
  if (config.mockMode || !config.gmail) throw new Error('Con MOCK_MODE=true no se usa Gmail. Corré el chequeo sin modo mock.');
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const emails = await new ImapMailbox(config.gmail).fetchSince(since);
  console.log(`Casilla ${config.gmail.user}: ${emails.length} emails en los últimos ${days} días.`);
  for (const email of emails) {
    const own = email.from.toLowerCase() === config.gmail.user.toLowerCase() ? ' (propio, se ignora)' : '';
    console.log(`- ${email.date.toLocaleString('es-AR')} | ${email.from}${own} | ${email.subject}`);
    for (const a of email.attachments) {
      console.log(`    ${isValidAttachment(a) ? '✓' : '✗'} ${a.filename} (${a.contentType}${a.inline ? ', embebida' : ''})`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
