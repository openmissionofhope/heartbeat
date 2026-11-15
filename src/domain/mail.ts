import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(m: Mail): Promise<void>;
}

/** Collects mail in memory (tests, development without SMTP). */
export class MemoryMailer implements Mailer {
  sent: Mail[] = [];
  async send(m: Mail): Promise<void> {
    this.sent.push(m);
  }
}

export function createMailer(config: Config): Mailer {
  if (!config.smtp) {
    const mem = new MemoryMailer();
    return {
      async send(m) {
        await mem.send(m);
        if (config.env === 'development') console.log(`[mail] to=${m.to} subject=${m.subject}\n${m.text}`);
      },
    };
  }
  const transport = nodemailer.createTransport(config.smtp.url);
  const from = config.smtp.from;
  return {
    async send(m) {
      await transport.sendMail({ from, to: m.to, subject: m.subject, text: m.text });
    },
  };
}
