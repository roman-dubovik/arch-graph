/**
 * AuditController extends ProtectedController extends BaseController (multi-level).
 * 4 delegation methods + 1 replaced method.
 */
import { Get, Post, Put, Delete } from '../_decorators';
import { ProtectedController } from '../base/protected.controller';

interface AuditEntity {
    id: string;
    action: string;
}

interface AuditCreateDto {
    action: string;
}

interface AuditUpdateDto {
    action?: string;
}

export class AuditController extends ProtectedController<
    AuditEntity,
    AuditCreateDto,
    AuditUpdateDto
> {
    @Get('/audits')
    async getAll(): Promise<AuditEntity[]> {
        return super.getAll();
    }

    @Get('/audits/:id')
    async getOne(id: string): Promise<AuditEntity> {
        return super.getOne(id);
    }

    @Post('/audits')
    async create(dto: AuditCreateDto): Promise<AuditEntity> {
        return super.create(dto);
    }

    @Put('/audits/:id')
    async update(id: string, dto: AuditUpdateDto): Promise<AuditEntity> {
        return super.update(id, dto);
    }

    @Delete('/audits/:id')
    async delete(_id: string): Promise<void> {
        throw new Error('Audit entries cannot be deleted');
    }
}
