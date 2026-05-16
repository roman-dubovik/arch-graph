import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class StorageService {
    private readonly bucketName: string;

    constructor(private readonly configService: ConfigService) {
        this.bucketName = this.configService.get<string>('S3_BUCKET') ?? 'default-bucket';
    }

    getRegion(): string {
        return this.configService.getOrThrow<string>('AWS_REGION');
    }
}
