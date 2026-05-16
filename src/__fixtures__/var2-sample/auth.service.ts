import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuthService {
    constructor(private readonly configService: ConfigService) {}

    getJwtSecret(): string {
        return this.configService.get<string>('JWT_SECRET') ?? '';
    }

    getDatabaseUrl(): string {
        return this.configService.getOrThrow<string>('DATABASE_URL');
    }

    getRedisUrl(): string {
        return this.configService.get('REDIS_URL') ?? 'redis://localhost';
    }
}
