import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class MailerService {
    constructor(private readonly configService: ConfigService) {}

    getSmtpHost(): string {
        return this.configService.get<string>('SMTP_HOST') ?? 'localhost';
    }

    getSmtpPort(): number {
        return this.configService.get<number>('SMTP_PORT') ?? 25;
    }

    getSenderEmail(): string {
        return this.configService.getOrThrow<string>('SENDER_EMAIL');
    }
}
