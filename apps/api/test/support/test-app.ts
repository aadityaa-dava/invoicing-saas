import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { MailService } from '../../src/mail/mail.service';
import { PrismaService } from '../../src/prisma/prisma.service';

export class FakeMailService {
  verifications: { to: string; token: string }[] = [];
  existing: string[] = [];
  async sendVerificationEmail(to: string, token: string) {
    this.verifications.push({ to, token });
  }
  async sendAccountExistsEmail(to: string) {
    this.existing.push(to);
  }
}

export async function createTestApp() {
  const mail = new FakeMailService();
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(MailService)
    .useValue(mail)
    .compile();
  const app: INestApplication = moduleFixture.createNestApplication();
  configureApp(app);
  await app.init();
  return { app, mail, prisma: app.get(PrismaService) };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;
