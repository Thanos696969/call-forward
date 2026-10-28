import nodemailer from 'nodemailer';
import type { Config } from '../config';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
  close(): void;
}

export function createSmtpMailer(smtp: Config['smtp']): Mailer {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
  });
  return {
    async send(message) {
      await transport.sendMail({ from: smtp.from, ...message });
    },
    close: () => transport.close(),
  };
}

/** Captures messages in memory; used by tests. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }
  close(): void {}
}
